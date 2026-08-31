'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { bindingSha, validateBatchContract, validateBinding } = require('../lib/batch-contract');
const { environmentAdapterArgs } = require('../lib/execution-environment');
const { inspectPng } = require('../lib/image-evidence');
const { isSafeRelativeArtifact, resolveArtifact, sha256File } = require('../lib/execution-evidence');
const { buildCoordinateAudit } = require('../lib/action-coordinate-audit');

const ACTION_ARGUMENTS = Object.freeze({
  type: '--type',
  x: '--x',
  y: '--y',
  text: '--text',
  mode: '--mode',
  fromX: '--from-x',
  fromY: '--from-y',
  toX: '--to-x',
  toY: '--to-y',
  durationMs: '--duration-ms',
  ms: '--ms',
  velocity: '--velocity',
  coordinateSource: '--coordinate-source',
});

function workspaceRootFromExecutionDir(execDir) {
  let root = path.resolve(execDir);
  for (let index = 0; index < 6; index += 1) root = path.dirname(root);
  return root;
}

function resolveTargetBinding(execDir, execution) {
  validateBinding(execution.targetBinding);
  if (bindingSha(execution.targetBinding) !== execution.targetBindingSha) {
    throw contractError('DEVICE_BINDING_CHANGED', 'execution target binding hash does not match');
  }
  const contractPath = path.join(workspaceRootFromExecutionDir(execDir), 'runs', execution.batchId, 'contract.json');
  let contract;
  try {
    contract = validateBatchContract(JSON.parse(fs.readFileSync(contractPath, 'utf8')));
  } catch (error) {
    throw contractError('DEVICE_BINDING_UNCONFIRMED', `frozen batch contract is unavailable or invalid: ${error.message}`);
  }
  if (contract.contractSha !== execution.batchContractSha
    || canonicalJson(contract.binding) !== canonicalJson(execution.targetBinding)) {
    throw contractError('DEVICE_BINDING_MISMATCH', 'execution target does not match the frozen batch binding');
  }
  return { ...execution.targetBinding };
}

function actionAdapterArgs(binding, action) {
  const args = environmentAdapterArgs(binding, 'action');
  for (const [field, flag] of Object.entries(ACTION_ARGUMENTS)) {
    // Only iOS uses the source to translate screenshot pixels into its Appium viewport.
    if (field === 'coordinateSource' && binding.platform !== 'ios') continue;
    if (action[field] !== undefined && action[field] !== null) args.push(flag, String(action[field]));
  }
  return args;
}

function observationAdapterArgs(binding, execDir, operationId) {
  return [...environmentAdapterArgs(binding, 'observe'), '--out', path.resolve(execDir), '--label', operationId];
}

function defaultRunner(command, args, options = {}) {
  const preAdapterDelayMs = Number.isInteger(options.preAdapterDelayMs) && options.preAdapterDelayMs > 0
    ? options.preAdapterDelayMs : 0;
  if (preAdapterDelayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, preAdapterDelayMs);
  }
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.max(1, options.timeoutMs - preAdapterDelayMs),
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function operationTimeoutMs(execution, now = new Date()) {
  const deadline = Date.parse(execution.startedAt) + (30 * 60 * 1000);
  return Math.max(1, deadline - new Date(now).getTime());
}

function parseAdapterOutput(result, kind) {
  if (result?.error) {
    throw contractError('DEVICE_ADAPTER_FAILED', `${kind} adapter could not run: ${result.error.message || result.error}`, {
      adapterDiagnostics: {
        status: result.status ?? null,
        signal: result.signal || null,
        stderr: String(result.stderr || '').trim().slice(0, 4000),
      },
    });
  }
  let value;
  try {
    value = JSON.parse(String(result?.stdout || '').trim());
  } catch (error) {
    if (result?.status !== 0) {
      const stderr = String(result?.stderr || '').trim();
      throw contractError('DEVICE_ADAPTER_FAILED', `${kind} adapter exited with ${result.status}${stderr ? `: ${stderr.slice(0, 1000)}` : ''}`, {
        adapterDiagnostics: {
          status: result.status ?? null,
          signal: result.signal || null,
          stderr: stderr.slice(0, 4000),
        },
      });
    }
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', `${kind} adapter did not return one JSON result`);
  }
  if (result.status !== 0 && value?.type !== (kind === 'ACTION' ? 'actionResult' : 'observation')) {
    throw contractError('DEVICE_ADAPTER_FAILED', String(result.stderr || `${kind} adapter exited with ${result.status}`).trim());
  }
  return value;
}

