'use strict';

const fs = require('fs');
const path = require('path');
const { buildContract } = require('../build-agent-contract');
const { validatePublishedCompletion } = require('./completion-contract');
const { referencedTechnicalFacts } = require('./technical-facts');
const { deriveExecutionTiming } = require('./execution-timing');
const currentExecution = require('./readers/current-execution');

const currentContracts = new Map();

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function currentContract(platform, skillRoot = path.resolve(__dirname, '../..')) {
  const key = `${skillRoot}\0${platform}`;
  if (!currentContracts.has(key)) {
    currentContracts.set(key, buildContract({ skillRoot, role: 'case-executor', platform }));
  }
  return currentContracts.get(key);
}

function assertExecutionSchema(execution) {
  return currentExecution.assertSchema(execution);
}

function readerFor(execution) {
  assertExecutionSchema(execution);
  return currentExecution;
}

function assertCurrentExecution(execution, options = {}) {
  assertExecutionSchema(execution);
  let contract;
  try {
    contract = options.contract || currentContract(execution.platform, options.skillRoot);
  } catch (cause) {
    const error = new Error(`This execution uses an unsupported platform or protocol and must be run again: ${cause.message || cause}`);
    error.code = 'AGENT_PROTOCOL_MISMATCH';
    throw error;
  }
  if (execution.caseProtocolSha !== contract.protocolSha || execution.runtimeSha !== contract.runtimeSha) {
    const error = new Error('This execution does not match the current Case Agent protocol or Runtime and must be run again');
    error.code = 'AGENT_PROTOCOL_MISMATCH';
    throw error;
  }
  return execution;
}

function assertReadableCompletedExecution(execution) {
  return assertExecutionSchema(execution);
}

function timingPublication(execDir, execution) {
  if (!execution?.batchId) return null;
  const workspaceRoot = path.resolve(execDir, '../../../../../..');
  let sidecar;
  try {
    sidecar = readJson(path.join(workspaceRoot, 'runs', execution.batchId, 'report-publication.json'), null);
  } catch {
    return null;
  }
  return sidecar?.caseTimings?.[execution.executionId] || sidecar?.publications?.[execution.executionId] || null;
}

function displayTiming(execution, metrics, publication = null) {
  const timing = deriveExecutionTiming(execution, metrics, publication);
  return {
    startedAt: timing.startedAt,
    durationMs: timing.durationMs,
    durationBasis: timing.durationBasis,
    phaseDurations: timing.phases,
  };
}

function currentDisplayModel(result, metrics, execution, events = [], publication = null) {
  const evidenceBacked = (result?.checks || []).some((check) => (check.sceneRefs || []).length > 0);
  const technicalFact = referencedTechnicalFacts(result, events, execution).at(-1) || null;
  const verdictBasis = result?.verdict === 'BLOCKED'
    ? (technicalFact ? 'TECHNICAL_CONSTRAINT' : 'INSUFFICIENT_EVIDENCE')
    : result?.verdict === 'INCONCLUSIVE' && !evidenceBacked ? 'INSUFFICIENT_EVIDENCE' : 'DIRECT_EVIDENCE';
  return {
    status: result?.verdict || 'NOT_RUN',
    verdict: result?.verdict || null,
    executionStatus: metrics?.executionStatus || execution?.executionStatus || null,
    verdictBasis,
    summary: result?.summary || '',
    uncertainties: Array.isArray(result?.uncertainties) ? result.uncertainties : [],
    failureCode: technicalFact?.code || null,
    failedStep: null,
    ...displayTiming(execution, metrics, publication),
    endedAt: execution?.endedAt || '',
    stepsSummary: '-',
    metrics: metrics || null,
  };
}

function pendingCompletionDisplayModel(result, metrics, execution) {
  return {
    status: 'PENDING_PUBLICATION', verdict: null, requestedVerdict: result?.verdict || null,
    executionStatus: 'PENDING_PUBLICATION', verdictBasis: null,
    summary: '执行结果已生成，等待框架完成校验和发布', uncertainties: [],
    failureCode: null, failedStep: null,
    ...displayTiming(execution, metrics), endedAt: execution?.endedAt || '',
    stepsSummary: '-', metrics: metrics || null,
  };
}

function finalizationRecoveryDisplayModel(execution, metrics) {
  return {
    status: 'FINALIZATION_RECOVERY_REQUIRED', verdict: null, requestedVerdict: null,
    executionStatus: 'FINALIZATION_RECOVERY_REQUIRED', verdictBasis: null,
    summary: '执行收尾中断，等待框架从冻结草稿恢复', uncertainties: [],
    failureCode: 'RESUME_FINALIZE', failedStep: null,
    ...displayTiming(execution, metrics), endedAt: '',
    stepsSummary: '-', metrics: metrics || null,
  };
}

