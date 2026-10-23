'use strict';
const crypto=require('node:crypto');
const {createRepository,safeId}=require('./repository');
const {createSettings,normalizeServerUrl}=require('./settings');
const {createCredentials}=require('./credentials');
const {canonicalJson}=require('./revisions');
const {reportingError,requireInput}=require('./errors');
/** @typedef {{schemaVersion:number,exportVersion:number,batchId:string,attemptId:string,state:string,serverUrl:string,autoUpload:boolean,configured:boolean,credentialGeneration:string|null,requestDigest:string}} RunReportingSnapshot */
/** @typedef {{intentId:string,identityEpoch:string,serverUrl:string,scope:string,trigger:string,exportVersion:number}} ReportingIntent */
function digest(value){return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');}
function createIntents(options={}) {
 const repository=options.repository||createRepository(options);
 const settings=options.settings||createSettings({repository});
 const credentials=options.credentials||createCredentials({repository});
 function validateSnapshot(value,{batchId,attemptId,state}) {
  try {
   requireInput(value && typeof value==='object' && !Array.isArray(value));
   requireInput(value.schemaVersion===1 && value.exportVersion===1 && value.identityEpoch===null);
   safeId(value.batchId);safeId(value.attemptId);
   requireInput(value.batchId===batchId && (attemptId===undefined || value.attemptId===attemptId) && value.state===state);
   requireInput(typeof value.serverUrl==='string' && normalizeServerUrl(value.serverUrl)===value.serverUrl);
   requireInput(['autoUpload','configured','noticeAcknowledged'].every(key=>typeof value[key]==='boolean'));
   const generation=value.credentialGeneration;
   requireInput(generation===null || (typeof generation==='string' && /^[a-f0-9]{64}$/.test(generation)));
   requireInput(value.configured===(generation!==null));
   requireInput(typeof value.requestDigest==='string' && /^[a-f0-9]{64}$/.test(value.requestDigest));
  } catch {
   throw reportingError('REPORTING_STATE_CORRUPT','Invalid persisted reporting snapshot');
  }
  return value;
 }
 function readRunSnapshot(workspace,batchId) {
  const value=repository.readWorkspace(workspace,`runs/${safeId(batchId)}.json`);
  return value ? validateSnapshot(value,{batchId,state:'ACTIVE'}) : null;
 }
 function prepareRunSnapshot(input) {
  requireInput(input && typeof input.workspace==='string');safeId(input.batchId);
  const attemptId=safeId(input.attemptId||crypto.randomUUID()),requestDigest=digest(input.request||{});
  // Config and credential generation are read under the same global lock.
  const candidate=repository.withConfigLock(()=>{
   const view=settings.read(),credential=credentials.status(view.serverUrl);
   return {schemaVersion:1,exportVersion:1,batchId:input.batchId,attemptId,state:'CANDIDATE',serverUrl:view.serverUrl,autoUpload:view.autoUpload,configured:credential.configured,noticeAcknowledged:view.noticeAcknowledged,credentialGeneration:credential.generation,requestDigest};
  });
  return repository.withWorkspaceLock(input.workspace,()=>{
   const previous=repository.readWorkspace(input.workspace,`attempts/${attemptId}.json`);
   if(previous) {
    validateSnapshot(previous,{batchId:input.batchId,attemptId,state:'CANDIDATE'});
    if(previous.batchId!==input.batchId||previous.requestDigest!==requestDigest)throw reportingError('REPORTING_CANDIDATE_CONFLICT');
    return previous;
   }
   return repository.writeWorkspace(input.workspace,`attempts/${attemptId}.json`,candidate);
  });
 }
 function acceptRunSnapshot(workspace,batchId,attemptId) {
  safeId(batchId);safeId(attemptId);
  return repository.withWorkspaceLock(workspace,()=>{
   const state=repository.readRunState(workspace,batchId);
   if(state?.environmentConfirmed!==true||state.initialization?.reportingAttemptId!==attemptId)throw reportingError('REPORTING_RUN_NOT_ACCEPTED');
   const candidate=repository.readWorkspace(workspace,`attempts/${attemptId}.json`);
   if(!candidate)throw reportingError('REPORTING_CANDIDATE_MISSING');
   validateSnapshot(candidate,{batchId,attemptId,state:'CANDIDATE'});
   const previous=readRunSnapshot(workspace,batchId);
   if(previous) {
    if(previous.attemptId!==attemptId)throw reportingError('REPORTING_CANDIDATE_CONFLICT');
    return previous;
   }
   return repository.writeWorkspace(workspace,`runs/${batchId}.json`,{...candidate,state:'ACTIVE'});
  });
 }
 function enqueue(input) {
  requireInput(input && typeof input.workspace==='string' && ['batch','workspace'].includes(input.scope) && ['automatic','manual'].includes(input.trigger));
  if(input.scope==='batch')safeId(input.batchId);
  const serverUrl=normalizeServerUrl(input.serverUrl);
  requireInput(Number.isInteger(input.exportVersion)&&input.exportVersion>0);
  requireInput(input.credentialGeneration===null||typeof input.credentialGeneration==='string');
  return repository.withWorkspaceLock(input.workspace,()=>{
   const identity=repository.readWorkspace(input.workspace,'identity.json');
   if(!identity)throw reportingError('REPORTING_IDENTITY_STATE_MISSING');
   if(identity.identityEpoch!==input.identityEpoch)throw reportingError('REPORTING_IDENTITY_STALE');
   const dedupe=input.trigger==='automatic'?{batchId:input.batchId,serverUrl,exportVersion:input.exportVersion,identityEpoch:input.identityEpoch}: {requestId:input.requestId||crypto.randomUUID(),serverUrl,identityEpoch:input.identityEpoch,exportVersion:input.exportVersion};
   const intentId=digest(dedupe),previous=repository.readWorkspace(input.workspace,`intents/${intentId}.json`);
   if(previous)return previous;
   return repository.writeWorkspace(input.workspace,`intents/${intentId}.json`,{intentId,state:'QUEUED',scope:input.scope,trigger:input.trigger,batchId:input.batchId||null,serverUrl,credentialGeneration:input.credentialGeneration,exportVersion:input.exportVersion,identityEpoch:input.identityEpoch,createdAt:repository.now(),runtimeRoot:input.runtimeRoot||null,bundleId:input.bundleId||null});
  });
 }
 return {prepareRunSnapshot,acceptRunSnapshot,readRunSnapshot,enqueue};
}
module.exports={createIntents};
