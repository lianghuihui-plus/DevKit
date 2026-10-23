'use strict';
const crypto = require('node:crypto');
const { createRepository, EXPORT_VERSION } = require('./repository');
const { reportingError } = require('./errors');
function createIdentity(options = {}) {
  const repository = options.repository || createRepository(options);
  function read(workspace) {
    const identity = repository.readWorkspace(workspace, 'identity.json');
    if (identity && (!identity.workspaceId || !identity.identityEpoch || !identity.anonymizationSalt)) throw reportingError('REPORTING_STATE_CORRUPT');
    return identity;
  }
  function recover(workspace) {
    const tx = repository.readWorkspace(workspace, 'transactions/identity.json');
    if (!tx || tx.state === 'COMPLETED') return;
    if (tx.type !== 'identity' || tx.state !== 'PREPARED' || !tx.marker || !tx.identity || !tx.ledger) throw reportingError('REPORTING_STATE_CORRUPT');
    repository.writeMarker(workspace, tx.marker);
    repository.writeWorkspace(workspace, 'identity.json', tx.identity);
    repository.writeWorkspace(workspace, 'revisions.json', tx.ledger);
    repository.writeWorkspace(workspace, 'transactions/identity.json', {...tx,state:'COMPLETED'});
  }
  function current(workspace) {
    const marker = repository.readMarker(workspace), identity = read(workspace);
    if (!identity) {
      // A marker id can legitimately predate reporting, but any private residue cannot.
      const traces = ['revisions.json', 'transactions/identity.json', 'worker-claim.json'].some(p => repository.readWorkspace(workspace,p))
        || ['jobs','transactions','intents','destinations','packages','sessions','receipts'].some(p => repository.listWorkspace(workspace,p).length);
      if (traces) throw reportingError('REPORTING_IDENTITY_STATE_MISSING');
      return {marker,identity:null};
    }
    if (marker.id !== identity.workspaceId) throw reportingError('REPORTING_IDENTITY_CONFLICT');
    const ledger = repository.readWorkspace(workspace, 'revisions.json');
    if (!ledger) throw reportingError('REPORTING_REVISION_STATE_MISSING', 'Restore the local ledger or explicitly reset the identity');
    if (ledger.identityEpoch !== identity.identityEpoch) throw reportingError('REPORTING_IDENTITY_CONFLICT');
    return {marker,identity};
  }
  function initialize(workspace, marker, old = null) {
    const identity = {schemaVersion:1,exportVersion:EXPORT_VERSION,workspaceId:old ? crypto.randomUUID() : marker.id || crypto.randomUUID(),identityEpoch:crypto.randomUUID(),anonymizationSalt:crypto.randomBytes(32).toString('hex')};
    const ledger = {schemaVersion:1,exportVersion:EXPORT_VERSION,identityEpoch:identity.identityEpoch,entries:{}};
    // Old tasks/receipts remain on disk as an archive, inaccessible under the new epoch.
    const tx = {schemaVersion:1,type:'identity',state:'PREPARED',identityEpoch:identity.identityEpoch,marker:{...marker,id:identity.workspaceId},identity,ledger,previousIdentityEpoch:old?.identityEpoch || null};
    repository.writeWorkspace(workspace,'transactions/identity.json',tx);
    recover(workspace);
    return read(workspace);
  }
  function ensure(workspace) {
    return repository.withWorkspaceLock(workspace,()=>{
      recover(workspace);
      const {marker,identity}=current(workspace);
      return identity || initialize(workspace,marker);
    });
  }
  function reset(workspace) {
    return repository.withWorkspaceLock(workspace,()=>{
      recover(workspace);
      const marker=repository.readMarker(workspace),old=read(workspace);
      for (const jobId of repository.listWorkspace(workspace,'jobs')) {
        const state=repository.readWorkspace(workspace,`jobs/${jobId}/state.json`);
        const claim=repository.readWorkspace(workspace,`jobs/${jobId}/claim.json`);
        if (['RUNNING','UPLOADING','COMMITTING'].includes(state?.state) || (claim && claim.state !== 'RELEASED')) throw reportingError('REPORTING_IDENTITY_BUSY','An upload task or claim is active');
      }
      const claim=repository.readWorkspace(workspace,'worker-claim.json');
      if (claim && claim.state !== 'RELEASED') throw reportingError('REPORTING_IDENTITY_BUSY');
      return initialize(workspace,marker,old || {identityEpoch:null});
    });
  }
  return {read,ensure,reset};
}
module.exports = { createIdentity };
