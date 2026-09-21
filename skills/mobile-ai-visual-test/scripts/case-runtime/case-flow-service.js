'use strict';

const crypto = require('crypto');
const { canonicalJson, contractError, ensureArray, ensureObject, ensureString } = require('../lib/contract-utils');
const store = require('./store');

const NODE_TYPES = new Set(['ACTION', 'DECISION', 'CHECK', 'END']);
const VERIFICATION_KINDS = new Set(['DIRECT_OBSERVATION', 'SEARCH_EXISTENCE']);
const CHECK_REQUIREMENTS = new Set(['REQUIRED', 'CONDITIONAL']);

function strings(value, label) {
  return ensureArray(value, label, 'CASE_FLOW_INVALID')
    .map((item, index) => ensureString(item, `${label}[${index}]`, 'CASE_FLOW_INVALID').trim());
}

function history(execDir) {
  return store.events(execDir).filter((event) => event.type === 'caseFlowRevised');
}

function current(execDir) {
  return history(execDir).at(-1) || null;
}

function baseline(execDir) {
  return history(execDir)[0] || null;
}

function requestSha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizedRequestFromEvent(event) {
  if (event.requestNormalized) return event.requestNormalized;
  return {
    baseRevision: event.revision === 1 ? null : event.revision - 1,
    summary: event.summary,
    entryNodeRef: event.entryNodeRef,
    nodes: event.nodes,
    edges: event.edges,
    uncertainties: event.uncertainties || [],
    reason: event.revision === 1 ? null : event.reason,
  };
}

function matchingPreparedRevision(events, prepared) {
  const normalized = canonicalJson(prepared.requestNormalized);
  const digest = requestSha256(prepared.requestNormalized);
  const matchingDigest = events.filter((event) => event.requestSha256 === digest);
  for (const event of matchingDigest) {
    if (canonicalJson(normalizedRequestFromEvent(event)) !== normalized) {
      throw contractError('CASE_FLOW_REQUEST_DIGEST_COLLISION', 'Case Flow request digest matches different normalized content');
    }
  }
  return matchingDigest[0] || null;
}

function historyForBaseRevision(events, baseRevision) {
  if (baseRevision === null) return [];
  const index = events.findIndex((event) => event.revision === baseRevision);
  return index >= 0 ? events.slice(0, index + 1) : events;
}

function matchingRevision(execDir, value) {
  const events = history(execDir);
  try {
    const input = ensureObject(value, 'caseFlow', 'CASE_FLOW_INVALID');
    const prepared = prepareRevisionWithHistory(execDir, value, historyForBaseRevision(events, input.baseRevision));
    return matchingPreparedRevision(events, prepared);
  } catch (error) {
    if (error?.code === 'CASE_FLOW_REQUEST_DIGEST_COLLISION') throw error;
    return null;
  }
}

function checkpointRegistry(execDir) {
  const events = history(execDir);
  const currentRefs = new Set((events.at(-1)?.nodes || []).filter((node) => node.type === 'CHECK').map((node) => node.ref));
  const introduced = new Map();
  for (const event of events) {
    for (const node of (event.nodes || []).filter((item) => item.type === 'CHECK')) {
      if (!introduced.has(node.ref)) {
        introduced.set(node.ref, { ...node, introducedRevision: event.revision, baseline: event.revision === 1 });
      }
    }
  }
  return [...introduced.values()].map((item) => {
    const retired = events.find((event) => event.revision > item.introducedRevision
      && !(event.nodes || []).some((node) => node.type === 'CHECK' && node.ref === item.ref));
    return {
      ...item,
      active: currentRefs.has(item.ref),
      ...(retired ? { retiredRevision: retired.revision } : {}),
    };
  });
}

function ensureRef(value, label, pattern, code) {
  const ref = ensureString(value, label, code).trim();
  if (!pattern.test(ref)) throw contractError(code, `${label} has invalid format`);
  return ref;
}

