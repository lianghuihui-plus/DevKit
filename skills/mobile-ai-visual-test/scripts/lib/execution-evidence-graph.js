'use strict';

const path = require('path');
const { contractError } = require('./contract-utils');
const { readJson } = require('./execution-lifecycle');

function validateExecutionEvidenceGraph(execDir, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (![10, 11].includes(execution?.schemaVersion)) {
    throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  }
  const graph = require('../case-runtime/result-integrity').validateCaseRuntimeEvidenceGraph(execDir, null, options);
  return { ...graph, files: graph.files };
}

module.exports = {
  validateExecutionEvidenceGraph,
};