function invalidCompletionDisplayModel(result, metrics, execution, message) {
  return {
    requestedVerdict: result?.verdict || null,
    status: 'BLOCKED',
    verdict: 'BLOCKED',
    executionStatus: 'TECHNICALLY_BLOCKED',
    verdictBasis: 'TECHNICAL_CONSTRAINT',
    summary: `完成态校验失败，业务结果未发布：${message}`,
    uncertainties: [],
    failureCode: 'EXECUTION_COMPLETION_INVALID',
    failedStep: null,
    ...displayTiming(execution, metrics),
    endedAt: execution?.endedAt || '',
    stepsSummary: '-',
    metrics: metrics || null,
  };
}

function emptyExecutionReport(execDir = null) {
  return {
    latest: execDir, readability: null, schemaFamily: null, execution: null, snapshot: null, sourceText: '',
    rawResult: null, result: null, metrics: null, events: [], completion: null,
    completionError: null, display: null,
  };
}

function executionSelection(execDir, workspaceRoot = null) {
  let execution;
  try {
    execution = readJson(path.join(execDir, 'execution.json'), null);
  } catch (error) {
    return {
      execDir,
      execution: null,
      result: null,
      completion: null,
      closure: null,
      priority: -1,
      state: 'DATA_INVALID',
      readability: 'DATA_INVALID',
      errorCode: 'REPORT_DATA_INVALID',
      reason: error.message || String(error),
      time: fs.statSync(execDir).mtimeMs,
    };
  }
  if (!currentExecution.supports(execution)) {
    const time = Date.parse(execution?.endedAt || execution?.startedAt || 0) || fs.statSync(execDir).mtimeMs;
    return {
      execDir,
      execution,
      result: null,
      completion: null,
      closure: null,
      priority: -1,
      state: 'FORMAT_UNSUPPORTED',
      readability: 'FORMAT_UNSUPPORTED',
      errorCode: 'FORMAT_UNSUPPORTED',
      reason: '历史结果格式不支持，需要重跑',
      time,
    };
  }
  const closure = workspaceRoot && execution.finalized !== true
    ? require('./execution-closure').readExecutionClosure(workspaceRoot, execDir, execution)
    : null;
  const result = readJson(path.join(execDir, 'result.json'), null);
  const completion = readJson(path.join(execDir, 'completion.json'), null);
  let priority = 1;
  let state = 'ACTIVE';
  if (execution.status === 'CANCELLED') { priority = 3; state = 'CANCELLED'; }
  else if (closure) { priority = 0; state = 'ABANDONED'; }
  else if (execution.finalized !== true) {
    priority = 4;
    state = execution.lifecycle === 'FINALIZING' || fs.existsSync(path.join(execDir, 'transactions', 'finish.draft.json'))
      ? 'FINALIZATION_RECOVERY_REQUIRED' : 'ACTIVE';
  } else if (result && !completion) { priority = 3; state = 'FINALIZED_PENDING_COMPLETION'; }
  else if (completion) { priority = 2; state = 'PUBLISHED'; }
  const time = Date.parse(execution.endedAt || execution.startedAt || 0) || fs.statSync(execDir).mtimeMs;
  return { execDir, execution, result, completion, closure, priority, state, readability: 'READABLE', time };
}

function selectExecutionDir(runtimeDir) {
  const root = path.join(runtimeDir, 'executions');
  if (!fs.existsSync(root)) return null;
  const workspaceRoot = path.resolve(runtimeDir, '../../../..');
  const candidates = fs.readdirSync(root).filter((name) => !name.startsWith('.')).map((name) => path.join(root, name))
    .filter((execDir) => fs.statSync(execDir).isDirectory() && fs.existsSync(path.join(execDir, 'execution.json')))
    .map((execDir) => executionSelection(execDir, workspaceRoot)).filter(Boolean);
  const selected = candidates.filter((candidate) => candidate.readability === 'READABLE')
    .sort((left, right) => Number(right.state !== 'ABANDONED') - Number(left.state !== 'ABANDONED')
      || right.time - left.time || right.priority - left.priority || right.execDir.localeCompare(left.execDir))[0] || null;
  const newestUnavailable = candidates.filter((candidate) => candidate.readability !== 'READABLE')
    .sort((left, right) => right.time - left.time || right.execDir.localeCompare(left.execDir))[0] || null;
  return newestUnavailable && (!selected || newestUnavailable.time > selected.time) ? newestUnavailable : selected;
}

