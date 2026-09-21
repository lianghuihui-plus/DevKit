#!/usr/bin/env node
'use strict';

const { contractError } = require('./contract-utils');

const COMMAND_STATUSES = new Set(['ACCEPTED', 'REJECTED', 'UNKNOWN']);
const DEVICE_EXECUTION_STATUSES = new Set(['VERIFIED', 'UNVERIFIED', 'NOT_EXECUTED', 'FAILED']);

function point(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null;
  const normalized = { ...value, x: Number(value.x), y: Number(value.y) };
  delete normalized.coordinateSource;
  return normalized;
}

function inferredCommandStatus(value) {
  if (COMMAND_STATUSES.has(value?.command?.status)) return value.command.status;
  if (value?.failureCode === 'ACTION_EFFECT_MISMATCH' || value?.inputEffect?.status === 'MISMATCH') return 'ACCEPTED';
  if (value?.ok === false || value?.adapterError || value?.failureCode === 'TOOL_ERROR') return 'REJECTED';
  if (value?.ok === true) return 'ACCEPTED';
  return 'UNKNOWN';
}

function inferredDeviceStatus(value, commandStatus) {
  if (DEVICE_EXECUTION_STATUSES.has(value?.deviceExecution?.status)) return value.deviceExecution.status;
  if (value?.inputEffect?.status === 'MISMATCH') return 'FAILED';
  if (commandStatus === 'REJECTED') return 'NOT_EXECUTED';
  if (value?.coldStartVerified === true || ['VERIFIED', 'MASKED'].includes(value?.inputEffect?.status)) return 'VERIFIED';
  return 'UNVERIFIED';
}

function sanitizeAdapterActionResult(value) {
  const normalized = JSON.parse(JSON.stringify(value));
  if (normalized.inputEffect && typeof normalized.inputEffect === 'object') {
    if (typeof normalized.inputEffect.expectedText === 'string' && normalized.inputEffect.expectedLength === undefined) {
      normalized.inputEffect.expectedLength = normalized.inputEffect.expectedText.length;
    }
    if (typeof normalized.inputEffect.actualText === 'string' && normalized.inputEffect.observedLength === undefined) {
      normalized.inputEffect.observedLength = normalized.inputEffect.actualText.length;
    }
    delete normalized.inputEffect.expectedText;
    delete normalized.inputEffect.actualText;
  }
  delete normalized.preInputState;
  if (normalized.action === 'inputText') {
    delete normalized.adapterError;
    if (normalized.command) delete normalized.command.message;
    if (normalized.deviceExecution) delete normalized.deviceExecution.message;
  }
  return normalized;
}

function safeActionTechnicalDetails(value) {
  const rawEffect = value?.inputEffect;
  const inputEffect = {};
  if (rawEffect && typeof rawEffect === 'object' && !Array.isArray(rawEffect)) {
    if (typeof rawEffect.status === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawEffect.status)) {
      inputEffect.status = rawEffect.status;
    }
    for (const field of ['attempts', 'settledMs', 'expectedLength', 'observedLength']) {
      if (Number.isFinite(rawEffect[field]) && rawEffect[field] >= 0) inputEffect[field] = rawEffect[field];
    }
  }
  const rawFailureCode = value?.failureCode
    || value?.deviceExecution?.failureCode
    || value?.command?.failureCode;
  const failureCode = typeof rawFailureCode === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(rawFailureCode)
    ? rawFailureCode : null;
  return {
    ...(failureCode ? { failureCode } : {}),
    ...(Object.keys(inputEffect).length ? { inputEffect } : {}),
  };
}

function normalizeAdapterActionResult(value, context = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'action adapter result must be an object');
  }
  const commandStatus = inferredCommandStatus(value);
  const deviceStatus = inferredDeviceStatus(value, commandStatus);
  const dispatchedPoint = point(value.deviceExecution?.dispatchedPoint || value.dispatchedPoint || value.executedPoint);
  const dispatchedFrom = point(value.deviceExecution?.dispatchedFrom || value.dispatchedFrom || value.executedFrom);
  const dispatchedTo = point(value.deviceExecution?.dispatchedTo || value.dispatchedTo || value.executedTo);
  const actualTouchPoint = point(value.deviceExecution?.actualTouchPoint);
  const action = context.action || value.action;
  const platform = context.platform || value.platform;
  const normalized = {
    ...value,
    schemaVersion: 2,
    type: 'actionResult',
    platform,
    action,
    device: { ...(value.device || {}), ...(context.deviceId !== undefined ? { id: context.deviceId || null } : {}) },
    app: { ...(value.app || {}), ...(context.appId !== undefined ? { appId: context.appId || null } : {}) },
    command: {
      status: commandStatus,
      transport: value.command?.transport || context.transport || null,
      elapsedMs: Number.isFinite(Number(value.command?.elapsedMs)) ? Number(value.command.elapsedMs) : null,
      ...(commandStatus === 'REJECTED' && value.failureCode ? { failureCode: value.failureCode } : {}),
      ...(commandStatus === 'REJECTED' && (value.error || value.message) ? { message: String(value.error || value.message) } : {}),
    },
    deviceExecution: {
      status: deviceStatus,
      verification: value.deviceExecution?.verification
        || (value.inputEffect?.status ? 'INPUT_EFFECT' : actualTouchPoint ? 'DEVICE_FEEDBACK' : dispatchedPoint || dispatchedFrom ? 'REQUEST_ECHO' : deviceStatus === 'VERIFIED' ? 'PLATFORM_VERIFICATION' : 'NONE'),
      ...(dispatchedPoint ? { dispatchedPoint } : {}),
      ...(dispatchedFrom ? { dispatchedFrom } : {}),
      ...(dispatchedTo ? { dispatchedTo } : {}),
      actualTouchPoint: actualTouchPoint || null,
      ...(deviceStatus === 'FAILED' && value.failureCode ? { failureCode: value.failureCode } : {}),
      ...(deviceStatus === 'FAILED' && (value.error || value.message) ? { message: String(value.error || value.message) } : {}),
    },
  };
  for (const field of ['ok', 'executedPoint', 'executedFrom', 'executedTo', 'dispatchedPoint', 'dispatchedFrom', 'dispatchedTo']) delete normalized[field];
  return sanitizeAdapterActionResult(normalized);
}

function validateAdapterActionResult(value) {
  if (!value || value.schemaVersion !== 2 || value.type !== 'actionResult') {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'action adapter must return current Action Result schema');
  }
  if (!COMMAND_STATUSES.has(value.command?.status)) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'action result command.status is invalid');
  }
  if (!DEVICE_EXECUTION_STATUSES.has(value.deviceExecution?.status)) {
    throw contractError('DEVICE_ADAPTER_OUTPUT_INVALID', 'action result deviceExecution.status is invalid');
  }
  return value;
}

module.exports = {
  COMMAND_STATUSES,
  DEVICE_EXECUTION_STATUSES,
  normalizeAdapterActionResult,
  safeActionTechnicalDetails,
  sanitizeAdapterActionResult,
  validateAdapterActionResult,
};
