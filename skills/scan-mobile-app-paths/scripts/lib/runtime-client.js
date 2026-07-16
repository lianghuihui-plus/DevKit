'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { fail } = require('./common');

function bridge(command, args = {}) {
  const script = path.join(__dirname, '..', 'runtime', 'harmony-bridge.sh'); const words = [command];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === false) continue;
    words.push(`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
    if (value !== true) words.push(String(value));
  }
  const result = spawnSync(script, words, { encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024, env: process.env });
  if (result.status !== 0) {
    let detail; try { detail = JSON.parse(result.stderr.trim()); } catch { detail = null; }
    fail(detail?.error?.message || result.stderr.trim() || `Bridge ${command} failed`, detail?.error?.code || 'BRIDGE_FAILED');
  }
  try { return JSON.parse(result.stdout); } catch (error) { fail(`Bridge returned invalid JSON: ${error.message}`, 'BRIDGE_PROTOCOL_INVALID'); }
}

module.exports = { bridge };
