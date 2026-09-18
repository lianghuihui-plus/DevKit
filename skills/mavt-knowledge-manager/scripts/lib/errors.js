'use strict';

class KnowledgeManagerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'KnowledgeManagerError';
    this.code = code;
    this.exitCode = 2;
    if (details !== undefined) this.details = details;
  }
}

function managerError(code, message, details) {
  return new KnowledgeManagerError(code, message, details);
}

module.exports = { KnowledgeManagerError, managerError };
