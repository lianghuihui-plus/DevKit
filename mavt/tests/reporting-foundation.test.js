'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../src/mobile-ai-visual-test/scripts/reporting');
const load = (name) => require(path.join(root, name));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-reporting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'workspace.json'), JSON.stringify({schemaVersion:1,type:'mobile-ai-visual-test-workspace',name:'original',custom:{keep:true}}));
  const repository = load('repository').createRepository({configDir:path.join(dir,'config')});
  return {dir,workspace,repository,configDir:path.join(dir,'config')};
}
function components(t) {
  const f=fixture(t);
  f.credentials=load('credentials').createCredentials({repository:f.repository});
  f.settings=load('settings').createSettings({repository:f.repository});
  f.identity=load('identity').createIdentity({repository:f.repository});
  f.revisions=load('revisions').createRevisions({repository:f.repository});
  f.intents=load('intents').createIntents({repository:f.repository,settings:f.settings,credentials:f.credentials});
  return f;
}
function fillToken(f,url,token='fixture-secret') {
  const {credentialPath}=f.credentials.prepare(url);
  const value=JSON.parse(fs.readFileSync(credentialPath));
  value.targets[url]={token};
  fs.writeFileSync(credentialPath,JSON.stringify(value),{mode:0o600});
}
const entry=(text='one')=>({kind:'definition',key:'case-a',descriptor:{title:text,definitionRevision:999,extensions:{revision:3}},dependencies:[]});
const statePath=(f,p)=>path.join(f.workspace,'.mavt','reporting',p);

