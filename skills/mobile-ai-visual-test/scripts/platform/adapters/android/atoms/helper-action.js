#!/usr/bin/env node
'use strict';

const { swipeDurationMs } = require('../../../../lib/action-contract');
const {
  HelperActionOutcomeUnknown,
  HelperAuthenticationRejected,
  HelperUnavailableBeforeDispatch,
  performAction,
} = require('../lib/android-helper-client');
const {
  ensureAndroidHelperSession,
  reauthenticateAndroidHelperSession,
} = require('../lib/android-helper-session');
const { readSecureSession } = require('./helper-snapshot');

class HelperActionPreDispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code || 'ANDROID_HELPER_UNAVAILABLE_BEFORE_DISPATCH';
    this.exitCode = 20;
  }
}

function finitePoint(x, y) {
  return Number.isFinite(Number(x)) && Number(x) >= 0
    && Number.isFinite(Number(y)) && Number(y) >= 0;
}

function unsupported(reason) {
  return { supported: false, reason, steps: [], timeoutMs: 0 };
}

function helperActionTransaction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return unsupported('invalid action');
  const point = { x: Number(action.x), y: Number(action.y) };
  switch (action.type) {
    case 'tap':
    case 'toggle':
      return finitePoint(action.x, action.y)
        ? { supported: true, steps: [{ kind: 'rpc', cmd: 'tap', params: point }], timeoutMs: 3000 }
        : unsupported('tap coordinates are invalid');
    case 'doubleTap':
      if (!finitePoint(action.x, action.y)) return unsupported('double tap coordinates are invalid');
      if (action.intervalMs === undefined) {
        return { supported: true, steps: [{ kind: 'rpc', cmd: 'double_tap', params: point }], timeoutMs: 5000 };
      }
      if (!Number.isInteger(Number(action.intervalMs)) || Number(action.intervalMs) < 20 || Number(action.intervalMs) > 1000) {
        return unsupported('double tap interval is invalid');
      }
      return {
        supported: true,
        steps: [
          { kind: 'rpc', cmd: 'tap', params: point },
          { kind: 'wait', ms: Number(action.intervalMs) },
          { kind: 'rpc', cmd: 'tap', params: point },
        ],
        timeoutMs: Number(action.intervalMs) + 4000,
      };
    case 'longPress': {
      const duration = Number(action.durationMs);
      if (!finitePoint(action.x, action.y) || !Number.isInteger(duration) || duration < 500 || duration > 5000) {
        return unsupported('long press parameters are outside Helper limits');
      }
      return {
        supported: true,
        steps: [{ kind: 'rpc', cmd: 'long_press', params: { ...point, duration } }],
        timeoutMs: duration + 3000,
      };
    }
    case 'inputText': {
      if (typeof action.text !== 'string' || action.text.length === 0 || !['replace', 'append'].includes(action.mode)) {
        return unsupported('input text parameters are invalid');
      }
      const type = { kind: 'rpc', cmd: 'type', params: { text: action.text, append: action.mode === 'append' } };
      if (action.x === undefined && action.y === undefined) {
        return { supported: true, steps: [type], timeoutMs: 3000 };
      }
      if (!finitePoint(action.x, action.y)) return unsupported('input target coordinates are invalid');
      return {
        supported: true,
        steps: [{ kind: 'rpc', cmd: 'tap', params: point }, type],
        timeoutMs: 5000,
      };
    }
    case 'swipe': {
      let duration;
      try {
        duration = swipeDurationMs(action);
      } catch {
        return unsupported('swipe parameters are invalid');
      }
      if (duration < 50 || duration > 5000) return unsupported('swipe duration is outside Helper limits');
      return {
        supported: true,
        steps: [{
          kind: 'rpc', cmd: 'swipe', params: {
            x1: Number(action.fromX), y1: Number(action.fromY),
            x2: Number(action.toX), y2: Number(action.toY), duration,
          },
        }],
        timeoutMs: duration + 3500,
      };
    }
    case 'back':
    case 'home':
      return {
        supported: true,
        steps: [{ kind: 'rpc', cmd: 'global', params: { action: action.type } }],
        timeoutMs: 3000,
      };
    default:
      return unsupported('action type is not supported by Helper');
  }
}

