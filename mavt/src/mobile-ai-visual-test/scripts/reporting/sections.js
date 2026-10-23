'use strict';
const { SECTION_KINDS, validateSectionData, references } = require('./contracts');
const { nativeCase, nativeReport } = require('./native-model');
const { utc } = require('./selection');
const { reportingError } = require('./errors');
const { bytes } = require('./contracts');
const plain = value => typeof value === 'string' ? value : null;
function section(kind, data) {
  return {
    id: kind,
    kind,
    schemaVersion: '1.0',
    title: kind,
    availability: 'available',
    data
  };
}
function runtimeProjection(source) {
  const { report } = source, e = report.execution, cancelled = e.status === 'CANCELLED', missing = !report.result;
  const endedAt = e.endedAt ? utc(e.endedAt) : null, duration = report.display?.durationMs;
  return {
    executionId: e.executionId,
    platform: e.platform,
    startedAt: utc(e.startedAt),
    endedAt,
    executionStatus: cancelled ? 'CANCELLED' : missing ? 'FAILED' : 'COMPLETED',
    displayStatus: cancelled ? 'CANCELLED' : missing ? 'RESULT_MISSING' : report.result.verdict,
    durationMs: Number.isSafeInteger(duration) && duration >= 0 ? duration : null,
    ...(endedAt === null ? {
      endedAtReason: report.closure ? 'SOURCE_CLOSED_WITHOUT_END_TIME' : 'SOURCE_END_TIME_NOT_RECORDED'
    } : {}),
    sourceExecutionStatus: e.executionStatus ?? null,
    sourceDisplay: report.display
  };
}
function listMetrics(source) {
  const { report, views } = source, m = report.metrics, c = views.coverage, result = {
    version: '1.0'
  };
  const mapping = {
    actions: m?.counts?.actions,
    observations: m?.counts?.observations,
    sequences: m?.sequenceMetrics?.runCount,
    sequenceFailures: m?.sequenceMetrics?.failedCount,
    transientCaptures: m?.sequenceMetrics?.transientCaptureCount,
    checksCovered: c?.covered,
    checksTotal: c?.total,
    waived: c?.waived,
    passWithWaivers: c?.passWithWaivers,
    recoveries: m?.executionRecoveryCount,
    verdictBasis: report.display?.verdictBasis
  };
  if (mapping.sequenceFailures === undefined && m?.sequenceMetrics && Number.isInteger(m.sequenceMetrics.partialCount) && Number.isInteger(m.sequenceMetrics.interruptedCount))
    mapping.sequenceFailures = m.sequenceMetrics.partialCount + m.sequenceMetrics.interruptedCount;
  for (const [k, v] of Object.entries(mapping))
    if (v !== undefined && v !== null)
      result[k] = v;
  return result;
}
const PROJECTORS = {
  'case-source': ({ source }) => ({
    source: source.report.sourceText,
    identity: source.report.snapshot.identity
  }),
  runtime: ({ runtime }) => runtime,
  checks: ({ source }) => (source.report.result?.checks || []).map((check, index) => ({
    ...check,
    checkId: check.checkNodeRef || check.expectationRef || `check-${index + 1}`,
    expected: plain(check.expected),
    actual: plain(check.actual)
  })),
  flow: ({ source }) => {
    const flow = source.views.workingFlow || {
      nodes: [],
      edges: []
    };
    return {
      ...flow,
      nodes: flow.nodes.map(n => ({
        ...n,
        id: n.ref ?? n.id,
        type: String(n.type),
        title: n.text ?? n.title ?? ''
      })),
      edges: flow.edges.map((e, i) => ({
        ...e,
        id: e.id ?? e.ref ?? `edge-${i + 1}`,
        from: e.from,
        to: e.to
      })),
      views: source.views,
      events: source.report.events.filter(e => ['caseFlowRevised', 'flowNodeEntered', 'flowEdgeSelected'].includes(e.type))
    };
  },
  actions: ({ source }) => source.trace.entries.filter(e => e.category === 'ACTION').map(e => ({
    ...e,
    operationId: e.operationId,
    type: e.action?.type || 'unknown',
    outcome: e.outcome?.status || 'UNKNOWN',
    source: e
  })),
  sequences: ({ source }) => (source.trace.sequences || []).map(s => ({
    ...s,
    sequenceId: s.sequenceId,
    status: s.status || s.outcome?.status || 'UNKNOWN',
    steps: s.steps || []
  })),
  scenes: ({ source, artifactMap, graph }) => [...graph.values()].filter(e => e.relative.startsWith('scenes/') && e.data?.sceneId).map(e => ({
    ...e.data,
    sceneId: e.data.sceneId,
    screenshot: e.data.screenshot?.ref ? artifactMap[e.data.screenshot.ref] ?? null : null,
    sourceScreenshot: e.data.screenshot
  })),
  'spatial-evidence': ({ source, graph }) => [...graph.values()].filter(e => e.relative.startsWith('action-spatial-evidence/') && e.data?.operationId).map(e => ({
    ...e.data,
    operationId: e.data.operationId,
    kind: String(e.data.kind || 'UNKNOWN')
  })),
  metrics: ({ source }) => source.report.metrics || {},
  records: ({ source }) => source.trace.entries.map((e, i) => ({
    ...e,
    id: `record-${e.sequence ?? i + 1}`,
    type: e.category || 'record'
  })),
  invocations: ({ graph }) => (graph.get('telemetry/invocations.jsonl')?.data || []).map((r, i) => ({
    ...r,
    invocationId: r.invocationId || r.requestId || `invocation-${i + 1}`,
    phase: String(r.phase || 'UNKNOWN')
  })),
  events: ({ source }) => source.report.events.map((e, i) => ({
    ...e,
    eventId: e.eventId || `event-${e.sequence ?? i + 1}`,
    type: e.type || 'unknown',
    time: e.time || ''
  })),
  timing: ({ source, graph }) => {
    const rows = [];
    const m = source.report.metrics || {};
    for (const [name, durationMs] of Object.entries(m))
      if (/Ms$/.test(name) && typeof durationMs === 'number' && durationMs >= 0)
        rows.push({
          name,
          durationMs
        });
    for (const e of graph.get('telemetry/spans.jsonl')?.data || [])
      if (typeof e.durationMs === 'number' && e.durationMs >= 0)
        rows.push({
          ...e,
          name: e.name || e.phase || 'span',
          durationMs: e.durationMs
        });
    return rows;
  },
  logs: ({ graph, artifactMap }) => [...graph.values()].filter(e => e.relative.startsWith('logs/')).map((e, i) => ({
    id: `log-${i + 1}`,
    label: e.relative,
    content: artifactMap[e.relative]
  })),
  knowledge: ({ source, graph, artifactMap }) => ({
    usage: source.report.metrics?.knowledgeUsage ?? null,
    events: source.report.events.filter(e => /knowledge/i.test(e.type)),
    snapshots: [...graph.keys()].filter(r => r.startsWith('knowledge/')).map(r => ({
      ref: r,
      content: artifactMap[r]
    })),
    investigations: source.trace.narrative?.knowledgeInvestigations ?? []
  }),
  'report-health': ({ source, graph }) => ({
    status: source.report.completion ? 'HEALTHY' : source.report.result ? 'READABLE' : 'RESULT_MISSING',
    issues: source.report.result ? [] : [{
        code: 'RESULT_MISSING',
        closure: source.report.closure ?? null
      }],
    metadata: {...source.healthMetadata,execution:graph.get('report-metadata.json')?.data ?? null}
  }),
  integrity: ({ source }) => ({
    sourceCompletion: source.report.completion,
    sourceClosure: source.report.closure ?? null,
    completionValidated: !!source.report.completion,
    sourceFormat: 14,
    sourceFiles: source.inventory.files.map(f => ({
      ref: f.relative,
      bytes: f.bytes,
      sha256: f.hash
    })),
    structuredBytes: source.inventory.structuredBytes
  }),
};
// The static registry is the sole standard-kind list for source projection,
// validation and reference collection. Renderer/version registries stay separate.
const SECTION_REGISTRY = Object.freeze(SECTION_KINDS.map(kind => Object.freeze({
  kind,
  schemaVersion: '1.0',
  shape: ['case-source', 'runtime', 'flow', 'metrics', 'knowledge', 'report-health', 'integrity'].includes(kind) ? 'object' : 'array',
  project: PROJECTORS[kind],
  validate: (data, doc, context) => validateSectionData({
    kind,
    schemaVersion: '1.0'
  }, data, doc, context),
  collectRefs: references
})));
function definitionDocument(definition, redactor) {
  return redactor.redact({
    documentVersion: '1.0',
    documentType: 'case-definition',
    subject: {
      caseKey: definition.case.identity.caseKey
    },
    sections: [section('case-source', {
        source: definition.sourceText,
        identity: definition.case.identity
      }), section('mavt-native-case', nativeCase(definition))]
  });
}
function executionDocument(context, store, redactor, limits) {
  const { source } = context, e = source.report.execution, logical = `execution/${e.executionId}`;
  const sections = SECTION_REGISTRY.map(entry => {
    if (entry.kind === 'metrics' && !source.report.metrics)
      return {
        id: 'metrics',
        kind: 'metrics',
        schemaVersion: '1.0',
        title: 'metrics',
        availability: 'unavailable',
        reason: 'Source metrics were not produced'
      };
    if (entry.kind === 'checks' && !source.report.result)
      return {
        id: 'checks',
        kind: 'checks',
        schemaVersion: '1.0',
        title: 'checks',
        availability: 'unavailable',
        reason: 'Execution closed without a result'
      };
    return section(entry.kind, redactor.redact(entry.project(context)));
  });
  // Large standard arrays split deterministically on record boundaries. Small
  // sections stay inline; each row remains independently valid and complete.
  for (const s of sections)
    if (s.availability === 'available' && bytes(s.data) > Math.min(262144, limits.documentBytes / 4)) {
      if (Array.isArray(s.data)) {
        const chunks = [];
        let chunk = [], size = 2;
        for (const row of s.data) {
          const rowBytes = bytes(row);
          if (rowBytes > limits.jsonlLineBytes || rowBytes + 2 > limits.documentBytes)
            throw reportingError('REPORTING_UNIT_TOO_LARGE');
          if (size + rowBytes + 1 > Math.min(limits.documentBytes, 1048576) && chunk.length) {
            chunks.push(chunk);
            chunk = [];
            size = 2;
          }
          chunk.push(row);
          size += rowBytes + 1;
        }
        if (chunk.length || !chunks.length)
          chunks.push(chunk);
        s.dataFiles = chunks.map((rows, i) => store.putJson(`${logical}/section/${s.kind}/${i}`, rows));
      }
      else
        s.dataFiles = [store.putJson(`${logical}/section/${s.kind}`, s.data)];
      delete s.data;
    }
  const native = redactor.redact(nativeReport(source, context.artifactMap, context.runtime));
  if (bytes(native) > limits.documentBytes)
    throw reportingError('REPORTING_NATIVE_MODEL_TOO_LARGE');
  sections.push({
    id: 'native-report',
    kind: 'mavt-native-report',
    schemaVersion: '1.0',
    title: '完整执行报告',
    availability: 'available',
    dataFiles: [store.putJson(`${logical}/native`, native, 'native-report')]
  });
  return {
    documentVersion: '1.0',
    documentType: 'execution-report',
    subject: {
      caseKey: context.caseKey,
      platform: e.platform,
      executionId: e.executionId
    },
    sections
  };
}
module.exports = {
  SECTION_KINDS,
  SECTION_REGISTRY,
  runtimeProjection,
  listMetrics,
  definitionDocument,
  executionDocument
};