test('readonly defaults and missing identity never create config or reporting state',t=>{
 const f=components(t);
 assert.equal(f.settings.read().serverUrl,'https://mobile-backend.codemao.cn/mavtdashboard/');
 assert.equal(f.settings.read().autoUpload,true);
 assert.equal(f.settings.read().configured,false);
 assert.equal(f.identity.read(f.workspace),null);
 assert.equal(f.intents.readRunSnapshot(f.workspace,'batch-a'),null);
 assert.equal(fs.existsSync(f.configDir),false);
 assert.equal(fs.existsSync(path.join(f.workspace,'.mavt')),false);
});
test('normalizes prefixes and custom ports and rejects unsafe destinations',t=>{
 const f=components(t);
 for(const [input,want] of [['https://EXAMPLE.com:443/prefix','https://example.com/prefix/'],['http://127.0.0.1:9876/deploy','http://127.0.0.1:9876/deploy/'],['http://[::1]:8080','http://[::1]:8080/'],['http://localhost:8081/','http://localhost:8081/']]) assert.equal(f.settings.update({serverUrl:input}).serverUrl,want);
 for(const serverUrl of ['http://example.com/','https://user:pass@example.com/','https://a/?x=1','https://a/#x','file:///tmp/a','https://a/?','https://a/#']) assert.throws(()=>f.settings.update({serverUrl}),{code:'REPORTING_URL_INVALID'});
 assert.throws(()=>f.settings.update({token:'forbidden'}),{code:'REPORTING_INPUT_INVALID'});
});
test('credential templates are per target, preserve tokens, and safe views contain no secrets',t=>{
 const f=components(t),a='https://example.com/prefix/',b='http://localhost:8080/';
 fillToken(f,a);
 const before=fs.readFileSync(path.join(f.configDir,'credentials.json'),'utf8');
 assert.equal(f.credentials.prepare(a).configured,true);
 assert.equal(fs.readFileSync(path.join(f.configDir,'credentials.json'),'utf8'),before);
 f.credentials.prepare(b);
 assert.equal(f.credentials.status(b).configured,false);
 assert.equal(f.credentials.status(a).configured,true);
 const first=f.credentials.status(a).generation;
 fillToken(f,a,'different-secret');
 assert.notEqual(f.credentials.status(a).generation,first);
 assert.equal(f.credentials.readForTransport(a),'different-secret');
 f.settings.update({serverUrl:a,acknowledgeNotice:true});
 assert.equal(f.settings.read().noticeAcknowledged,true);
 f.settings.update({serverUrl:b});
 assert.equal(f.settings.read().noticeAcknowledged,false);
 assert.equal(f.settings.read().configured,false);
 assert.doesNotMatch(JSON.stringify([f.settings.read(),f.credentials.status(a),f.credentials.prepare(a)]),/different-secret|fixture-secret/);
});
test('all private directories and files start protected; symlinks and escaping paths rejected',t=>{
 const f=components(t);
 f.settings.update({autoUpload:false}); f.credentials.prepare('https://example.com/'); f.identity.ensure(f.workspace);
 function check(dir) { for(const item of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,item.name); assert.equal(fs.statSync(p).mode&0o777,item.isDirectory()?0o700:0o600,p); if(item.isDirectory())check(p); } }
 assert.equal(fs.statSync(f.configDir).mode&0o777,0o700);check(f.configDir);check(path.join(f.workspace,'.mavt'));
 assert.throws(()=>f.repository.readWorkspace(f.workspace,'../escape.json'),{code:'REPORTING_PATH_UNSAFE'});
 const outside=path.join(f.dir,'outside.json');fs.writeFileSync(outside,'{}');fs.symlinkSync(outside,path.join(f.configDir,'linked.json'));
 assert.throws(()=>f.repository.writeConfig('linked.json',{schemaVersion:1}),{code:'REPORTING_PATH_UNSAFE'});
 assert.equal(fs.readFileSync(outside,'utf8'),'{}');
});
test('unknown versions and corrupt private state fail with typed non-secret errors',t=>{
 const f=components(t); f.settings.update({autoUpload:true});
 fs.writeFileSync(path.join(f.configDir,'reporting.json'),'{"schemaVersion":2}');
 assert.throws(()=>f.settings.read(),{code:'REPORTING_STATE_VERSION_UNSUPPORTED'});
 fs.writeFileSync(path.join(f.configDir,'credentials.json'),'sensitive-broken-content',{mode:0o600});
 assert.throws(()=>f.credentials.status('https://example.com/'),e=>e.code==='REPORTING_STATE_CORRUPT'&&!e.message.includes('sensitive'));
});
test('stable identity survives rename, preserves marker extensions, reset invalidates previous epoch',t=>{
 const f=components(t),first=f.identity.ensure(f.workspace);
 assert.match(first.workspaceId,/^[\da-f-]{36}$/); assert.match(first.identityEpoch,/^[\da-f-]{36}$/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace,'workspace.json'))).custom.keep,true);
 const renamed=path.join(f.dir,'renamed');fs.renameSync(f.workspace,renamed);f.workspace=renamed;
 assert.equal(f.identity.ensure(renamed).workspaceId,first.workspaceId);
 const reset=f.identity.reset(renamed);
 assert.notEqual(reset.workspaceId,first.workspaceId);assert.notEqual(reset.identityEpoch,first.identityEpoch);assert.notEqual(reset.anonymizationSalt,first.anonymizationSalt);
});
test('missing revision ledger is never silently recreated',t=>{
 const f=components(t); f.identity.ensure(f.workspace);fs.unlinkSync(statePath(f,'revisions.json'));
 assert.throws(()=>f.identity.ensure(f.workspace),{code:'REPORTING_REVISION_STATE_MISSING'});
 assert.equal(fs.existsSync(statePath(f,'revisions.json')),false);
 assert.ok(f.identity.reset(f.workspace).workspaceId);
});
test('identity initialization recovers all files from a durable journal before reuse',t=>{
 const f=components(t);const first=f.identity.ensure(f.workspace);
 const identity=JSON.parse(fs.readFileSync(statePath(f,'identity.json'))),ledger=JSON.parse(fs.readFileSync(statePath(f,'revisions.json'))),marker=JSON.parse(fs.readFileSync(path.join(f.workspace,'workspace.json')));
 f.repository.writeWorkspace(f.workspace,'transactions/identity.json',{schemaVersion:1,type:'identity',state:'PREPARED',marker,identity,ledger});
 fs.unlinkSync(statePath(f,'identity.json'));fs.unlinkSync(statePath(f,'revisions.json'));
 assert.equal(f.identity.ensure(f.workspace).workspaceId,first.workspaceId);
 assert.equal(f.repository.readWorkspace(f.workspace,'transactions/identity.json').state,'COMPLETED');
});
test('fingerprints ignore only owned revisions and transport metadata, retaining unknown nested attributes',t=>{
 const {fingerprint}=load('revisions');const e=entry();
 assert.equal(fingerprint(e),fingerprint({...e,descriptor:{...e.descriptor,definitionRevision:2},encoding:'gzip',jobId:'other'}));
 assert.notEqual(fingerprint(e),fingerprint({...e,descriptor:{...e.descriptor,extensions:{revision:4}}}));
 assert.notEqual(fingerprint(e),fingerprint({...e,dependencies:[{fileId:'f',sha256:'abc',bytes:3,mediaType:'text/plain',purpose:'evidence',extensions:{revision:1}}]}));
});
test('revision reservations recover forward, stable content stays at one, changed content increments',t=>{
 const f=components(t);f.identity.ensure(f.workspace);
 const first=f.revisions.reserve(f.workspace,{packageId:'package-a',entries:[entry()]});
 assert.equal(first.allocations[0].revision,1);
 assert.throws(()=>f.revisions.assertReady(f.workspace,'package-a'),{code:'REPORTING_PACKAGE_NOT_READY'});
 f.revisions.recover(f.workspace);
 const same=f.revisions.reserve(f.workspace,{packageId:'package-b',entries:[entry()]}); assert.equal(same.allocations[0].revision,1);
 f.revisions.publish(f.workspace,{transactionId:same.transactionId,manifest:{fixture:true}});
 assert.equal(f.revisions.assertReady(f.workspace,'package-b').state,'PACKAGE_READY');
 assert.equal(f.revisions.reserve(f.workspace,{packageId:'package-c',entries:[entry('changed')]}).allocations[0].revision,2);
});
test('package publication journals its manifest and recovers ledger plus ready marker atomically',t=>{
 const f=components(t);f.identity.ensure(f.workspace);
 const tx=f.revisions.reserve(f.workspace,{packageId:'package-a',entries:[entry()]});
 const pending=f.repository.readWorkspace(f.workspace,`transactions/${tx.transactionId}.json`);
 f.repository.writeWorkspace(f.workspace,`transactions/${tx.transactionId}.json`,{...pending,state:'PUBLISHING',manifest:{fixture:'frozen'}});
 f.revisions.recover(f.workspace);
 assert.equal(f.revisions.assertReady(f.workspace,'package-a').manifest.fixture,'frozen');
});
test('execution identity conflicts cannot change immutable platform and startedAt',t=>{
 const f=components(t);f.identity.ensure(f.workspace);
 const execution={kind:'execution',key:'exec-a',descriptor:{caseKey:'case-a',platform:'ios',startedAt:'2026-10-23T00:00:00.000Z',value:1}};
 f.revisions.reserve(f.workspace,{packageId:'package-a',entries:[execution]});
 assert.throws(()=>f.revisions.reserve(f.workspace,{packageId:'package-b',entries:[{...execution,descriptor:{...execution.descriptor,platform:'android'}}]}),{code:'REPORTING_EXECUTION_IDENTITY_CONFLICT'});
});
test('run snapshots accept only the durable confirmation attempt and never follow changed settings',t=>{
 const f=components(t);const a='https://a.example/prefix/';fillToken(f,a);f.settings.update({serverUrl:a});
 const candidate=f.intents.prepareRunSnapshot({workspace:f.workspace,batchId:'batch-a',attemptId:'attempt-a',request:{decision:'USE_CURRENT'}});
 assert.equal(candidate.state,'CANDIDATE');assert.equal(f.identity.read(f.workspace),null);
 assert.throws(()=>f.intents.acceptRunSnapshot(f.workspace,'batch-a','attempt-a'),{code:'REPORTING_RUN_NOT_ACCEPTED'});
 fs.mkdirSync(path.join(f.workspace,'runs','batch-a'),{recursive:true});
 fs.writeFileSync(path.join(f.workspace,'runs','batch-a','coordinator-state.json'),JSON.stringify({batchId:'batch-a',workspace:f.workspace,environmentConfirmed:true,initialization:{reportingAttemptId:'attempt-a'}}));
 f.settings.update({serverUrl:'https://b.example/',autoUpload:false});
 const accepted=f.intents.acceptRunSnapshot(f.workspace,'batch-a','attempt-a');
 assert.equal(accepted.serverUrl,a);assert.equal(accepted.autoUpload,true);assert.equal(accepted.credentialGeneration,candidate.credentialGeneration);
 assert.equal(f.intents.acceptRunSnapshot(f.workspace,'batch-a','attempt-a').attemptId,'attempt-a');
 assert.doesNotMatch(JSON.stringify(accepted),/fixture-secret/);
 assert.throws(()=>f.intents.prepareRunSnapshot({workspace:f.workspace,batchId:'batch-a',attemptId:'attempt-a',request:{decision:'changed'}}),{code:'REPORTING_CANDIDATE_CONFLICT'});
});
test('intents are target/export deduplicated and reset refuses active upload jobs',t=>{
 const f=components(t);const identity=f.identity.ensure(f.workspace);
 const input={workspace:f.workspace,batchId:'batch-a',serverUrl:'https://a.example/',credentialGeneration:'generation',exportVersion:1,identityEpoch:identity.identityEpoch,trigger:'automatic',scope:'batch'};
 const first=f.intents.enqueue(input),second=f.intents.enqueue(input);assert.equal(first.intentId,second.intentId);
 assert.notEqual(f.intents.enqueue({...input,serverUrl:'https://b.example/'}).intentId,first.intentId);
 f.repository.writeWorkspace(f.workspace,'jobs/job-a/state.json',{schemaVersion:1,state:'RUNNING',identityEpoch:identity.identityEpoch});
 assert.throws(()=>f.identity.reset(f.workspace),{code:'REPORTING_IDENTITY_BUSY'});
});