function parseArgs(argv) {
  const values = {};
  const names = new Map([
    ['--session-state', 'sessionStatePath'],
    ['--action-json', 'actionJson'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || value === undefined || value.startsWith('--')) throw new Error(`invalid argument: ${argv[index] || 'missing'}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate argument: ${argv[index]}`);
    values[name] = value;
  }
  for (const name of ['sessionStatePath', 'actionJson', 'timeoutMs']) {
    if (!values[name]) throw new Error(`missing ${name}`);
  }
  values.timeoutMs = Number(values.timeoutMs);
  if (!Number.isInteger(values.timeoutMs) || values.timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  values.action = JSON.parse(values.actionJson);
  return values;
}

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function actionCoordinates(action) {
  if (['tap', 'toggle', 'doubleTap', 'longPress'].includes(action.type)
    || (action.type === 'inputText' && action.x !== undefined)) {
    return { dispatchedPoint: { x: Number(action.x), y: Number(action.y) } };
  }
  if (action.type === 'swipe') {
    return {
      dispatchedFrom: { x: Number(action.fromX), y: Number(action.fromY) },
      dispatchedTo: { x: Number(action.toX), y: Number(action.toY) },
    };
  }
  return {};
}

function actionResult(action, session, commandStatus, deviceStatus, elapsedMs, details = {}) {
  return {
    schemaVersion: 2,
    type: 'actionResult',
    platform: 'android',
    time: localIso(),
    device: { id: session?.deviceId || null },
    action: action.type,
    command: { status: commandStatus, transport: 'ANDROID_HELPER_HTTP', elapsedMs },
    deviceExecution: {
      status: deviceStatus,
      verification: commandStatus === 'ACCEPTED' ? 'REQUEST_ECHO' : 'NONE',
      ...(commandStatus === 'ACCEPTED' ? actionCoordinates(action) : {}),
      actualTouchPoint: null,
    },
    ...details,
  };
}

function preDispatch(error) {
  return new HelperActionPreDispatchError(error?.code, 'Android Helper action was unavailable before dispatch');
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcTimeoutMs(step) {
  if (step.cmd === 'double_tap') return 5000;
  if (step.cmd === 'long_press') return Number(step.params.duration) + 3000;
  if (step.cmd === 'swipe') return Number(step.params.duration) + 3500;
  return 3000;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const transaction = helperActionTransaction(options.action);
  if (!transaction.supported) throw new HelperActionPreDispatchError('ANDROID_HELPER_ACTION_UNSUPPORTED', transaction.reason);
  try {
    readSecureSession(options.sessionStatePath);
  } catch (error) {
    throw preDispatch(error);
  }
  const ensureSession = dependencies.ensureSession || ensureAndroidHelperSession;
  const reauthenticateSession = dependencies.reauthenticateSession || reauthenticateAndroidHelperSession;
  const send = dependencies.performAction || performAction;
  const wait = dependencies.sleep || sleepMs;
  const now = dependencies.now || Date.now;
  let session;
  try {
    session = await ensureSession({ sessionStatePath: options.sessionStatePath, kind: 'ACTION' });
  } catch (error) {
    if (error instanceof HelperAuthenticationRejected || error?.phase === 'AUTH_REJECTED') {
      try {
        session = await reauthenticateSession({ sessionStatePath: options.sessionStatePath, kind: 'ACTION' });
      } catch (repairError) {
        throw preDispatch(repairError);
      }
    } else {
      throw preDispatch(error);
    }
  }

  const startedAt = now();
  const deadline = startedAt + Math.min(options.timeoutMs, transaction.timeoutMs);
  let acceptedSteps = 0;
  for (const step of transaction.steps) {
    if (step.kind === 'wait') {
      try {
        await wait(step.ms);
      } catch {
        const failed = actionResult(options.action, session, 'ACCEPTED', 'FAILED', now() - startedAt, {
          failureCode: 'ANDROID_HELPER_ACTION_PARTIAL_FAILURE',
          message: 'Android Helper action transaction wait failed',
        });
        process.stdout.write(`${JSON.stringify(failed)}\n`);
        return failed;
      }
      continue;
    }

    const remainingMs = Math.max(1, deadline - now());
    const stepTimeoutMs = Math.min(remainingMs, rpcTimeoutMs(step));
    let reply;
    try {
      reply = await send(session, step.cmd, step.params, { timeoutMs: stepTimeoutMs });
    } catch (error) {
      if (error instanceof HelperAuthenticationRejected || error?.phase === 'AUTH_REJECTED') {
        try {
          session = await reauthenticateSession({ sessionStatePath: options.sessionStatePath, kind: 'ACTION' });
          reply = await send(session, step.cmd, step.params, {
            timeoutMs: Math.min(Math.max(1, deadline - now()), rpcTimeoutMs(step)),
          });
        } catch (retryError) {
          if (retryError instanceof HelperActionOutcomeUnknown || retryError?.phase === 'POST_DISPATCH_UNKNOWN') {
            const unknown = actionResult(options.action, session, 'UNKNOWN', 'UNVERIFIED', now() - startedAt, {
              failureCode: 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN',
              message: 'Android Helper action outcome is unknown',
            });
            process.stdout.write(`${JSON.stringify(unknown)}\n`);
            return unknown;
          }
          const status = acceptedSteps > 0 ? 'ACCEPTED' : 'REJECTED';
          const failed = actionResult(options.action, session, status, acceptedSteps > 0 ? 'FAILED' : 'NOT_EXECUTED', now() - startedAt, {
            failureCode: 'ANDROID_HELPER_AUTHENTICATION_REJECTED',
            message: 'Android Helper authentication could not be restored',
          });
          process.stdout.write(`${JSON.stringify(failed)}\n`);
          return failed;
        }
      } else if ((error instanceof HelperUnavailableBeforeDispatch || error?.phase === 'BEFORE_DISPATCH') && acceptedSteps === 0) {
        throw preDispatch(error);
      } else if (error instanceof HelperActionOutcomeUnknown || error?.phase === 'POST_DISPATCH_UNKNOWN') {
        const unknown = actionResult(options.action, session, 'UNKNOWN', 'UNVERIFIED', now() - startedAt, {
          failureCode: 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN',
          message: 'Android Helper action outcome is unknown',
        });
        process.stdout.write(`${JSON.stringify(unknown)}\n`);
        return unknown;
      } else {
        const failed = actionResult(options.action, session, 'ACCEPTED', 'FAILED', now() - startedAt, {
          failureCode: 'ANDROID_HELPER_ACTION_PARTIAL_FAILURE',
          message: 'Android Helper action transaction failed',
        });
        process.stdout.write(`${JSON.stringify(failed)}\n`);
        return failed;
      }
    }
    if (reply?.success !== true) {
      const failed = actionResult(options.action, session, 'ACCEPTED', 'FAILED', now() - startedAt, {
        failureCode: 'ANDROID_HELPER_ACTION_FAILED',
        message: 'Android Helper reported action failure',
      });
      process.stdout.write(`${JSON.stringify(failed)}\n`);
      return failed;
    }
    acceptedSteps += 1;
  }

  const result = actionResult(options.action, session, 'ACCEPTED', 'UNVERIFIED', now() - startedAt);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'ANDROID_HELPER_ACTION_FAILED'}: ${error.message}\n`);
    process.exitCode = error.exitCode || 2;
  });
}

module.exports = {
  HelperActionPreDispatchError,
  helperActionTransaction,
  main,
  parseArgs,
};