function normalizeNodes(value, previous, events) {
  const list = ensureArray(value, 'nodes', 'CASE_FLOW_INVALID');
  const active = new Set((previous?.nodes || []).map((node) => node.ref));
  const retired = new Set(events.flatMap((event) => event.retiredNodeRefs || []));
  const seen = new Set();
  const nodes = list.map((valueItem, index) => {
    const item = ensureObject(valueItem, `nodes[${index}]`, 'CASE_FLOW_INVALID');
    const ref = ensureRef(item.ref, `nodes[${index}].ref`, /^N[1-9]\d*$/, 'CASE_FLOW_NODE_REF_INVALID');
    if (seen.has(ref)) throw contractError('CASE_FLOW_NODE_REF_INVALID', `node ref ${ref} is duplicated`);
    if (retired.has(ref) && !active.has(ref)) {
      throw contractError('CASE_FLOW_NODE_REF_INVALID', `retired node ref ${ref} cannot be reused`);
    }
    seen.add(ref);
    const type = ensureString(item.type, `nodes[${index}].type`, 'CASE_FLOW_INVALID').trim();
    if (!NODE_TYPES.has(type)) throw contractError('CASE_FLOW_INVALID', `nodes[${index}].type is invalid`);
    const allowed = new Set(['ref', 'type', 'text', ...(type === 'CHECK' ? ['verificationKind', 'sourceBasis', 'requirement', 'applicability'] : []),
      ...(type === 'DECISION' ? ['sourceBasis'] : [])]);
    const unsupported = Object.keys(item).filter((field) => !allowed.has(field));
    if (unsupported.length) {
      throw contractError('CASE_FLOW_INVALID', `nodes[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
    }
    const node = { ref, type, text: ensureString(item.text, `nodes[${index}].text`, 'CASE_FLOW_INVALID').trim() };
    if (type === 'DECISION' || type === 'CHECK') {
      node.sourceBasis = ensureString(item.sourceBasis, `nodes[${index}].sourceBasis`, 'CASE_FLOW_INVALID').trim();
    }
    if (type === 'CHECK') {
      const kind = item.verificationKind === undefined ? 'DIRECT_OBSERVATION'
        : ensureString(item.verificationKind, `nodes[${index}].verificationKind`, 'CASE_FLOW_INVALID').trim();
      if (!VERIFICATION_KINDS.has(kind)) {
        throw contractError('CASE_FLOW_INVALID', `nodes[${index}].verificationKind is invalid`);
      }
      node.verificationKind = kind;
      const requirement = ensureString(item.requirement, `nodes[${index}].requirement`, 'CASE_FLOW_INVALID').trim();
      if (!CHECK_REQUIREMENTS.has(requirement)) {
        throw contractError('CASE_FLOW_INVALID', `nodes[${index}].requirement is invalid`);
      }
      node.requirement = requirement;
      if (requirement === 'CONDITIONAL') {
        node.applicability = ensureString(item.applicability, `nodes[${index}].applicability`, 'CASE_FLOW_INVALID').trim();
        if (!node.applicability) throw contractError('CASE_FLOW_INVALID', `nodes[${index}].applicability must not be empty`);
      } else if (Object.prototype.hasOwnProperty.call(item, 'applicability')) {
        throw contractError('CASE_FLOW_INVALID', `nodes[${index}].applicability is only valid for CONDITIONAL checks`);
      }
    }
    return node;
  });
  if (!previous && !nodes.some((node) => node.type === 'CHECK')) {
    throw contractError('CASE_FLOW_INVALID', 'Case Flow must contain at least one CHECK node');
  }
  if (!nodes.some((node) => node.type === 'END')) {
    throw contractError('CASE_FLOW_INVALID', 'Case Flow must contain at least one END node');
  }
  return nodes;
}

function validateStableIdentities(events, nodes, edges) {
  if (!events.length) return;
  const baselineEvent = events[0];
  const nodeByRef = new Map(nodes.map((node) => [node.ref, node]));
  const edgeByRef = new Map(edges.map((edge) => [edge.ref, edge]));
  const stableNodes = new Map((baselineEvent.nodes || []).map((node) => [node.ref, node]));
  for (const event of events) {
    for (const node of (event.nodes || []).filter((item) => item.type === 'CHECK')) {
      if (!stableNodes.has(node.ref)) stableNodes.set(node.ref, node);
    }
  }
  for (const [ref, original] of stableNodes) {
    const candidate = nodeByRef.get(ref);
    if (candidate && canonicalJson(candidate) !== canonicalJson(original)) {
      throw contractError('CASE_FLOW_NODE_IDENTITY_CHANGED', `node ${ref} cannot change its original meaning`);
    }
  }
  for (const original of baselineEvent.edges || []) {
    const candidate = edgeByRef.get(original.ref);
    if (candidate && canonicalJson(candidate) !== canonicalJson(original)) {
      throw contractError('CASE_FLOW_EDGE_IDENTITY_CHANGED', `edge ${original.ref} cannot change its original meaning`);
    }
  }
}

function normalizeEdges(value, nodes, previous, events) {
  const list = ensureArray(value, 'edges', 'CASE_FLOW_INVALID');
  const nodeByRef = new Map(nodes.map((node) => [node.ref, node]));
  const active = new Set((previous?.edges || []).map((edge) => edge.ref));
  const retired = new Set(events.flatMap((event) => event.retiredEdgeRefs || []));
  const seen = new Set();
  const edges = list.map((valueItem, index) => {
    const item = ensureObject(valueItem, `edges[${index}]`, 'CASE_FLOW_EDGE_INVALID');
    const unsupported = Object.keys(item).filter((field) => !['ref', 'from', 'to', 'condition'].includes(field));
    if (unsupported.length) {
      throw contractError('CASE_FLOW_EDGE_INVALID', `edges[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
    }
    const ref = ensureRef(item.ref, `edges[${index}].ref`, /^L[1-9]\d*$/, 'CASE_FLOW_EDGE_REF_INVALID');
    if (seen.has(ref)) throw contractError('CASE_FLOW_EDGE_REF_INVALID', `edge ref ${ref} is duplicated`);
    if (retired.has(ref) && !active.has(ref)) {
      throw contractError('CASE_FLOW_EDGE_REF_INVALID', `retired edge ref ${ref} cannot be reused`);
    }
    seen.add(ref);
    const from = ensureString(item.from, `edges[${index}].from`, 'CASE_FLOW_EDGE_INVALID').trim();
    const to = ensureString(item.to, `edges[${index}].to`, 'CASE_FLOW_EDGE_INVALID').trim();
    if (!nodeByRef.has(from) || !nodeByRef.has(to)) {
      throw contractError('CASE_FLOW_EDGE_INVALID', `edge ${ref} references an unknown node`);
    }
    return {
      ref,
      from,
      to,
      ...(Object.prototype.hasOwnProperty.call(item, 'condition')
        ? { condition: ensureString(item.condition, `edges[${index}].condition`, 'CASE_FLOW_EDGE_INVALID').trim() }
        : {}),
    };
  });
  return edges;
}

function validateGraph(entryNodeRef, nodes, edges) {
  const nodeByRef = new Map(nodes.map((node) => [node.ref, node]));
  if (!nodeByRef.has(entryNodeRef)) throw contractError('CASE_FLOW_INVALID', 'entryNodeRef does not reference a node');
  const outgoing = new Map(nodes.map((node) => [node.ref, []]));
  const incoming = new Map(nodes.map((node) => [node.ref, []]));
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }
  for (const node of nodes) {
    const nodeEdges = outgoing.get(node.ref);
    if (node.type === 'END' && nodeEdges.length) {
      throw contractError('CASE_FLOW_EDGE_INVALID', `END node ${node.ref} must not have outgoing edges`);
    }
    if (['ACTION', 'CHECK'].includes(node.type)
      && (nodeEdges.length !== 1 || Object.prototype.hasOwnProperty.call(nodeEdges[0] || {}, 'condition'))) {
      throw contractError('CASE_FLOW_EDGE_INVALID', `${node.type} node ${node.ref} requires exactly one unconditional edge`);
    }
    if (node.type === 'DECISION'
      && (nodeEdges.length < 2 || nodeEdges.some((edge) => !String(edge.condition || '').trim()))) {
      throw contractError('CASE_FLOW_EDGE_INVALID', `DECISION node ${node.ref} requires at least two conditional edges`);
    }
  }
  const reachable = new Set();
  const pending = [entryNodeRef];
  while (pending.length) {
    const ref = pending.pop();
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    for (const edge of outgoing.get(ref) || []) pending.push(edge.to);
  }
  const unreachable = nodes.map((node) => node.ref).filter((ref) => !reachable.has(ref));
  if (unreachable.length) {
    throw contractError('CASE_FLOW_UNREACHABLE_NODE', `nodes are unreachable from entry: ${unreachable.join(', ')}`);
  }
  const reachesEnd = new Set(nodes.filter((node) => node.type === 'END').map((node) => node.ref));
  const reversePending = [...reachesEnd];
  while (reversePending.length) {
    const ref = reversePending.pop();
    for (const edge of incoming.get(ref) || []) {
      if (!reachesEnd.has(edge.from)) {
        reachesEnd.add(edge.from);
        reversePending.push(edge.from);
      }
    }
  }
  const trapped = nodes.map((node) => node.ref).filter((ref) => !reachesEnd.has(ref));
  if (trapped.length) {
    throw contractError('CASE_FLOW_END_UNREACHABLE', `nodes cannot reach an END: ${trapped.join(', ')}`);
  }
}

function prepareRevisionWithHistory(execDir, value, events) {
  const input = ensureObject(value, 'caseFlow', 'CASE_FLOW_INVALID');
  const allowed = new Set(['baseRevision', 'summary', 'entryNodeRef', 'nodes', 'edges', 'uncertainties', 'reason']);
  const unsupported = Object.keys(input).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('CASE_FLOW_INVALID', `caseFlow contains unsupported fields: ${unsupported.join(', ')}`);
  const previous = events.at(-1) || null;
  const expected = previous?.revision || null;
  if (input.baseRevision !== expected) {
    throw contractError('CASE_FLOW_REVISION_CONFLICT', `baseRevision ${input.baseRevision} does not match current revision ${expected}`);
  }
  if (previous && !String(input.reason || '').trim()) {
    throw contractError('CASE_FLOW_REASON_REQUIRED', 'reason is required when revising the current Case Flow');
  }
  const nodes = normalizeNodes(input.nodes, previous, events);
  const edges = normalizeEdges(input.edges, nodes, previous, events);
  validateStableIdentities(events, nodes, edges);
  const entryNodeRef = ensureString(input.entryNodeRef, 'entryNodeRef', 'CASE_FLOW_INVALID').trim();
  validateGraph(entryNodeRef, nodes, edges);
  const activeNodeRefs = new Set(nodes.map((node) => node.ref));
  const activeEdgeRefs = new Set(edges.map((edge) => edge.ref));
  const newlyRetiredNodeRefs = (previous?.nodes || []).map((node) => node.ref).filter((ref) => !activeNodeRefs.has(ref));
  const newlyRetiredEdgeRefs = (previous?.edges || []).map((edge) => edge.ref).filter((ref) => !activeEdgeRefs.has(ref));
  const requestNormalized = {
    baseRevision: input.baseRevision,
    summary: ensureString(input.summary, 'summary', 'CASE_FLOW_INVALID').trim(),
    entryNodeRef,
    nodes,
    edges,
    uncertainties: strings(input.uncertainties, 'uncertainties'),
    reason: previous ? String(input.reason).trim() : null,
  };
  return {
    previous,
    newlyRetiredNodeRefs,
    newlyRetiredEdgeRefs,
    requestNormalized,
    event: {
      revision: events.length + 1,
      reason: previous ? String(input.reason).trim() : 'INITIAL_CASE_FLOW',
      basedOnSceneRef: previous ? store.readCurrentScene(execDir)?.sceneId || null : null,
      summary: requestNormalized.summary,
      entryNodeRef: requestNormalized.entryNodeRef,
      nodes: requestNormalized.nodes,
      edges: requestNormalized.edges,
      uncertainties: requestNormalized.uncertainties,
      retiredNodeRefs: [...new Set([...(previous?.retiredNodeRefs || []), ...newlyRetiredNodeRefs])],
      retiredEdgeRefs: [...new Set([...(previous?.retiredEdgeRefs || []), ...newlyRetiredEdgeRefs])],
    },
  };
}

function prepareRevision(execDir, value) {
  return prepareRevisionWithHistory(execDir, value, history(execDir));
}

function commitRevision(execDir, prepared, options = {}) {
  const existing = options.submissionId
    ? history(execDir).find((event) => event.submissionId === options.submissionId)
    : null;
  const event = existing || store.appendEvent(execDir, 'caseFlowRevised', {
    ...prepared.event,
    submissionId: options.submissionId || null,
    requestSha256: options.requestSha256 || null,
    requestNormalized: prepared.requestNormalized,
  }, options);
  const previous = prepared.previous || history(execDir).filter((item) => item.sequence < event.sequence).at(-1) || null;
  const invalidatedResultRefs = require('./expectation-result-service')
    .invalidateForCaseFlowChange(execDir, previous, event, options);
  return {
    status: 'CASE_FLOW_RECORDED',
    caseFlow: event,
    ...(existing ? { idempotent: true } : {}),
    caseFlowChange: {
      revision: event.revision,
      retiredNodeRefs: prepared.newlyRetiredNodeRefs || [],
      retiredEdgeRefs: prepared.newlyRetiredEdgeRefs || [],
      invalidatedResultRefs,
    },
  };
}

function revise(execDir, value, options = {}) {
  const events = history(execDir);
  const input = ensureObject(value, 'caseFlow', 'CASE_FLOW_INVALID');
  const prepared = prepareRevisionWithHistory(execDir, value, historyForBaseRevision(events, input.baseRevision));
  const digest = requestSha256(prepared.requestNormalized);
  const existing = matchingPreparedRevision(events, prepared);
  if (existing) {
    const previous = events.filter((event) => event.sequence < existing.sequence).at(-1) || null;
    return {
      status: 'CASE_FLOW_RECORDED',
      caseFlow: existing,
      idempotent: true,
      caseFlowChange: {
        revision: existing.revision,
        retiredNodeRefs: (existing.retiredNodeRefs || []).filter((ref) => !(previous?.retiredNodeRefs || []).includes(ref)),
        retiredEdgeRefs: (existing.retiredEdgeRefs || []).filter((ref) => !(previous?.retiredEdgeRefs || []).includes(ref)),
        invalidatedResultRefs: [],
      },
    };
  }
  const currentRevision = events.at(-1)?.revision || null;
  if (input.baseRevision !== currentRevision) {
    throw contractError('CASE_FLOW_REVISION_CONFLICT', `baseRevision ${input.baseRevision} does not match current revision ${currentRevision}`);
  }
  return commitRevision(execDir, prepared, { ...options, requestSha256: digest });
}

function currentRevision(execDir) {
  return current(execDir)?.revision || null;
}

function validateFlowContext(execDir, value) {
  if (value === undefined) return null;
  const context = ensureObject(value, 'flowContext', 'CASE_FLOW_CONTEXT_INVALID');
  const unsupported = Object.keys(context).filter((field) => !['nodeRef', 'selectedEdgeRef'].includes(field));
  if (unsupported.length) throw contractError('CASE_FLOW_CONTEXT_INVALID', `flowContext contains unsupported fields: ${unsupported.join(', ')}`);
  const flow = current(execDir);
  if (!flow) throw contractError('CASE_FLOW_REQUIRED', 'flowContext requires a current Case Flow');
  const nodeRef = ensureString(context.nodeRef, 'flowContext.nodeRef', 'CASE_FLOW_CONTEXT_INVALID').trim();
  const node = flow.nodes.find((item) => item.ref === nodeRef);
  if (!node) throw contractError('CASE_FLOW_CONTEXT_INVALID', `unknown Case Flow node ${nodeRef}`);
  if (context.selectedEdgeRef === undefined) return { nodeRef };
  const selectedEdgeRef = ensureString(context.selectedEdgeRef, 'flowContext.selectedEdgeRef', 'CASE_FLOW_CONTEXT_INVALID').trim();
  const edge = flow.edges.find((item) => item.ref === selectedEdgeRef);
  if (!edge || node.type !== 'DECISION' || edge.from !== nodeRef) {
    throw contractError('CASE_FLOW_CONTEXT_INVALID', `edge ${selectedEdgeRef} is not a branch from DECISION ${nodeRef}`);
  }
  return { nodeRef, selectedEdgeRef };
}

module.exports = {
  baseline,
  checkpointRegistry,
  commitRevision,
  current,
  currentRevision,
  history,
  matchingRevision,
  prepareRevision,
  revise,
  validateFlowContext,
};