test('credential reads reject unsafe permissions without changing files during readonly calls',t=>{
 const f=components(t),url='https://example.com/';fillToken(f,url);
 const file=path.join(f.configDir,'credentials.json');fs.chmodSync(file,0o644);
 const before=fs.statSync(file);
 assert.throws(()=>f.credentials.status(url),{code:'REPORTING_CREDENTIALS_INSECURE'});
 assert.equal(fs.statSync(file).mode,before.mode);
 assert.equal(fs.statSync(file).mtimeMs,before.mtimeMs);
});
test('identity writes preserve the permissions of an existing workspace root',t=>{
 const f=components(t);fs.chmodSync(f.workspace,0o755);f.identity.ensure(f.workspace);
 assert.equal(fs.statSync(f.workspace).mode&0o777,0o755);
});
test('deleted ledger stays missing even when private identity was also deleted',t=>{
 const f=components(t);f.identity.ensure(f.workspace);
 fs.unlinkSync(statePath(f,'revisions.json'));fs.unlinkSync(statePath(f,'identity.json'));
 assert.throws(()=>f.identity.ensure(f.workspace),{code:'REPORTING_IDENTITY_STATE_MISSING'});
 assert.equal(fs.existsSync(statePath(f,'revisions.json')),false);
});
test('an uploading claim blocks reset and old queued intents and packages cannot cross reset',t=>{
 const f=components(t),old=f.identity.ensure(f.workspace);
 const tx=f.revisions.reserve(f.workspace,{packageId:'old-package',entries:[entry()]});f.revisions.publish(f.workspace,{transactionId:tx.transactionId,manifest:{value:'old'}});
 f.repository.writeWorkspace(f.workspace,'worker-claim.json',{state:'CLAIMED',identityEpoch:old.identityEpoch});
 assert.throws(()=>f.identity.reset(f.workspace),{code:'REPORTING_IDENTITY_BUSY'});
 f.repository.writeWorkspace(f.workspace,'worker-claim.json',{state:'RELEASED',identityEpoch:old.identityEpoch});f.identity.reset(f.workspace);
 assert.throws(()=>f.revisions.assertReady(f.workspace,'old-package'),{code:'REPORTING_IDENTITY_STALE'});
 assert.throws(()=>f.intents.enqueue({workspace:f.workspace,scope:'batch',batchId:'old-batch',trigger:'automatic',serverUrl:'https://example.com/',credentialGeneration:null,exportVersion:1,identityEpoch:old.identityEpoch}),{code:'REPORTING_IDENTITY_STALE'});
});
test('missing candidate never falls back to current settings and competing confirmations do not overwrite the accepted target',t=>{
 const f=components(t);fs.mkdirSync(path.join(f.workspace,'runs','batch-a'),{recursive:true});
 const marker=path.join(f.workspace,'runs','batch-a','coordinator-state.json');
 fs.writeFileSync(marker,JSON.stringify({workspace:f.workspace,batchId:'batch-a',environmentConfirmed:true,initialization:{reportingAttemptId:'missing'}}));
 assert.throws(()=>f.intents.acceptRunSnapshot(f.workspace,'batch-a','missing'),{code:'REPORTING_CANDIDATE_MISSING'});
 assert.equal(f.intents.readRunSnapshot(f.workspace,'batch-a'),null);
 f.intents.prepareRunSnapshot({workspace:f.workspace,batchId:'batch-a',attemptId:'attempt-a'});
 f.intents.prepareRunSnapshot({workspace:f.workspace,batchId:'batch-a',attemptId:'attempt-b'});
 fs.writeFileSync(marker,JSON.stringify({workspace:f.workspace,batchId:'batch-a',environmentConfirmed:true,initialization:{reportingAttemptId:'attempt-a'}}));
 f.intents.acceptRunSnapshot(f.workspace,'batch-a','attempt-a');
 fs.writeFileSync(marker,JSON.stringify({workspace:f.workspace,batchId:'batch-a',environmentConfirmed:true,initialization:{reportingAttemptId:'attempt-b'}}));
 assert.throws(()=>f.intents.acceptRunSnapshot(f.workspace,'batch-a','attempt-b'),{code:'REPORTING_CANDIDATE_CONFLICT'});
 assert.equal(f.intents.readRunSnapshot(f.workspace,'batch-a').attemptId,'attempt-a');
});
test('newer state cannot be overwritten and synchronous metadata locks reject async callbacks',t=>{
 const f=components(t);f.repository.writeConfig('fixture.json',{schemaVersion:1});
 fs.writeFileSync(path.join(f.configDir,'fixture.json'),'{"schemaVersion":99}');
 assert.throws(()=>f.repository.writeConfig('fixture.json',{schemaVersion:1}),{code:'REPORTING_STATE_VERSION_UNSUPPORTED'});
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.configDir,'fixture.json'))).schemaVersion,99);
 assert.throws(()=>f.repository.withWorkspaceLock(f.workspace,async()=>true),{code:'REPORTING_INPUT_INVALID'});
});
test('a package with corrupted frozen bytes or an incomplete transaction is never network ready',t=>{
 const f=components(t);f.identity.ensure(f.workspace);
 const tx=f.revisions.reserve(f.workspace,{packageId:'package-a',entries:[entry()]});f.revisions.publish(f.workspace,{transactionId:tx.transactionId,manifest:{value:'expected'}});
 f.repository.writeWorkspace(f.workspace,'packages/package-a/manifest.json',{identityEpoch:tx.identityEpoch,manifest:{value:'corrupt'}});
 assert.throws(()=>f.revisions.assertReady(f.workspace,'package-a'),{code:'REPORTING_PACKAGE_NOT_READY'});
});
test('multiple processes allocate monotonic revisions without reusing a revision for different semantic content',async t=>{
 const f=components(t);f.identity.ensure(f.workspace);
 const {execFile}=require('node:child_process');
 const script=`const [root,workspace,configDir,worker]=process.argv.slice(1);const r=require(root+'/repository').createRepository({configDir});const rev=require(root+'/revisions').createRevisions({repository:r});const results=[];for(let i=0;i<4;i++){let done=false;for(let a=0;a<150&&!done;a++){try{const tx=rev.reserve(workspace,{packageId:worker+'-'+i+'-'+a,entries:[{kind:'definition',key:'shared',descriptor:{title:worker+'-'+i}}]});rev.publish(workspace,{transactionId:tx.transactionId,manifest:{worker,i}});results.push({revision:tx.allocations[0].revision,fingerprint:tx.allocations[0].fingerprint});done=true;}catch(e){if(!['REPORTING_LOCKED','REPORTING_RESERVATION_ABANDONED'].includes(e.code))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}if(!done)throw Error('retry budget');}process.stdout.write(JSON.stringify(results));`;
 const run=worker=>new Promise((resolve,reject)=>execFile(process.execPath,['-e',script,root,f.workspace,f.configDir,worker],(err,stdout,stderr)=>err?reject(new Error(stderr)):resolve(JSON.parse(stdout))));
 const results=(await Promise.all([run('worker-a'),run('worker-b')])).flat();
 assert.equal(results.length,8);
 const byRevision=new Map();for(const value of results){if(byRevision.has(value.revision))assert.equal(byRevision.get(value.revision),value.fingerprint);byRevision.set(value.revision,value.fingerprint);}
 assert.equal(byRevision.size,8);
 const ledger=f.repository.readWorkspace(f.workspace,'revisions.json');assert.ok(ledger.entries['definition:shared'].revision>=Math.max(...results.map(v=>v.revision)));
});

