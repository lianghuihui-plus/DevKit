'use strict';

const SCHEMA_VERSION = 11;
const READER_FAMILY = 'execution-v11';

function supports(execution) {
  return execution?.schemaVersion === SCHEMA_VERSION && execution.runtime === 'case-runtime';
}

function assertSchema(execution) {
  if (!supports(execution)) {
    const error = new Error(`unsupported execution schema: ${execution?.schemaVersion ?? 'missing'}`);
    error.code = 'EXECUTION_SCHEMA_UNSUPPORTED';
    throw error;
  }
  return execution;
}

module.exports = { READER_FAMILY, SCHEMA_VERSION, assertSchema, supports };
