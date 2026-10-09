'use strict';

const { parseJson } = require('./adapter');

function combinedOutput(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
}

function uncertain(result) {
  return Boolean(result?.signal || ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(result?.error?.code)
    || result?.status === 124 || /timed?\s*out|timeout|connection.*(?:closed|reset)|unexpected eof/i.test(combinedOutput(result)));
}

function commandSucceeded(result) {
  return !result?.error && !result?.signal && result?.status === 0;
}

function discoveryResult(result) {
  if (!commandSucceeded(result)) return { ok: false, diagnostic: 'bcm-cs capability discovery unavailable' };
  try {
    return { ok: true, value: parseJson(result.stdout) };
  } catch (_error) {
    return { ok: false, diagnostic: 'bcm-cs capability discovery returned invalid JSON' };
  }
}

function invocationResult(result, capabilityName) {
  if (!commandSucceeded(result)) {
    const unknown = uncertain(result);
    return {
      status: unknown ? 'UNKNOWN' : 'FAILED',
      summary: unknown ? `BCM capability ${capabilityName} outcome is unknown` : `BCM capability ${capabilityName} failed`,
      output: null,
      diagnostic: combinedOutput(result) || result?.error?.message || 'bcm-cs process failed',
    };
  }
  let output;
  try { output = parseJson(result.stdout); } catch (error) {
    return {
      status: 'UNKNOWN', summary: `BCM capability ${capabilityName} outcome is unknown`,
      output: null, diagnostic: error.message,
    };
  }
  if (output?.success === false || ['FAILED', 'ERROR'].includes(String(output?.status || '').toUpperCase())) {
    return {
      status: 'FAILED', summary: `BCM capability ${capabilityName} failed`,
      output, diagnostic: output.message || output.error || 'BCM returned a failure response',
    };
  }
  return {
    status: 'SUCCEEDED', summary: `BCM capability ${capabilityName} completed`, output, diagnostic: null,
  };
}

module.exports = {
  commandSucceeded,
  discoveryResult,
  invocationResult,
  uncertain,
};