function unavailableExecutionReport(selection) {
  const report = emptyExecutionReport(selection.execDir);
  const execution = selection.execution && typeof selection.execution === 'object'
    ? {
      schemaVersion: selection.execution.schemaVersion,
      executionId: selection.execution.executionId || path.basename(selection.execDir),
      platform: selection.execution.platform || null,
      startedAt: selection.execution.startedAt || '',
      endedAt: selection.execution.endedAt || '',
      finalized: selection.execution.finalized === true,
    }
    : { executionId: path.basename(selection.execDir), platform: null, startedAt: '', endedAt: '' };
  report.readability = selection.readability;
  report.schemaFamily = selection.readability === 'FORMAT_UNSUPPORTED' ? 'unsupported' : 'invalid';
  report.execution = execution;
  report.display = {
    status: selection.readability === 'FORMAT_UNSUPPORTED' ? 'NEEDS_RERUN' : 'REPORT_DATA_INVALID',
    verdict: null,
    executionStatus: null,
    verdictBasis: null,
    summary: selection.readability === 'FORMAT_UNSUPPORTED'
      ? '历史结果格式不支持，需要重跑'
      : `当前执行数据损坏：${selection.reason || '无法读取 execution.json'}`,
    uncertainties: [],
    failureCode: selection.errorCode,
    failedStep: null,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    durationMs: null,
    durationBasis: 'EXECUTION_TOTAL',
    phaseDurations: null,
    stepsSummary: '-',
    metrics: null,
  };
  return report;
}

function readExecutionReport(execDir) {
  if (!execDir) return emptyExecutionReport();
  const selection = executionSelection(execDir);
  if (selection.readability !== 'READABLE') return unavailableExecutionReport(selection);
  const report = emptyExecutionReport(execDir);
  try {
    const execution = selection.execution;
    const completion = readJson(path.join(execDir, 'completion.json'), null);
    const reader = readerFor(execution);
    report.execution = execution?.finalized === true && completion
      ? assertReadableCompletedExecution(execution)
      : assertCurrentExecution(execution);
    report.readability = 'READABLE';
    report.schemaFamily = 'current';
    report.readerFamily = reader.READER_FAMILY;
    report.snapshot = readJson(path.join(execDir, 'case.snapshot.json'), null);
    report.rawResult = readJson(path.join(execDir, 'result.json'), null);
    report.metrics = readJson(path.join(execDir, 'metrics.json'), null);
    report.completion = completion;
    report.events = readJsonl(path.join(execDir, 'events.jsonl'));
    report.closure = require('./execution-closure').executionClosureForDir(execDir);
    const sourcePath = path.join(execDir, 'source.snapshot.md');
    report.sourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
  } catch (error) {
    return unavailableExecutionReport({
      ...selection,
      readability: 'DATA_INVALID',
      errorCode: error.code || 'REPORT_DATA_INVALID',
      reason: error.message || String(error),
    });
  }

  if (!report.rawResult) {
    const cancelled = report.execution.status === 'CANCELLED';
    report.display = {
      status: cancelled ? 'CANCELLED' : report.closure ? 'ABANDONED' : 'RUNNING', verdict: null,
      executionStatus: cancelled ? 'CANCELLED' : report.closure ? 'INTERRUPTED' : 'RUNNING', verdictBasis: null,
      summary: cancelled ? `执行已取消：${report.execution.cancellation?.reason || '用户取消'}`
        : report.closure ? '执行因实现变更被废弃，未形成测试结论' : '用例执行中',
      uncertainties: [], failureCode: cancelled ? null : report.closure?.reasonCode || null, failedStep: null,
      ...displayTiming(report.execution, report.metrics), endedAt: report.execution.endedAt || '', stepsSummary: '-', metrics: null,
    };
    return report;
  }

  if (report.execution.finalized !== true) {
    report.finalizationPending = true;
    report.display = finalizationRecoveryDisplayModel(report.execution, report.metrics);
    return report;
  }
  if (report.execution.batchId && report.metrics && !report.completion) {
    report.pendingCompletion = true;
    report.display = pendingCompletionDisplayModel(report.rawResult, report.metrics, report.execution);
    return report;
  }

  report.result = report.rawResult;
  if (report.completion) {
    try {
      validatePublishedCompletion(execDir, report.completion, {
        execution: report.execution,
        snapshot: report.snapshot,
        result: report.rawResult,
        metrics: report.metrics,
      });
      report.result = report.rawResult;
    } catch (error) {
      report.completionError = error.message || String(error);
      report.result = null;
      report.display = invalidCompletionDisplayModel(report.rawResult, report.metrics, report.execution, report.completionError);
      report.completion = null;
      if (/EXECUTION_ARTIFACT_/.test(report.completionError)) {
        report.sourceText = '';
        report.events = [];
      }
      return report;
    }
  }
  report.display = currentDisplayModel(report.result, report.metrics, report.execution, report.events, timingPublication(execDir, report.execution));
  return report;
}

module.exports = {
  assertCurrentExecution,
  assertReadableCompletedExecution,
  currentDisplayModel,
  emptyExecutionReport,
  finalizationRecoveryDisplayModel,
  pendingCompletionDisplayModel,
  readExecutionReport,
  executionSelection,
  selectExecutionDir,
};
