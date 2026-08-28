'use strict';

function decideRunningExecution({ deadlineReached, controlRequest }) {
  if (deadlineReached && controlRequest) return 'CLOSE_CONTROL_AND_CONCLUDE_TIME_LIMIT';
  if (deadlineReached) return 'CONCLUDE_TIME_LIMIT';
  if (controlRequest) return 'RECOVER_APP';
  return 'RESUME_EXECUTION';
}

module.exports = { decideRunningExecution };
