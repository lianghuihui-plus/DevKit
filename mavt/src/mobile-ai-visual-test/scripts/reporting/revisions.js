'use strict';
const crypto = require('node:crypto');
const { createRepository, safeId } = require('./repository');
const { reportingError, requireInput } = require('./errors');
const KINDS = new Set(['workspace', 'definition', 'execution']);
function canonicalJson(value) {
  const seen = new Set();
  function stable(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    requireInput(item && typeof item === 'object' && !seen.has(item), 'Fingerprint inputs must be finite JSON data');
    seen.add(item);
    let result;
    if (Array.isArray(item)) result = item.map(stable);
    else result = Object.fromEntries(Object.keys(item).sort().map(k => [k, stable(item[k])]));
    seen.delete(item);
    return result;
  }
  return JSON.stringify(stable(value));
}
function fingerprint(entry) {
  requireInput(entry && KINDS.has(entry.kind) && typeof entry.key === 'string' && entry.key.length > 0 && entry.key.length <= 1024);
  requireInput(entry.descriptor && typeof entry.descriptor === 'object' && !Array.isArray(entry.descriptor));
  const descriptor = {...entry.descriptor};
  delete descriptor[entry.kind === 'definition' ? 'definitionRevision' : 'revision'];
  const dependencies = entry.dependencies || [];
  requireInput(Array.isArray(dependencies));
  const semanticDependencies = dependencies.map(value => {
    requireInput(value && typeof value === 'object' && !Array.isArray(value));
    const copy = {...value}; delete copy.encoding; return copy;
  });
  return crypto.createHash('sha256').update(canonicalJson({kind:entry.kind,key:entry.key,descriptor,dependencies:semanticDependencies})).digest('hex');
}
function createRevisions(options = {}) {
  const repository = options.repository || createRepository(options);
  function identity(workspace) {
    const value = repository.readWorkspace(workspace,'identity.json');
    if (!value) throw reportingError('REPORTING_IDENTITY_STATE_MISSING');
    const ledger=repository.readWorkspace(workspace,'revisions.json');
    if (!ledger) throw reportingError('REPORTING_REVISION_STATE_MISSING');
    if (ledger.identityEpoch !== value.identityEpoch) throw reportingError('REPORTING_IDENTITY_CONFLICT');
    return {identity:value,ledger};
  }
  function apply(workspace, tx) {
    const {identity:value,ledger}=identity(workspace);
    if (tx.identityEpoch !== value.identityEpoch) return; // Old epoch is an archive, never applied.
    if (!['PREPARED','PUBLISHING','COMPLETED','ABANDONED'].includes(tx.state)) throw reportingError('REPORTING_STATE_CORRUPT');
    if (tx.state === 'COMPLETED' || tx.state === 'ABANDONED') return;
    const entries={...ledger.entries};
    for (const allocation of tx.allocations) {
      const old = entries[allocation.indexKey];
      if (old?.transactionId === tx.transactionId) continue;
      if (canonicalJson(old || null) !== canonicalJson(allocation.previous)) throw reportingError('REPORTING_REVISION_CONFLICT');
      entries[allocation.indexKey]={fingerprint:allocation.fingerprint,revision:allocation.revision,transactionId:tx.transactionId,...(allocation.binding?{binding:allocation.binding}:{})};
    }
    repository.writeWorkspace(workspace,'revisions.json',{...ledger,entries});
    if (tx.state === 'PUBLISHING') {
      requireInput(tx.manifest && typeof tx.manifest === 'object');
      const manifestHash=crypto.createHash('sha256').update(canonicalJson(tx.manifest)).digest('hex');
      repository.writeWorkspace(workspace,`packages/${safeId(tx.packageId)}/manifest.json`,{manifest:tx.manifest,identityEpoch:tx.identityEpoch});
      repository.writeWorkspace(workspace,`packages/${tx.packageId}/package.json`,{state:'PACKAGE_READY',transactionId:tx.transactionId,identityEpoch:tx.identityEpoch,packageId:tx.packageId,manifestHash,allocations:tx.allocations});
    }
    repository.writeWorkspace(workspace,`transactions/${tx.transactionId}.json`,{...tx,state:tx.state === 'PUBLISHING'?'COMPLETED':'ABANDONED'});
  }
  function recoverLocked(workspace) {
    identity(workspace);
    for(const filename of repository.listWorkspace(workspace,'transactions')) {
      if (filename === 'identity.json') continue;
      if (!filename.endsWith('.json')) continue;
      const tx=repository.readWorkspace(workspace,`transactions/${filename}`);
      if (tx?.type !== 'revisions') throw reportingError('REPORTING_STATE_CORRUPT');
      apply(workspace,tx);
    }
  }
  function reserve(workspace, input) {
    safeId(input?.packageId);
    requireInput(input.exportVersion===undefined || input.exportVersion===1,'Only reporting exportVersion 1 is supported');
    requireInput(Array.isArray(input.entries) && input.entries.length > 0);
    const prepared=input.entries.map(entry=>({entry,fingerprint:fingerprint(entry),indexKey:`${entry.kind}:${entry.key}`}));
    requireInput(new Set(prepared.map(v=>v.indexKey)).size===prepared.length,'Duplicate revision identity');
    return repository.withWorkspaceLock(workspace,()=>{
      recoverLocked(workspace);
      const {identity:value,ledger}=identity(workspace);
      const published=repository.readWorkspace(workspace,`packages/${input.packageId}/package.json`);
      if (published) throw reportingError('REPORTING_PACKAGE_IMMUTABLE');
      // A package id cannot silently rebind an abandoned reservation to different data.
      for(const filename of repository.listWorkspace(workspace,'transactions')) {
        if (filename==='identity.json' || !filename.endsWith('.json')) continue;
        const existing=repository.readWorkspace(workspace,`transactions/${filename}`);
        if(existing.identityEpoch===value.identityEpoch && existing.packageId===input.packageId) throw reportingError('REPORTING_PACKAGE_IMMUTABLE');
      }
      const allocations=prepared.map(({entry,fingerprint:digest,indexKey})=>{
        const previous=ledger.entries[indexKey] || null;
        let binding;
        if(entry.kind==='execution') {
          const {caseKey,platform,startedAt}=entry.descriptor;
          requireInput([caseKey,platform,startedAt].every(x=>typeof x==='string'&&x.length>0),'Execution identity requires caseKey, platform, and startedAt');
          binding={caseKey,platform,startedAt};
          if(previous?.binding && canonicalJson(previous.binding)!==canonicalJson(binding)) throw reportingError('REPORTING_EXECUTION_IDENTITY_CONFLICT');
        }
        return {kind:entry.kind,key:entry.key,indexKey,fingerprint:digest,revision:previous?.fingerprint===digest?previous.revision:(previous?.revision||0)+1,previous,...(binding?{binding}:{})};
      });
      const tx={type:'revisions',state:'PREPARED',transactionId:crypto.randomUUID(),packageId:input.packageId,identityEpoch:value.identityEpoch,exportVersion:1,allocations};
      repository.writeWorkspace(workspace,`transactions/${tx.transactionId}.json`,tx);
      return tx;
    });
  }
  function publish(workspace, input) {
    safeId(input?.transactionId);
    canonicalJson(input.manifest);
    return repository.withWorkspaceLock(workspace,()=>{
      const tx=repository.readWorkspace(workspace,`transactions/${input.transactionId}.json`);
      if(!tx || tx.type!=='revisions') throw reportingError('REPORTING_TRANSACTION_MISSING');
      const {identity:value}=identity(workspace);
      if(tx.identityEpoch!==value.identityEpoch) throw reportingError('REPORTING_IDENTITY_STALE');
      if(tx.state==='COMPLETED') {
        if(canonicalJson(tx.manifest)!==canonicalJson(input.manifest)) throw reportingError('REPORTING_PACKAGE_IMMUTABLE');
      } else {
        if(tx.state!=='PREPARED' && tx.state!=='PUBLISHING') throw reportingError('REPORTING_RESERVATION_ABANDONED');
        if(tx.state==='PUBLISHING' && canonicalJson(tx.manifest)!==canonicalJson(input.manifest)) throw reportingError('REPORTING_PACKAGE_IMMUTABLE');
        const next={...tx,state:'PUBLISHING',manifest:input.manifest};
        repository.writeWorkspace(workspace,`transactions/${tx.transactionId}.json`,next);
        apply(workspace,next);
      }
      return assertReady(workspace,tx.packageId);
    });
  }
  function assertReady(workspace,packageId) {
    safeId(packageId);
    const {identity:value,ledger}=identity(workspace);
    const ready=repository.readWorkspace(workspace,`packages/${packageId}/package.json`);
    if(!ready || ready.state!=='PACKAGE_READY') throw reportingError('REPORTING_PACKAGE_NOT_READY');
    if(ready.identityEpoch!==value.identityEpoch) throw reportingError('REPORTING_IDENTITY_STALE');
    const tx=repository.readWorkspace(workspace,`transactions/${safeId(ready.transactionId)}.json`);
    const frozen=repository.readWorkspace(workspace,`packages/${packageId}/manifest.json`);
    if(tx?.state!=='COMPLETED' || tx.identityEpoch!==value.identityEpoch || !frozen || frozen.identityEpoch!==value.identityEpoch || crypto.createHash('sha256').update(canonicalJson(frozen.manifest)).digest('hex')!==ready.manifestHash || tx.allocations.some(a=>!(ledger.entries[a.indexKey]?.revision>=a.revision))) throw reportingError('REPORTING_PACKAGE_NOT_READY');
    return {...ready,manifest:frozen.manifest};
  }
  return {reserve,publish,recover:workspace=>repository.withWorkspaceLock(workspace,()=>recoverLocked(workspace)),assertReady};
}
module.exports = { createRevisions, fingerprint, canonicalJson };
