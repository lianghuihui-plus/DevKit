'use strict';

const path = require('path');
const { contractError } = require('./contract-utils');
const { readJson } = require('./execution-lifecycle');

function validateExecutionEvidenceGraph(execDir, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (execution?.schemaVersion !== 14) {
    throw contractError('FORMAT_UNSUPPORTED', 'This execution was created by an unsupported format and must be run again');
  }
  const graph = require('../case-runtime/result-integrity').validateCaseRuntimeEvidenceGraph(execDir, null, options);
  return { ...graph, files: graph.files };
}

module.exports = {
  validateExecutionEvidenceGraph,
};
