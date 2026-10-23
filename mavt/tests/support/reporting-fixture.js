'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = path.resolve(__dirname, '../../src/mobile-ai-visual-test/scripts');
const helpers = require(path.join(runtime, 'tests/support/workspace-fixture'));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true
  });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(t, options = [{}]) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-export-')));
  t.after(() => fs.rmSync(dir, {
    recursive: true,
    force: true
  }));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const old = process.env.MAVT_SELF_TEST;
  process.env.MAVT_SELF_TEST = '1';
  let sources;
  try {
    write(path.join(workspace, 'workspace.json'), {
      schemaVersion: 1,
      type: helpers.TEST_WORKSPACE_TYPE,
      testOnly: true
    });
    sources = options.map(o => helpers.createCurrentFixture(workspace, o));
  }
  finally {
    if (old === undefined)
      delete process.env.MAVT_SELF_TEST;
    else
      process.env.MAVT_SELF_TEST = old;
  }
  write(path.join(workspace, 'workspace.json'), {
    schemaVersion: 1,
    type: 'mobile-ai-visual-test-workspace',
    name: 'Export fixture'
  });
  const repository = require(path.join(runtime, 'reporting/repository')).createRepository({
    configDir: path.join(dir, 'config')
  });
  const request = {
    workspace,
    scope: 'workspace'
  };
  return {
    dir,
    workspace,
    sources,
    repository,
    request,
    dependencies: {
      repository
    }
  };
}
module.exports = {
  fixture,
  write,
  runtime
};
// Re-seal after an intentional fixture mutation, using the same production
// completion/artifact validation used by real finalized execution reports.
function reseal(s) {
  const { buildExecutionArtifactManifest } = require(path.join(runtime, 'lib/execution-artifact-manifest'));
  const { sha256File, completionPaths, validatePublishedCompletion } = require(path.join(runtime, 'lib/completion-contract'));
  fs.unlinkSync(path.join(s.execDir, 'artifact-manifest.json'));
  buildExecutionArtifactManifest(s.execDir, {
    now: s.execution.endedAt
  });
  const p = completionPaths(s.execDir), e = JSON.parse(fs.readFileSync(p.execution || path.join(s.execDir, 'execution.json')));
  const c = {
    ...s.completion,
    resultSha256: sha256File(p.result),
    metricsSha256: sha256File(p.metrics),
    artifactManifestSha256: sha256File(p.artifactManifest)
  };
  write(p.completion, c);
  validatePublishedCompletion(s.execDir, c, {
    execution: e,
    result: JSON.parse(fs.readFileSync(p.result)),
    metrics: JSON.parse(fs.readFileSync(p.metrics)),
    snapshot: JSON.parse(fs.readFileSync(path.join(s.execDir, 'case.snapshot.json')))
  });
}
function bindBatch(f) {
  const old = process.env.MAVT_SELF_TEST, marker = fs.readFileSync(path.join(f.workspace, 'workspace.json'));
  process.env.MAVT_SELF_TEST = '1';
  const s = f.sources[0], batchId = s.execution.batchId;
  try {
    write(path.join(f.workspace, 'workspace.json'), {
      schemaVersion: 1,
      type: helpers.TEST_WORKSPACE_TYPE,
      testOnly: true
    });
    helpers.createTestExecutionRequest(f.workspace, batchId, s.execution.targetBinding, [{
        caseKey: s.caseJson.identity.caseKey,
        caseDir: s.caseDir
      }]);
    require(path.join(runtime, 'batch/core')).initializeBatch({
      workspaceRoot: f.workspace,
      batchId
    });
  }
  finally {
    fs.writeFileSync(path.join(f.workspace, 'workspace.json'), marker);
    if (old === undefined)
      delete process.env.MAVT_SELF_TEST;
    else
      process.env.MAVT_SELF_TEST = old;
  }
  const file = path.join(f.workspace, 'runs', batchId, 'batch.json'), state = JSON.parse(fs.readFileSync(file));
  Object.assign(state, {
    status: 'COMPLETED',
    currentIndex: 1,
    finalization: {
      platformReleased: true,
      executionsSettled: true,
      casesCommitted: true,
      cause: 'COMPLETED'
    },
    warmSession: {
      ...state.warmSession,
      status: 'CLOSED'
    }
  });
  Object.assign(state.cases[0], {
    status: 'COMPLETED',
    executionId: s.execution.executionId,
    verdict: s.result.verdict,
    executionStatus: s.execution.executionStatus
  });
  write(file, state);
  require(path.join(runtime, 'batch/state-contract')).validateBatchState(state, JSON.parse(fs.readFileSync(path.join(f.workspace, 'runs', batchId, 'contract.json'))), {
    schemaVersion: 8
  });
  write(path.join(f.workspace, 'runs', batchId, 'coordinator-state.json'), {
    schemaVersion: 1,
    type: 'coordinatorRun',
    workspace: f.workspace,
    batchId,
    phase: 'COMPLETE',
    environmentConfirmed: true,
    targets: [{
        caseKey: s.caseJson.identity.caseKey,
        caseDir: s.caseDir
      }]
  });
  write(path.join(f.workspace, 'runs', batchId, 'report-publication.json'), {
    schemaVersion: 1,
    batchId,
    status: 'PUBLISHED',
    attempts: []
  });
  return batchId;
}
module.exports.reseal = reseal;
module.exports.bindBatch = bindBatch;