test('URLs reject empty userinfo and control characters rather than silently repairing them',t=>{
 const f=components(t);
 for(const serverUrl of ['https://@example.com/','https://example.com/line\nbreak','https://example.com/\t']) assert.throws(()=>f.settings.update({serverUrl}),{code:'REPORTING_URL_INVALID'});
});
test('loading lightweight integration dependencies never loads a report renderer',()=>{
 const {execFileSync}=require('node:child_process');
 const script=`require(process.argv[1]+'/settings');require(process.argv[1]+'/intents');process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(x=>x.includes('/scripts/report/'))));`;
 assert.deepEqual(JSON.parse(execFileSync(process.execPath,['-e',script,root],{encoding:'utf8'})),[]);
});

test('frozen packages alone prevent a fresh identity or ledger under the old workspace id',t=>{
 const f=components(t),old=f.identity.ensure(f.workspace);
 const tx=f.revisions.reserve(f.workspace,{packageId:'retained-package',entries:[entry()]});
 f.revisions.publish(f.workspace,{transactionId:tx.transactionId,manifest:{value:'already-exported'}});
 fs.unlinkSync(statePath(f,'identity.json'));fs.unlinkSync(statePath(f,'revisions.json'));
 fs.rmSync(statePath(f,'transactions'),{recursive:true});
 assert.throws(()=>f.identity.ensure(f.workspace),{code:'REPORTING_IDENTITY_STATE_MISSING'});
 assert.equal(fs.existsSync(statePath(f,'identity.json')),false);
 assert.equal(fs.existsSync(statePath(f,'revisions.json')),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace,'workspace.json'))).id,old.workspaceId);
 const reset=f.identity.reset(f.workspace);assert.notEqual(reset.workspaceId,old.workspaceId);
});
test('durable receipt and worker-claim residue also require recovery or reset',t=>{
 for(const relative of ['receipts/receipt-a.json','sessions/session-a.json','worker-claim.json']) {
  const f=components(t);f.repository.writeWorkspace(f.workspace,relative,{identityEpoch:'previous-epoch',state:'RELEASED'});
  assert.throws(()=>f.identity.ensure(f.workspace),{code:'REPORTING_IDENTITY_STATE_MISSING'});
  assert.equal(fs.existsSync(statePath(f,'identity.json')),false);
 }
});
test('native async lock callbacks never execute before rejection or after lock release',async t=>{
 const f=components(t);
 for(const lock of [callback=>f.repository.withConfigLock(callback),callback=>f.repository.withWorkspaceLock(f.workspace,callback)]) {
  let entered=false,continued=false;
  assert.throws(()=>lock(async()=>{entered=true;await Promise.resolve();continued=true;}),{code:'REPORTING_INPUT_INVALID'});
  await Promise.resolve();
  assert.equal(entered,false);assert.equal(continued,false);
 }
});
test('ordinary callbacks returning Promises remain defensively rejected',t=>{
 const f=components(t);
 assert.throws(()=>f.repository.withWorkspaceLock(f.workspace,()=>Promise.resolve('later')),{code:'REPORTING_INPUT_INVALID'});
});
test('corrupted candidates cannot be activated or returned as an existing candidate',t=>{
 const mutations=[
  {serverUrl:'http://external.example/'},{serverUrl:'https://EXAMPLE.com:443/prefix'},
  {autoUpload:'yes'},{configured:'yes'},{noticeAcknowledged:1},
  {credentialGeneration:undefined},{credentialGeneration:4},{credentialGeneration:'not-a-generation'},
  {configured:true,credentialGeneration:null},{requestDigest:undefined},{requestDigest:'bad'},
  {exportVersion:2},{batchId:'other-batch'},{attemptId:'../escape'},{state:'ACTIVE'}
 ];
 for(const mutation of mutations) {
  const f=components(t),candidate=f.intents.prepareRunSnapshot({workspace:f.workspace,batchId:'batch-a',attemptId:'attempt-a'});
  f.repository.writeWorkspace(f.workspace,'attempts/attempt-a.json',{...candidate,...mutation});
  fs.mkdirSync(path.join(f.workspace,'runs','batch-a'),{recursive:true});
  fs.writeFileSync(path.join(f.workspace,'runs','batch-a','coordinator-state.json'),JSON.stringify({workspace:f.workspace,batchId:'batch-a',environmentConfirmed:true,initialization:{reportingAttemptId:'attempt-a'}}));
  assert.throws(()=>f.intents.acceptRunSnapshot(f.workspace,'batch-a','attempt-a'),{code:'REPORTING_STATE_CORRUPT'});
  assert.equal(fs.existsSync(statePath(f,'runs/batch-a.json')),false);
  assert.throws(()=>f.intents.prepareRunSnapshot({workspace:f.workspace,batchId:'batch-a',attemptId:'attempt-a'}),{code:'REPORTING_STATE_CORRUPT'});
 }
});
test('corrupted ACTIVE snapshots fail readonly validation and cannot be accepted again',t=>{
 const mutations=[{serverUrl:'http://external.example/'},{autoUpload:'yes'},{credentialGeneration:undefined},{requestDigest:undefined},{state:'CANDIDATE'},{batchId:'other-batch'},{exportVersion:2}];
 for(const mutation of mutations) {
  const f=components(t),candidate=f.intents.prepareRunSnapshot({workspace:f.workspace,batchId:'batch-a',attemptId:'attempt-a'});
  f.repository.writeWorkspace(f.workspace,'runs/batch-a.json',{...candidate,state:'ACTIVE',...mutation});
  const file=statePath(f,'runs/batch-a.json'),before=fs.readFileSync(file,'utf8'),mtime=fs.statSync(file).mtimeMs;
  assert.throws(()=>f.intents.readRunSnapshot(f.workspace,'batch-a'),{code:'REPORTING_STATE_CORRUPT'});
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.statSync(file).mtimeMs,mtime);
  fs.mkdirSync(path.join(f.workspace,'runs','batch-a'),{recursive:true});
  fs.writeFileSync(path.join(f.workspace,'runs','batch-a','coordinator-state.json'),JSON.stringify({workspace:f.workspace,batchId:'batch-a',environmentConfirmed:true,initialization:{reportingAttemptId:'attempt-a'}}));
  assert.throws(()=>f.intents.acceptRunSnapshot(f.workspace,'batch-a','attempt-a'),{code:'REPORTING_STATE_CORRUPT'});
 }
});
test('unsupported revision export versions cannot reserve or publish mismatched package metadata',t=>{
 const f=components(t);f.identity.ensure(f.workspace);
 for(const exportVersion of [0,2,-1,'1',null]) assert.throws(()=>f.revisions.reserve(f.workspace,{packageId:'bad-export',entries:[entry()],exportVersion}),{code:'REPORTING_INPUT_INVALID'});
 assert.deepEqual(f.repository.listWorkspace(f.workspace,'packages'),[]);
 const tx=f.revisions.reserve(f.workspace,{packageId:'supported-export',entries:[entry()],exportVersion:1});
 const ready=f.revisions.publish(f.workspace,{transactionId:tx.transactionId,manifest:{value:'supported'}});
 assert.equal(ready.exportVersion,tx.exportVersion);assert.equal(ready.exportVersion,1);
});
