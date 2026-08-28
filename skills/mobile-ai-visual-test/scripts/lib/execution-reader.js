'use strict';

const fs = require('fs');
const path = require('path');
const { completionDisplayResult, validatePublishedCompletion } = require('./completion-contract');
const { validateResultKnowledgeSnapshots } = require('./knowledge-snapshot');

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function executionSchemaFamily(execution, result) {
  if (execution?.schemaVersion === 3 && result?.schemaVersion === 2) return 'current';
  const error = new Error(`Unsupported execution/result schema combination: execution=${execution?.schemaVersion ?? 'missing'}, result=${result?.schemaVersion ?? 'missing'}`);
  error.code = 'EXECUTION_SCHEMA_UNSUPPORTED';
  throw error;
}

function currentDisplayModel(result, metrics, execution) {
  return {
    status: result?.verdict || 'NOT_RUN',
    verdict: result?.verdict || null,
    executionStatus: result?.executionStatus || null,
    verdictBasis: result?.verdictBasis || null,
    summary: result?.summary || '',
    uncertainties: Array.isArray(result?.uncertainties) ? result.uncertainties : [],
    failureCode: result?.technicalFailureCode || null,
    failedStep: null,
    startedAt: result?.startedAt || execution?.startedAt || '',
    endedAt: result?.endedAt || execution?.endedAt || '',
    durationMs: metrics?.elapsedMs,
    stepsSummary: '-',
    metrics: metrics || null,
  };
}

function pendingCompletionDisplayModel(result, metrics, execution) {
  return {
    status: 'PENDING_PUBLICATION',
    verdict: null,
    requestedVerdict: result?.verdict || null,
    executionStatus: 'PENDING_PUBLICATION',
    verdictBasis: null,
    summary: '执行结果已生成，等待框架完成校验和发布',
    uncertainties: [],
    failureCode: null,
    failedStep: null,
    startedAt: execution?.startedAt || '',
    endedAt: execution?.endedAt || '',
    durationMs: metrics?.elapsedMs,
    stepsSummary: '-',
    metrics: metrics || null,
  };
}

function finalizationRecoveryDisplayModel(execution, metrics) {
  return {
    status: 'FINALIZATION_RECOVERY_REQUIRED',
    verdict: null,
    requestedVerdict: null,
    executionStatus: 'FINALIZATION_RECOVERY_REQUIRED',
    verdictBasis: null,
    summary: '执行收尾中断，等待框架从冻结草稿恢复',
    uncertainties: [],
    failureCode: 'RESUME_FINALIZE',
    failedStep: null,
    startedAt: execution?.startedAt || '',
    endedAt: '',
    durationMs: metrics?.elapsedMs,
    stepsSummary: '-',
    metrics: metrics || null,
  };
}

function invalidCompletionResult(result, message) {
  return {
    ...result,
    requestedVerdict: result?.verdict || null,
    verdict: 'BLOCKED',
    executionStatus: 'TECHNICALLY_BLOCKED',
    verdictBasis: 'TECHNICAL_CONSTRAINT',
    summary: `完成态校验失败，业务结果未发布：${message}`,
    technicalFailureCode: 'EXECUTION_COMPLETION_INVALID',
  };
}

function emptyExecutionReport(execDir = null) {
  return {
    latest: execDir,
    schemaFamily: null,
    execution: null,
    snapshot: null,
    sourceText: '',
    understanding: null,
    plan: null,
    rawResult: null,
    result: null,
    metrics: null,
    events: [],
    completion: null,
    completionError: null,
    display: null,
  };
}

function executionSelection(execDir) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (execution?.schemaVersion !== 3) return null;
  const result = readJson(path.join(execDir, 'result.json'), null);
  const completion = readJson(path.join(execDir, 'completion.json'), null);
  let priority = 1;
  let state = 'ACTIVE';
  if (execution.finalized !== true) {
    priority = 4;
    state = execution.lifecycle === 'FINALIZING' || fs.existsSync(path.join(execDir, 'finalization.draft.json'))
      ? 'FINALIZATION_RECOVERY_REQUIRED' : 'ACTIVE';
  }
  else if (execution.finalized === true && result && !completion) { priority = 3; state = 'FINALIZED_PENDING_COMPLETION'; }
  else if (completion) { priority = 2; state = 'PUBLISHED'; }
  const time = Date.parse(execution?.endedAt || execution?.startedAt || 0) || fs.statSync(execDir).mtimeMs;
  return { execDir, execution, result, completion, priority, state, time };
}

