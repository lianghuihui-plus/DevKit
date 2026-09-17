'use strict';

const { contractError, ensureArray, ensureObject, ensureString } = require('../lib/contract-utils');
const store = require('./store');

const NODE_TYPES = new Set(['ACTION', 'DECISION', 'CHECK', 'END']);
const VERIFICATION_KINDS = new Set(['DIRECT_OBSERVATION', 'SEARCH_EXISTENCE']);

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
    const allowed = new Set(['ref', 'type', 'text', ...(type === 'CHECK' ? ['verificationKind', 'sourceBasis'] : []),
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
    }
    return node;
  });
  if (!nodes.some((node) => node.type === 'CHECK')) {
    throw contractError('CASE_FLOW_INVALID', 'Case Flow must contain at least one CHECK node');
  }
  if (!nodes.some((node) => node.type === 'END')) {
    throw contractError('CASE_FLOW_INVALID', 'Case Flow must contain at least one END node');
  }
  return nodes;
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

function prepareRevision(execDir, value) {
  const input = ensureObject(value, 'caseFlow', 'CASE_FLOW_INVALID');
  const allowed = new Set(['baseRevision', 'summary', 'entryNodeRef', 'nodes', 'edges', 'uncertainties', 'reason']);
  const unsupported = Object.keys(input).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('CASE_FLOW_INVALID', `caseFlow contains unsupported fields: ${unsupported.join(', ')}`);
  const events = history(execDir);
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
  const entryNodeRef = ensureString(input.entryNodeRef, 'entryNodeRef', 'CASE_FLOW_INVALID').trim();
  validateGraph(entryNodeRef, nodes, edges);
  const activeNodeRefs = new Set(nodes.map((node) => node.ref));
  const activeEdgeRefs = new Set(edges.map((edge) => edge.ref));
  const newlyRetiredNodeRefs = (previous?.nodes || []).map((node) => node.ref).filter((ref) => !activeNodeRefs.has(ref));
  const newlyRetiredEdgeRefs = (previous?.edges || []).map((edge) => edge.ref).filter((ref) => !activeEdgeRefs.has(ref));
  return {
    previous,
    newlyRetiredNodeRefs,
    newlyRetiredEdgeRefs,
    event: {
      revision: events.length + 1,
      reason: previous ? String(input.reason).trim() : 'INITIAL_CASE_FLOW',
      basedOnSceneRef: store.readCurrentScene(execDir)?.sceneId || null,
      summary: ensureString(input.summary, 'summary', 'CASE_FLOW_INVALID').trim(),
      entryNodeRef,
      nodes,
      edges,
      uncertainties: strings(input.uncertainties, 'uncertainties'),
      retiredNodeRefs: [...new Set([...(previous?.retiredNodeRefs || []), ...newlyRetiredNodeRefs])],
      retiredEdgeRefs: [...new Set([...(previous?.retiredEdgeRefs || []), ...newlyRetiredEdgeRefs])],
    },
  };
}

function commitRevision(execDir, prepared, options = {}) {
  const existing = options.submissionId
    ? history(execDir).find((event) => event.submissionId === options.submissionId)
    : null;
  const event = existing || store.appendEvent(execDir, 'caseFlowRevised', {
    ...prepared.event,
    submissionId: options.submissionId || null,
  }, options);
  const previous = prepared.previous || history(execDir).filter((item) => item.sequence < event.sequence).at(-1) || null;
  const invalidatedResultRefs = require('./expectation-result-service')
    .invalidateForCaseFlowChange(execDir, previous, event, options);
  return {
    status: 'CASE_FLOW_RECORDED',
    caseFlow: event,
    caseFlowChange: {
      revision: event.revision,
      retiredNodeRefs: prepared.newlyRetiredNodeRefs || [],
      retiredEdgeRefs: prepared.newlyRetiredEdgeRefs || [],
      invalidatedResultRefs,
    },
  };
}

function revise(execDir, value, options = {}) {
  return commitRevision(execDir, prepareRevision(execDir, value), options);
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

module.exports = { commitRevision, current, currentRevision, history, prepareRevision, revise, validateFlowContext };
