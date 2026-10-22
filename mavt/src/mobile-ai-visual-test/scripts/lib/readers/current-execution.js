'use strict';

const SCHEMA_VERSION = 14;

function supports(execution) {
  return execution?.schemaVersion === SCHEMA_VERSION && execution.runtime === 'case-runtime';
}

function assertSchema(execution) {
  if (!supports(execution)) {
    const error = new Error(`unsupported execution schema: ${execution?.schemaVersion ?? 'missing'}`);
    error.code = 'FORMAT_UNSUPPORTED';
    throw error;
  }
  return execution;
}

module.exports = { SCHEMA_VERSION, assertSchema };
