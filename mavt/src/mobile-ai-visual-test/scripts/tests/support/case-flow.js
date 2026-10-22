'use strict';

function simpleCaseFlow(summary, checkText, options = {}) {
  return {
    baseRevision: options.baseRevision ?? null,
    summary,
    entryNodeRef: 'N1',
    nodes: [
      { ref: 'N1', type: 'ACTION', text: options.actionText || '观察并建立目标业务状态' },
      {
        ref: 'N2', type: 'CHECK', text: checkText,
        verificationKind: options.verificationKind || 'DIRECT_OBSERVATION',
        sourceBasis: options.sourceBasis || '原始用例预期',
        requirement: options.requirement || 'REQUIRED',
        ...(options.requirement === 'CONDITIONAL' ? { applicability: options.applicability || '原始用例声明的条件成立' } : {}),
      },
      { ref: 'N3', type: 'END', text: '用例完成' },
    ],
    edges: [
      { ref: 'L1', from: 'N1', to: 'N2' },
      { ref: 'L2', from: 'N2', to: 'N3' },
    ],
    uncertainties: options.uncertainties || [],
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

module.exports = { simpleCaseFlow };
