'use strict';
function nativeCase(definition) {
  return {
    rendererVersion: 'mavt-case/1',
    case: definition.case,
    sourceText: definition.sourceText
  };
}
function nativeReport(source, artifacts, runtime) {
  const { report, trace, views } = source;
  return {
    rendererVersion: 'mavt-current/1',
    case: report.snapshot,
    report: {
      execution: report.execution,
      display: {
        ...report.display,
        status: runtime.displayStatus,
        executionStatus: runtime.executionStatus,
        ...(runtime.displayStatus === 'RESULT_MISSING' ? {
          summary: '执行已结束，但缺少有效结果'
        } : {})
      },
      sourceDisplay: report.display,
      metrics: report.metrics,
      sourceText: report.sourceText
    },
    trace,
    views,
    artifacts
  };
}
module.exports = {
  nativeCase,
  nativeReport
};