function assertResultBinding(result, binding, kind) {
  const expectedType = kind === 'ACTION' ? 'actionResult' : 'observation';
  if (!result || result.schemaVersion !== 1 || result.type !== expectedType || result.platform !== binding.platform) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', `${kind} adapter result identity is invalid`);
  }
  const label = kind === 'ACTION' ? 'action result' : 'observation';
  const expectedDevice = binding.deviceId;
  if (result.device?.id !== expectedDevice) throw contractError('DEVICE_RESULT_BINDING_MISMATCH', `${label} does not confirm the frozen device`);
  if (result.app?.appId !== binding.appId) throw contractError('DEVICE_RESULT_BINDING_MISMATCH', `${label} does not confirm the frozen App`);
  return result;
}

function validateObservationArtifacts(execDir, result) {
  const screenshot = result.artifacts?.screenshot || result.screenshot;
  if (!isSafeRelativeArtifact(screenshot)) throw contractError('OBSERVATION_SCREENSHOT_INVALID', 'observation requires a safe screenshot path');
  const screenshotPath = resolveArtifact(execDir, screenshot);
  if (!fs.existsSync(screenshotPath) || !fs.statSync(screenshotPath).isFile()) {
    throw contractError('OBSERVATION_SCREENSHOT_MISSING', `observation screenshot is missing: ${screenshot}`);
  }
  const metadata = inspectPng(screenshotPath);
  if (metadata.decodeStatus !== 'VALID') throw contractError('OBSERVATION_SCREENSHOT_INVALID', `observation screenshot is not a valid PNG: ${screenshot}`);
  for (const ref of [result.artifacts?.layout, ...(result.artifacts?.logs || [])].filter(Boolean)) {
    if (!isSafeRelativeArtifact(ref)) throw contractError('OBSERVATION_ARTIFACT_INVALID', `unsafe observation artifact path: ${ref}`);
    const file = resolveArtifact(execDir, ref);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw contractError('OBSERVATION_ARTIFACT_MISSING', `observation artifact is missing: ${ref}`);
  }
  return {
    ref: screenshot,
    sha256: sha256File(screenshotPath),
    width: metadata.width,
    height: metadata.height,
    usable: result.app?.inTargetApp === true,
  };
}

function invokeDeviceOperation(execDir, validated, kind, options = {}) {
  const { execution } = validated.context;
  const binding = resolveTargetBinding(execDir, execution);
  const skillRoot = path.resolve(__dirname, '../..');
  const command = path.join(skillRoot, 'scripts', 'platform', kind === 'ACTION' ? 'action.sh' : 'observe.sh');
  const args = kind === 'ACTION'
    ? actionAdapterArgs(binding, validated.action)
    : observationAdapterArgs(binding, execDir, validated.operationId);
  const runner = options.runner || defaultRunner;
  const preAdapterDelayMs = kind === 'OBSERVE' && validated.request?.purpose === 'POST_ACTION'
    ? Math.max(0, Number(options.preAdapterDelayMs) || 0) : 0;
  const adapterResult = parseAdapterOutput(runner(command, args, {
    timeoutMs: operationTimeoutMs(execution, options.now),
    kind,
    binding,
    preAdapterDelayMs,
  }), kind);
  assertResultBinding(adapterResult, binding, kind);
  if (kind === 'ACTION' && adapterResult.action !== validated.action.type) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'action adapter result does not match the requested action');
  }
  const coordinateAudit = kind === 'ACTION'
    ? buildCoordinateAudit(execDir, validated, adapterResult)
    : null;
  return {
    binding,
    adapterResult,
    ...(coordinateAudit ? { coordinateAudit } : {}),
    postActionSettleMs: preAdapterDelayMs,
    ...(kind === 'OBSERVE' ? { evidence: validateObservationArtifacts(execDir, adapterResult) } : {}),
  };
}

module.exports = {
  actionAdapterArgs,
  assertResultBinding,
  defaultRunner,
  invokeDeviceOperation,
  observationAdapterArgs,
  operationTimeoutMs,
  parseAdapterOutput,
  resolveTargetBinding,
  validateObservationArtifacts,
};
