'use strict';

function checkRef(check) {
  return check?.checkNodeRef || check?.expectationRef || null;
}

function flowEvents(report) {
  return (report?.events || []).filter((event) => event.type === 'caseFlowRevised')
    .slice().sort((left, right) => (left.sequence || left.revision || 0) - (right.sequence || right.revision || 0));
}

function resultFromUpdate(event) {
  return {
    status: event.status,
    actual: event.actual || '',
    reason: event.reason || '',
    sceneRefs: event.evidence?.sceneRefs || [],
    knowledgeRefs: event.evidence?.knowledgeRefs || [],
    technicalRefs: event.evidence?.technicalRefs || [],
  };
}

function checkpointResults(report) {
  const events = report?.events || [];
  const invalidated = new Set(events.filter((event) => event.type === 'expectationResultInvalidated')
    .map((event) => event.resultUpdateId).filter(Boolean));
  const results = new Map();
  for (const event of events.filter((item) => item.type === 'expectationResultUpdated')
    .slice().sort((left, right) => (left.sequence || 0) - (right.sequence || 0))) {
    if (!invalidated.has(event.resultUpdateId)) results.set(event.expectationRef, resultFromUpdate(event));
  }
  for (const check of report?.result?.checks || report?.rawResult?.checks || []) {
    const ref = checkRef(check);
    if (ref) results.set(ref, check);
  }
  return results;
}

function projectCheckpointLedger(report, flows) {
  const workingRefs = new Set((flows.at(-1)?.nodes || []).filter((node) => node.type === 'CHECK').map((node) => node.ref));
  const registry = new Map();
  for (const flow of flows) {
    for (const node of (flow.nodes || []).filter((item) => item.type === 'CHECK')) {
      if (!registry.has(node.ref)) {
        registry.set(node.ref, {
          checkpointRef: node.ref,
          text: node.text,
          sourceBasis: node.sourceBasis || '',
          verificationKind: node.verificationKind || 'DIRECT_OBSERVATION',
          requirement: node.requirement || 'UNKNOWN',
          applicability: node.applicability || null,
          introducedRevision: flow.revision,
          baseline: flow.revision === flows[0]?.revision,
        });
      }
    }
  }
  const results = checkpointResults(report);
  return [...registry.values()].map((item) => {
    const result = results.get(item.checkpointRef) || null;
    const retired = flows.find((flow) => flow.revision > item.introducedRevision
      && !(flow.nodes || []).some((node) => node.type === 'CHECK' && node.ref === item.checkpointRef));
    return {
      ...item,
      active: workingRefs.has(item.checkpointRef),
      closureRequired: item.baseline || workingRefs.has(item.checkpointRef),
      ...(retired ? { retiredRevision: retired.revision } : {}),
      disposition: result?.status || 'NOT_ASSESSED',
      actual: result?.actual || '',
      reason: result?.reason || '',
      sceneRefs: result?.sceneRefs || [],
      knowledgeRefs: result?.knowledgeRefs || [],
      technicalRefs: result?.technicalRefs || [],
    };
  });
}

function projectDecisionTrace(report, baselineFlow, ledger) {
  const baselineRefs = new Set((baselineFlow?.nodes || []).map((node) => node.ref));
  const checkpointRefs = new Set(ledger.map((item) => item.checkpointRef));
  const flowContextByDecision = new Map((report?.events || [])
    .filter((event) => event.type === 'flowContextRecorded' && event.decisionId)
    .map((event) => [event.decisionId, event]));
  const nodes = [];
  for (const event of (report?.events || []).filter((item) => item.type === 'agentDecisionRecorded')
    .slice().sort((left, right) => (left.sequence || 0) - (right.sequence || 0))) {
    const flowNodeRef = flowContextByDecision.get(event.decisionId)?.nodeRef || event.flowContext?.nodeRef || null;
    const purpose = event.decision?.purpose || event.requestedOperation || 'Agent 决策';
    const groupingKey = `${event.requestedOperation || ''}\0${purpose}\0${flowNodeRef || ''}`;
    const previous = nodes.at(-1);
    if (previous?.groupingKey === groupingKey) {
      previous.attemptCount += 1;
      previous.decisionIds.push(event.decisionId);
      previous.lastSequence = event.sequence;
      continue;
    }
    nodes.push({
      ref: `T${nodes.length + 1}`,
      groupingKey,
      decisionIds: [event.decisionId],
      decisionId: event.decisionId,
      sequence: event.sequence,
      lastSequence: event.sequence,
      operation: event.requestedOperation || 'decision',
      purpose,
      flowNodeRef,
      baselineNodeRef: flowNodeRef && baselineRefs.has(flowNodeRef) ? flowNodeRef : null,
      checkpointRef: flowNodeRef && checkpointRefs.has(flowNodeRef) ? flowNodeRef : null,
      adaptation: Boolean(flowNodeRef && !baselineRefs.has(flowNodeRef)),
      attemptCount: 1,
    });
  }
  return {
    nodes: nodes.map(({ groupingKey, ...node }) => node),
    edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].ref, to: node.ref })),
  };
}

