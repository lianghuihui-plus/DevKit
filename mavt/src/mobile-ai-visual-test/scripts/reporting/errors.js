'use strict';

/** Error messages deliberately exclude file contents, input values and upstream errors. */
class ReportingError extends Error {
  constructor(code, message = 'Reporting operation could not be completed') {
    super(`${code}: ${message}`);
    this.name = 'ReportingError';
    this.code = code;
    this.failureCode = code;
    this.exitCode = 2;
  }
}
function reportingError(code, message) { return new ReportingError(code, message); }
function requireInput(condition, message = 'Invalid reporting input') {
  if (!condition) throw reportingError('REPORTING_INPUT_INVALID', message);
}
module.exports = { ReportingError, reportingError, requireInput };
