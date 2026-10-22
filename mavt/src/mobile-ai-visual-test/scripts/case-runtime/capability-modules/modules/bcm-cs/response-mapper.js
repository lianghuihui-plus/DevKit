'use strict';

function combinedOutput(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
}

function uncertain(result) {
  return Boolean(result?.signal || ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(result?.error?.code)
    || result?.status === 124
    || /\brequest (?:timed out|timeout)\b|connection.*(?:closed|reset)|unexpected eof/i.test(combinedOutput(result)));
}

function commandSucceeded(result) {
  return !result?.error && !result?.signal && result?.status === 0;
}

function outputValue(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_error) { return text; }
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
  const output = outputValue(result.stdout);
  if (output?.success === false || ['FAILED', 'ERROR'].includes(String(output?.status || '').toUpperCase())) {
    return {
      status: 'FAILED',
      summary: `BCM capability ${capabilityName} failed`,
      output,
      diagnostic: output.message || output.error || 'BCM returned a failure response',
    };
  }
  return {
    status: 'SUCCEEDED',
    summary: `BCM capability ${capabilityName} completed`,
    output,
    diagnostic: null,
  };
}

module.exports = {
  commandSucceeded,
  invocationResult,
  outputValue,
  uncertain,
};