function selectExecutionDir(runtimeDir) {
  const root = path.join(runtimeDir, 'executions');
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root).filter((name) => !name.startsWith('.')).map((name) => path.join(root, name))
    .filter((execDir) => fs.statSync(execDir).isDirectory() && fs.existsSync(path.join(execDir, 'execution.json')))
    .map(executionSelection).filter(Boolean)
    .sort((left, right) => right.priority - left.priority || right.time - left.time || right.execDir.localeCompare(left.execDir))[0] || null;
}

function readExecutionReport(execDir) {
  if (!execDir) return emptyExecutionReport();
  const report = emptyExecutionReport(execDir);
  report.execution = readJson(path.join(execDir, 'execution.json'), null);
  report.snapshot = readJson(path.join(execDir, 'case.snapshot.json'), null);
  report.rawResult = readJson(path.join(execDir, 'result.json'), null);
  report.metrics = readJson(path.join(execDir, 'metrics.json'), null);
  report.completion = readJson(path.join(execDir, 'completion.json'), null);
  report.events = readJsonl(path.join(execDir, 'timeline.jsonl'));
  const finalizationPending = report.execution?.schemaVersion === 3
    && report.execution.finalized !== true
    && (report.execution.lifecycle === 'FINALIZING' || fs.existsSync(path.join(execDir, 'finalization.draft.json')));
  if (finalizationPending) {
    report.schemaFamily = 'current';
    report.finalizationPending = true;
    const sourcePath = path.join(execDir, 'source.snapshot.md');
    report.sourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
    report.understanding = readJson(path.join(execDir, 'understanding.json'), null);
    report.plan = readJson(path.join(execDir, 'plan.json'), null);
    report.display = finalizationRecoveryDisplayModel(report.execution, report.metrics);
    return report;
  }
  if (!report.rawResult) {
    if (report.execution?.schemaVersion === 3) {
      report.schemaFamily = 'current';
      const sourcePath = path.join(execDir, 'source.snapshot.md');
      report.sourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
      report.understanding = readJson(path.join(execDir, 'understanding.json'), null);
      report.plan = readJson(path.join(execDir, 'plan.json'), null);
      report.display = {
        status: 'RUNNING', verdict: null, executionStatus: 'RUNNING', verdictBasis: null,
        summary: '用例执行中', uncertainties: [], failureCode: null, failedStep: null,
        startedAt: report.execution.startedAt || '', endedAt: '', durationMs: null, stepsSummary: '-', metrics: null,
      };
    }
    return report;
  }
  report.schemaFamily = executionSchemaFamily(report.execution, report.rawResult);
  const sourcePath = path.join(execDir, 'source.snapshot.md');
  report.sourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
  report.understanding = readJson(path.join(execDir, 'understanding.json'), null);
  report.plan = readJson(path.join(execDir, 'plan.json'), null);
  if (report.execution?.batchId && report.execution.finalized === true && report.metrics && !report.completion) {
    try {
      validateResultKnowledgeSnapshots(execDir, report.rawResult, report.events);
    } catch (error) {
      report.completionError = error.message || String(error);
      report.result = invalidCompletionResult(report.rawResult, report.completionError);
      report.display = currentDisplayModel(report.result, report.metrics, report.execution);
      return report;
    }
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
      report.result = completionDisplayResult(report.rawResult, report.completion);
    } catch (error) {
      report.completionError = error.message || String(error);
      report.result = invalidCompletionResult(report.rawResult, report.completionError);
      report.completion = null;
      if (/EXECUTION_ARTIFACT_/.test(report.completionError)) {
        report.sourceText = '';
        report.understanding = null;
        report.plan = null;
        report.events = [];
      }
    }
  }
  report.display = currentDisplayModel(report.result, report.metrics, report.execution);
  return report;
}

module.exports = {
  currentDisplayModel,
  emptyExecutionReport,
  executionSchemaFamily,
  finalizationRecoveryDisplayModel,
  pendingCompletionDisplayModel,
  readExecutionReport,
  selectExecutionDir,
};
