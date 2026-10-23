'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, write, runtime } = require('./support/reporting-fixture');
const load = name => require(path.join(runtime, 'reporting', name));
const collect = f => load('collector').collectExport(f.request, f.dependencies);
const document = (p, ref) => JSON.parse(fs.readFileSync(p.files.find(f => f.id === ref.fileId).path));
const sections = (p, e) => document(p, e.report).sections;
const data = (p, e, k) => {
  const s = sections(p, e).find(s => s.kind === k);
  return s.data ?? JSON.parse(fs.readFileSync(p.files.find(f => f.id === s.dataFiles[0].fileId).path));
};
const error = code => e => e.code === code;
test('same source exports deterministic bytes without revision changes', async (t) => {
  const f = fixture(t), a = await collect(f), b = await collect(f);
  assert.deepEqual(b.manifests, a.manifests);
  assert.equal(a.state, 'PACKAGE_READY');
  assert.equal(a.manifests[0].executions[0].revision, 1);
  assert.equal(load('revisions').createRevisions(f.dependencies).assertReady(f.workspace, a.packageId).state, 'PACKAGE_READY');
  for (const s of a.sessions) {
    assert.match(s.key, /^[a-f0-9-]{36}$/);
    assert.equal(fs.readFileSync(s.manifestPath, 'utf8'), s.rawManifest);
  }
});
test('all 17 standard kinds and native projections retain source, flow, checks and evidence', async (t) => {
  const f = fixture(t, [{
      checkStatus: 'WAIVED',
      checkReason: '批准豁免',
      summary: '含豁免'
    }]), p = await collect(f), e = p.manifests[0].executions[0];
  assert.deepEqual(sections(p, e).filter(s => !s.kind.startsWith('mavt-')).map(s => s.kind).sort(), load('sections').SECTION_KINDS.slice().sort());
  assert.equal(data(p, e, 'checks')[0].status, 'WAIVED');
  assert.equal(data(p, e, 'checks')[0].expected, null);
  assert.equal(e.summary.extensions.mavt.waived, 1);
  assert.equal(e.summary.extensions.mavt.passWithWaivers, true);
  const native = data(p, e, 'mavt-native-report');
  assert.equal(native.rendererVersion, 'mavt-current/1');
  assert.ok(native.views.baselineFlow);
  assert.ok(native.trace.raw.events.length);
  assert.ok(Object.keys(native.artifacts).some(r => r.startsWith('screenshots/')));
  assert.ok(Object.keys(native.artifacts).some(r => r.startsWith('layouts/')));
  assert.ok(data(p, e, 'logs').length);
  assert.equal(native.case.identity.caseKey, e.caseKey);
});
test('current definition changes do not rewrite execution source snapshots', async (t) => {
  const f = fixture(t), s = f.sources[0];
  write(path.join(s.caseDir, 'source.md'), 'changed current markdown');
  const p = await collect(f), m = p.manifests[0], d = document(p, m.cases[0].definition);
  assert.equal(d.sections.find(s => s.kind === 'case-source').data.source, 'changed current markdown');
  assert.notEqual(data(p, m.executions[0], 'case-source').source, 'changed current markdown');
});
test('latest startedAt wins even if an older execution ended later', async (t) => {
  const f = fixture(t), s = f.sources[0], old = path.join(s.runtimeDir, 'executions', 'older');
  fs.cpSync(s.execDir, old, {
    recursive: true
  });
  const e = {
    ...s.execution,
    executionId: 'older',
    status: 'CANCELLED',
    finalized: false,
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-14T00:00:00.000Z'
  };
  write(path.join(old, 'execution.json'), e);
  const p = await collect(f);
  assert.equal(p.manifests[0].executions[0].executionId, s.execution.executionId);
});
test('corrupt newest source is rejected rather than falling back to PASS', async (t) => {
  const f = fixture(t), s = f.sources[0], dir = path.join(s.runtimeDir, 'executions', 'newest');
  fs.mkdirSync(dir);
  write(path.join(dir, 'execution.json'), {
    ...s.execution,
    executionId: 'newest',
    startedAt: '2026-08-14T00:00:00.000Z'
  });
  write(path.join(dir, 'result.json'), '{bad');
  await assert.rejects(collect(f), error('REPORTING_SOURCE_INVALID'));
});
test('corrupt optional JSONL cannot be swallowed by trace fallback', async (t) => {
  const f = fixture(t);
  write(path.join(f.sources[0].execDir, 'telemetry/invocations.jsonl'), '{bad');
  await assert.rejects(collect(f), error('REPORTING_SOURCE_INVALID'));
});
test('cancellation and finalized missing result have distinct honest runtime states', async (t) => {
  for (const cancelled of [true, false]) {
    const f = fixture(t), s = f.sources[0];
    fs.unlinkSync(path.join(s.execDir, 'result.json'));
    fs.unlinkSync(path.join(s.execDir, 'completion.json'));
    write(path.join(s.execDir, 'execution.json'), {
      ...s.execution,
      status: cancelled ? 'CANCELLED' : 'FINISHED',
      finalized: !cancelled
    });
    const p = await collect(f), e = p.manifests[0].executions[0];
    assert.equal(e.summary.executionStatus, cancelled ? 'CANCELLED' : 'FAILED');
    assert.equal(e.summary.displayStatus, cancelled ? 'CANCELLED' : 'RESULT_MISSING');
    assert.equal(data(p, e, 'runtime').executionStatus, e.summary.executionStatus);
    assert.equal(data(p, e, 'mavt-native-report').report.display.status, e.summary.displayStatus);
  }
});
test('running execution is explicitly excluded; only truly unexecuted selection is definition-only', async (t) => {
  const f = fixture(t), s = f.sources[0];
  write(path.join(s.execDir, 'execution.json'), {
    ...s.execution,
    finalized: false,
    status: 'RUNNING'
  });
  fs.unlinkSync(path.join(s.execDir, 'completion.json'));
  const p = await collect(f);
  assert.equal(p.manifests[0].executions.length, 0);
  assert.equal(p.excluded[0].reason, 'RUNNING');
  assert.equal(p.manifests[0].cases.length, 1);
});
test('reserved fileId in unknown source properties is rejected', async (t) => {
  const f = fixture(t), s = f.sources[0];
  write(path.join(s.caseDir, 'case.json'), {
    ...s.caseJson,
    unknown: {
      fileId: 'business-key'
    }
  });
  await assert.rejects(collect(f), error('REPORTING_RESERVED_FIELD_COLLISION'));
});
test('source traversal, symlinks and missing evidence reject complete collection', async (t) => {
  for (const kind of ['traversal', 'symlink', 'missing']) {
    const f = fixture(t), s = f.sources[0];
    if (kind === 'traversal') {
      const e = JSON.parse(fs.readFileSync(path.join(s.execDir, 'events.jsonl'), 'utf8').split('\n')[2]);
      e.screenshotRef = '../outside.png';
      write(path.join(s.execDir, 'events.jsonl'), JSON.stringify(e) + '\n');
    }
    else {
      const file = path.join(s.execDir, 'screenshots/scene-0001.png');
      fs.unlinkSync(file);
      if (kind === 'symlink') {
        write(path.join(f.dir, 'outside.png'), 'private');
        fs.symlinkSync(path.join(f.dir, 'outside.png'), file);
      }
    }
    await assert.rejects(collect(f), e => /REPORTING_(PATH_UNSAFE|SOURCE_INVALID|EVIDENCE_MISSING)/.test(e.code));
  }
});
test('single-file and aggregate structured source budgets reject before trace is entered', async (t) => {
  for (const aggregate of [false, true]) {
    const f = fixture(t), s = f.sources[0];
    const size = aggregate ? 12 * 1024 * 1024 : 17 * 1024 * 1024;
    for (let i = 0; i < (aggregate ? 3 : 1); i++)
      write(path.join(s.execDir, `telemetry/large-${i}.json`), ' '.repeat(size));
    let trace = false;
    f.dependencies.buildTrace = () => {
      trace = true;
      throw Error('must not run');
    };
    await assert.rejects(collect(f), error('REPORTING_SOURCE_BUDGET_EXCEEDED'));
    assert.equal(trace, false);
  }
});
test('unknown source values survive unified redaction and final bytes are hashed', async (t) => {
  const f = fixture(t), s = f.sources[0];
  write(path.join(s.caseDir, 'case.json'), {
    ...s.caseJson,
    unknown: {
      revision: 7,
      token: 'SECRET-VALUE',
      deviceId: 'raw-device',
      tool: '/Users/person/private/tool',
      note: 'screenshots/fake.png'
    }
  });
  const p = await collect(f), d = document(p, p.manifests[0].cases[0].definition), n = d.sections.find(s => s.kind === 'mavt-native-case').data;
  assert.equal(n.case.unknown.revision, 7);
  assert.equal(n.case.unknown.note, 'screenshots/fake.png');
  assert.doesNotMatch(JSON.stringify(n), /SECRET-VALUE|raw-device|\/Users\/person/);
  for (const file of p.files) {
    const bytes = fs.readFileSync(file.path);
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
  }
});
test('single execution limits cannot silently drop evidence', async (t) => {
  const f = fixture(t);
  f.request.limits = {
    fileBytes: 10
  };
  await assert.rejects(collect(f), error('REPORTING_UNIT_TOO_LARGE'));
});
test('all units freeze into multiple complete sessions before ready', async (t) => {
  const f = fixture(t, [{
      suffix: 'one'
    }, {
      suffix: 'two'
    }, {
      suffix: 'three'
    }]);
  f.request.limits = {
    cases: 1
  };
  const p = await collect(f);
  assert.equal(p.sessions.length, 3);
  assert.equal(p.manifests.flatMap(m => m.executions).length, 3);
  for (const m of p.manifests)
    assert.equal(m.cases.length, 1);
});
test('failed last unit never publishes earlier sessions as PACKAGE_READY', async (t) => {
  const f = fixture(t, [{
      suffix: 'good'
    }, {
      suffix: 'bad'
    }]);
  write(path.join(f.sources[1].execDir, 'result.json'), '{bad');
  await assert.rejects(collect(f));
  assert.deepEqual(f.repository.listWorkspace(f.workspace, 'packages').filter(id => f.repository.readWorkspace(f.workspace, `packages/${id}/package.json`)), []);
});
test('unsupported source version, startedAt ties and execution identity collisions are explicit', async (t) => {
  {
    const f = fixture(t);
    write(path.join(f.sources[0].execDir, 'execution.json'), {
      ...f.sources[0].execution,
      schemaVersion: 13
    });
    await assert.rejects(collect(f), error('REPORTING_SOURCE_VERSION_UNSUPPORTED'));
  }
  {
    const f = fixture(t), s = f.sources[0], other = path.join(s.runtimeDir, 'executions', 'tie');
    fs.mkdirSync(other);
    write(path.join(other, 'execution.json'), {
      ...s.execution,
      executionId: 'tie'
    });
    await assert.rejects(collect(f), error('REPORTING_SELECTION_CONFLICT'));
  }
  {
    const f = fixture(t, [{
        suffix: 'a'
      }, {
        suffix: 'b'
      }]);
    write(path.join(f.sources[1].execDir, 'execution.json'), {
      ...f.sources[1].execution,
      executionId: f.sources[0].execution.executionId
    });
    await assert.rejects(collect(f), error('REPORTING_EXECUTION_ID_COLLISION'));
  }
});
test('strict local manifest/document validators reject lengths, null, UTC, duplicates and dangling references', async (t) => {
  const f = fixture(t), p = await collect(f), c = load('contracts');
  const clone = () => JSON.parse(JSON.stringify(p.manifests[0]));
  for (const mutate of [m => m.cases[0].title = 'x'.repeat(1025), m => m.executions[0].endedAt = undefined, m => m.executions[0].startedAt = '2026-08-13T02:00:00Z', m => m.files.push(m.files[0]), m => m.cases[0].definition.fileId = 'absent']) {
    const m = clone();
    mutate(m);
    assert.throws(() => c.validateManifest(m));
  }
  const e = p.manifests[0].executions[0], d = document(p, e.report);
  d.sections.find(s => s.kind === 'checks').data[0].status = 'FAIL';
  assert.throws(() => c.validateDocument(d, {
    execution: e
  }));
});
test('frozen raw bytes and attachments are revalidated without recollecting', async (t) => {
  const f = fixture(t), p = await collect(f);
  assert.equal(load('collector').readFrozenExport(f.workspace, p.packageId, f.dependencies).sessions.length, 1);
  fs.appendFileSync(p.sessions[0].manifestPath, ' ');
  assert.throws(() => load('collector').readFrozenExport(f.workspace, p.packageId, f.dependencies), error('REPORTING_PACKAGE_CORRUPT'));
});
test('required referenced scene is validated before the trace renderer can default it away', async (t) => {
  const f = fixture(t), s = f.sources[0];
  write(path.join(s.execDir, 'execution.json'), {
    ...s.execution,
    status: 'CANCELLED',
    finalized: false
  });
  fs.unlinkSync(path.join(s.execDir, 'result.json'));
  fs.unlinkSync(path.join(s.execDir, 'completion.json'));
  fs.unlinkSync(path.join(s.execDir, 'scenes/scene-0001.json'));
  let called = false;
  f.dependencies.buildTrace = report => {
    called = true;
    return require(path.join(runtime, 'report/execution-trace')).buildExecutionTrace(report);
  };
  await assert.rejects(collect(f));
  assert.equal(called, false);
});
test('automatic batch uses frozen batch cases executionId rather than coordinator target or latest', async (t) => {
  const f = fixture(t), batchId = require('./support/reporting-fixture').bindBatch(f), s = f.sources[0];
  const dir = path.join(s.runtimeDir, 'executions', 'later');
  fs.mkdirSync(dir);
  write(path.join(dir, 'execution.json'), {
    ...s.execution,
    executionId: 'later',
    startedAt: '2026-08-14T00:00:00.000Z',
    status: 'CANCELLED',
    finalized: false
  });
  f.request = {
    workspace: f.workspace,
    scope: 'batch',
    batchId
  };
  const p = await collect(f);
  assert.equal(p.manifests[0].executions[0].executionId, s.execution.executionId);
});
test('source change at prepublication boundary refuses PACKAGE_READY', async (t) => {
  const f = fixture(t);
  f.dependencies.validatePackage = () => write(path.join(f.sources[0].caseDir, 'source.md'), 'changed while collecting');
  await assert.rejects(collect(f), error('REPORTING_SOURCE_CHANGED'));
});
test('evidence with explicit sensitivity cannot be sent without safe export copy', async (t) => {
  const f = fixture(t), s = f.sources[0], scene = JSON.parse(fs.readFileSync(path.join(s.execDir, 'scenes/scene-0001.json')));
  scene.screenshot.sensitive = true;
  write(path.join(s.execDir, 'scenes/scene-0001.json'), scene);
  require('./support/reporting-fixture').reseal(s);
  await assert.rejects(collect(f), error('REPORTING_SENSITIVE_EVIDENCE'));
});
test('sequence input text and account strings are redacted in every raw attachment', async (t) => {
  const f = fixture(t, [{
      verdict: 'FAIL'
    }]), s = f.sources[0];
  write(path.join(s.execDir, 'knowledge/raw.json'), {
    snapshotRef: 'knowledge/content.md',
    request: {
      steps: [{
          type: 'act',
          input: {
            text: 'TYPED-SECRET'
          }
        }]
    },
    account: 'RAW-ACCOUNT'
  });
  write(path.join(s.execDir, 'knowledge/content.md'), 'token=RAW-TOKEN\n/opt/private/tool\n');
  const events = fs.readFileSync(path.join(s.execDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  events.find(e => e.type === 'knowledgeReviewed').snapshotRef = 'knowledge/raw.json';
  write(path.join(s.execDir, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  require('./support/reporting-fixture').reseal(s);
  const p = await collect(f);
  for (const file of p.files.filter(f => /json|text|svg/.test(f.mediaType)))
    assert.doesNotMatch(fs.readFileSync(file.path, 'utf8'), /TYPED-SECRET|RAW-ACCOUNT|RAW-TOKEN|\/opt\/private/);
});
test('nonempty sequences, invocation phases, knowledge snapshots and spans preserve native semantics', async (t) => {
  const f = fixture(t, [{
      verdict: 'FAIL'
    }]), s = f.sources[0], seqRef = 'operations/sequences/sequence-0001.json';
  const seq = {
    schemaVersion: 1,
    executionId: s.execution.executionId,
    sequenceId: 'sequence-0001',
    sequenceRecordRef: seqRef,
    requestKey: 'sequence-request-fixture',
    deadlineMs: 1000,
    elapsedMs: 25,
    status: 'COMPLETED',
    terminal: true,
    basedOnSceneRef: 'scene-0001',
    finalSceneRef: 'scene-0002',
    steps: [{
        stepId: 'step-1',
        type: 'capture',
        status: 'COMPLETED',
        preSceneRef: 'scene-0001',
        postSceneRef: 'scene-0002'
      }],
    custom: {
      revision: 9
    }
  };
  const unsigned = require(path.join(runtime, 'lib/contract-utils')).canonicalJson(seq);
  seq.integrity = {
    recordSha256: crypto.createHash('sha256').update(unsigned).digest('hex')
  };
  write(path.join(s.execDir, seqRef), seq);
  const events = fs.readFileSync(path.join(s.execDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  events.push({
    eventId: 'seq-request',
    type: 'sequenceRequested',
    sequenceId: seq.sequenceId,
    sequenceRecordRef: seqRef,
    requestKey: seq.requestKey,
    time: s.execution.endedAt,
    sequence: 90
  }, {
    eventId: 'seq-end',
    type: 'sequenceCompleted',
    sequenceId: seq.sequenceId,
    sequenceRecordRef: seqRef,
    recordSha256: seq.integrity.recordSha256,
    status: 'COMPLETED',
    time: s.execution.endedAt,
    sequence: 91
  });
  Object.assign(events.find(e => e.type === 'sceneObserved' && e.sceneId === 'scene-0002'), {
    sequenceId: seq.sequenceId,
    promoted: true,
    captureOrigins: ['SEQUENCE_FINAL']
  });
  const finalScene = JSON.parse(fs.readFileSync(path.join(s.execDir, 'scenes/scene-0002.json')));
  Object.assign(finalScene, {
    sequenceId: seq.sequenceId,
    promoted: true,
    captureOrigins: ['SEQUENCE_FINAL']
  });
  write(path.join(s.execDir, 'scenes/scene-0002.json'), finalScene);
  events.find(e => e.type === 'knowledgeReviewed').snapshotRef = 'knowledge/used.md';
  write(path.join(s.execDir, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  write(path.join(s.execDir, 'knowledge/used.md'), 'Used knowledge\n');
  write(path.join(s.execDir, 'telemetry/invocations.jsonl'), [{
      invocationId: 'inv-1',
      phase: 'START',
      operation: 'observe'
    }, {
      invocationId: 'inv-1',
      phase: 'END',
      durationMs: 23
    }].map(JSON.stringify).join('\n') + '\n');
  write(path.join(s.execDir, 'telemetry/spans.jsonl'), JSON.stringify({
    name: 'custom-span',
    durationMs: 23,
    unit: 'ms'
  }) + '\n');
  require('./support/reporting-fixture').reseal(s);
  const p = await collect(f), e = p.manifests[0].executions[0];
  assert.equal(data(p, e, 'sequences')[0].steps.length, 1);
  assert.deepEqual(data(p, e, 'invocations').map(i => i.phase), ['START', 'END']);
  assert.equal(data(p, e, 'knowledge').snapshots.length, 1);
  assert.ok(data(p, e, 'timing').some(r => r.name === 'custom-span'));
  assert.equal(data(p, e, 'mavt-native-report').trace.sequences[0].integrity.status, 'VALID');
});
test('three supported platforms export their original completed, failed and blocked verdicts', async (t) => {
  const f = fixture(t, [{
      suffix: 'ios',
      platform: 'ios',
      verdict: 'PASS'
    }, {
      suffix: 'android',
      platform: 'android',
      verdict: 'FAIL'
    }, {
      suffix: 'harmony',
      platform: 'harmony',
      verdict: 'BLOCKED'
    }]), p = await collect(f);
  assert.deepEqual(Object.fromEntries(p.manifests[0].executions.map(e => [e.platform, e.summary.displayStatus])), {
    android: 'FAIL',
    harmony: 'BLOCKED',
    ios: 'PASS'
  });
});
test('capabilities reject incompatible version before source/identity writes', async (t) => {
  const f = fixture(t);
  f.request.capabilities = {
    protocolVersions: ['1.0']
  };
  await assert.rejects(collect(f), error('REPORTING_CONTRACT_INVALID'));
  assert.equal(fs.existsSync(path.join(f.workspace, '.mavt/reporting/identity.json')), false);
});
test('text logs anonymize device identity and quoted account credentials', async (t) => {
  const f = fixture(t), s = f.sources[0];
  write(path.join(s.execDir, 'logs/privacy.txt'), 'deviceId=RAW-DEVICE account=RAW-ACCOUNT\n{"token":"RAW-QUOTED-TOKEN"}\n');
  require('./support/reporting-fixture').reseal(s);
  const p = await collect(f);
  for (const file of p.files.filter(f => f.mediaType.startsWith('text/')))
    assert.doesNotMatch(fs.readFileSync(file.path, 'utf8'), /RAW-DEVICE|RAW-ACCOUNT|RAW-QUOTED-TOKEN/);
});
test('absent expected metrics is unavailable with a reason rather than an empty success object', async (t) => {
  const f = fixture(t), s = f.sources[0];
  for (const name of ['completion.json', 'result.json', 'metrics.json'])
    fs.unlinkSync(path.join(s.execDir, name));
  const p = await collect(f), metrics = sections(p, p.manifests[0].executions[0]).find(s => s.kind === 'metrics');
  assert.equal(metrics.availability, 'unavailable');
  assert.equal(typeof metrics.reason, 'string');
  assert.equal(Object.hasOwn(metrics, 'data'), false);
});
test('explicit client limits cannot relax the same capabilities snapshot', async t => {
  const f = fixture(t, [{suffix:'one'}, {suffix:'two'}]);
  const contracts = load('contracts');
  f.request.capabilities = {
    protocolVersions:['2.0'], documentVersions:['1.0'], encodings:['identity'],
    platforms:['android','ios','harmony'], unknownSections:'preserve-with-generic-view',
    sectionVersions:Object.fromEntries(contracts.SECTION_KINDS.map(k => [k,['1.0']])), limits:{cases:1}
  };
  f.request.limits = {cases:2};
  const p = await collect(f);
  assert.equal(p.sessions.length, 2);
});
test('new publication sidecar during collection invalidates the source signature', async t => {
  const f = fixture(t);
  f.dependencies.validatePackage = () => write(path.join(f.workspace,'runs',f.sources[0].execution.batchId,'report-publication.json'), {
    schemaVersion:1, batchId:f.sources[0].execution.batchId, status:'PUBLISHED', attempts:[]
  });
  await assert.rejects(collect(f), error('REPORTING_SOURCE_CHANGED'));
});
test('native single-object limit rejects without truncating original renderer model', async t => {
  const f = fixture(t);
  f.request.limits = {documentBytes:20000};
  await assert.rejects(collect(f), error('REPORTING_NATIVE_MODEL_TOO_LARGE'));
});
test('large standard arrays move to deterministic complete record fragments', async t => {
  const f = fixture(t), s = f.sources[0];
  const events = fs.readFileSync(path.join(s.execDir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  for (let i=0;i<1800;i++) events.push({eventId:`custom-${i}`,type:'customExportRecord',time:s.execution.endedAt,sequence:100+i,note:'x'.repeat(150)});
  write(path.join(s.execDir,'events.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
  require('./support/reporting-fixture').reseal(s);
  const p = await collect(f), e = p.manifests[0].executions[0];
  const eventSection = sections(p,e).find(s => s.kind === 'events');
  assert.ok(eventSection.dataFiles.length);
  const rows = eventSection.dataFiles.flatMap(ref => JSON.parse(fs.readFileSync(p.files.find(f => f.id === ref.fileId).path)));
  assert.equal(rows.length, events.length);
  assert.equal(new Set(rows.map(e=>e.eventId)).size,events.length);
});
test('report health includes real root, case and platform publication metadata', async t => {
  const f = fixture(t), s = f.sources[0];
  write(path.join(f.workspace,'report-metadata.json'), {schemaVersion:1,scope:'index',reportHealth:{status:'DEGRADED',issues:[{code:'root-health'}]}});
  write(path.join(s.caseDir,'report-metadata.json'), {schemaVersion:1,scope:'case',customCaseHealth:'preserved'});
  write(path.join(s.runtimeDir,'report-metadata.json'), {schemaVersion:1,scope:'platform-case',platform:s.execution.platform,executionId:s.execution.executionId,customPlatformHealth:'preserved'});
  const p = await collect(f), e = p.manifests[0].executions[0], health = data(p,e,'report-health');
  assert.equal(health.metadata.workspace.reportHealth.status, 'DEGRADED');
  assert.equal(health.metadata.case.customCaseHealth, 'preserved');
  assert.equal(health.metadata.platform.customPlatformHealth, 'preserved');
});