function projectCaseFlowViews(report) {
  const flows = flowEvents(report);
  const baselineFlow = flows[0] || null;
  const workingFlow = flows.at(-1) || null;
  const checkpointLedger = projectCheckpointLedger(report, flows);
  const executionTrace = projectDecisionTrace(report, baselineFlow, checkpointLedger);
  const closureLedger = checkpointLedger.filter((item) => item.closureRequired);
  const covered = closureLedger.filter((item) => item.disposition !== 'NOT_ASSESSED').length;
  const dispositionCounts = Object.fromEntries(
    ['PASS', 'FAIL', 'NOT_APPLICABLE', 'WAIVED', 'INCONCLUSIVE', 'BLOCKED', 'NOT_ASSESSED']
      .map((status) => [status, closureLedger.filter((item) => item.disposition === status).length]),
  );
  const waivers = closureLedger.filter((item) => item.disposition === 'WAIVED');
  const mappedTraceNodes = executionTrace.nodes.filter((item) => item.baselineNodeRef).length;
  return {
    baselineFlow,
    workingFlow,
    checkpointLedger,
    executionTrace,
    coverage: {
      total: closureLedger.length,
      registryTotal: checkpointLedger.length,
      retiredSupplemental: checkpointLedger.filter((item) => !item.baseline && !item.active).length,
      covered,
      required: closureLedger.filter((item) => item.requirement === 'REQUIRED').length,
      conditional: closureLedger.filter((item) => item.requirement === 'CONDITIONAL').length,
      waived: dispositionCounts.WAIVED,
      notApplicable: dispositionCounts.NOT_APPLICABLE,
      dispositions: dispositionCounts,
      passWithWaivers: report?.display?.verdict === 'PASS' && dispositionCounts.WAIVED > 0,
      waiverSupport: {
        knowledge: waivers.filter((item) => item.knowledgeRefs.length > 0).length,
        scene: waivers.filter((item) => item.sceneRefs.length > 0).length,
        technical: waivers.filter((item) => item.technicalRefs.length > 0).length,
      },
      baselineNodes: baselineFlow?.nodes?.length || 0,
      traceNodes: executionTrace.nodes.length,
      adaptations: executionTrace.nodes.filter((item) => item.adaptation).length,
      mappedTraceNodes,
      baselineMappingRate: executionTrace.nodes.length ? mappedTraceNodes / executionTrace.nodes.length : null,
    },
  };
}

function mermaidId(value, prefix) {
  return `${prefix}${String(value || '').replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function mermaidText(value, maxLength = 72) {
  const text = String(value || '').replace(/%%\{/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\[\]{}]/g, '');
}

function flowMermaid(flow, ledger = [], direction = 'TB') {
  if (!flow) return '';
  const statusByRef = new Map(ledger.map((item) => [item.checkpointRef, item.disposition]));
  const lines = [`flowchart ${direction === 'LR' ? 'LR' : 'TB'}`];
  for (const node of flow.nodes || []) {
    const id = mermaidId(node.ref, 'F_');
    const status = statusByRef.get(node.ref);
    const label = mermaidText(`${node.ref} · ${node.text}${status ? ` · ${status}` : ''}`);
    if (node.type === 'DECISION') lines.push(`  ${id}{"${label}"}`);
    else if (node.type === 'END') lines.push(`  ${id}(["${label}"])`);
    else if (node.type === 'CHECK') lines.push(`  ${id}[["${label}"]]`);
    else lines.push(`  ${id}["${label}"]`);
    lines.push(`  class ${id} type_${String(node.type || 'ACTION').toLowerCase()}`);
    if (status) lines.push(`  class ${id} status_${String(status).toLowerCase()}`);
  }
  for (const edge of flow.edges || []) {
    const from = mermaidId(edge.from, 'F_');
    const to = mermaidId(edge.to, 'F_');
    lines.push(edge.condition
      ? `  ${from} -->|"${mermaidText(edge.condition, 48)}"| ${to}`
      : `  ${from} --> ${to}`);
  }
  lines.push('  classDef type_action fill:#ffffff,stroke:#8a98a5,color:#17212b');
  lines.push('  classDef type_decision fill:#f3f7f8,stroke:#0e6873,color:#17212b');
  lines.push('  classDef type_check fill:#eef8f4,stroke:#23845f,color:#17212b');
  lines.push('  classDef type_end fill:#f4f6f8,stroke:#6d7985,color:#17212b');
  lines.push('  classDef status_fail stroke:#b23b3b,stroke-width:3px');
  lines.push('  classDef status_waived stroke:#a96f13,stroke-width:3px,stroke-dasharray:5 3');
  lines.push('  classDef status_not_applicable stroke:#89949e,stroke-dasharray:4 3');
  return lines.join('\n');
}

module.exports = { flowMermaid, projectCaseFlowViews };
