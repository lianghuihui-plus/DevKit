'use strict';

const childProcess = require('child_process');
const path = require('path');

const repo = path.resolve(__dirname, '../../..');

function run(command, args = [], options = {}) {
  return childProcess.execFileSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runAllowFailure(command, args = [], options = {}) {
  try {
    return { status: 0, stdout: run(command, args, options), stderr: '' };
  } catch (error) {
    return {
      status: error.status,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

module.exports = {
  repo,
  run,
  runAllowFailure,
};
