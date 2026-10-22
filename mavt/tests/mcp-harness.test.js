'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('Harness requirements reject absent session evidence and accept observed isolated visual handles', () => {
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '../hosts/codex/harness-requirements.json'), 'utf8'));
  const { assessHarness } = require('../src/mobile-ai-visual-test/scripts/mcp/host-capabilities');
  assert.equal(profile.bindingStrategy, 'STATIC_SCOPED_REFERENCES');
  assert.deepEqual(profile.requirements.map(item => item.id), ['independent_context', 'case_image_visibility', 'agent_handle_wait_cancel', 'scoped_binding']);
  const unavailable = assessHarness({});
  assert.equal(unavailable.canExecuteVisualCase, false);
  assert.deepEqual(unavailable.missing, profile.requirements.map(item => item.id));
  const observed = assessHarness({ independentContext: { fresh: true, separateFromCoordinator: true },
    caseImageVisibility: { mcpImageVisibleToChild: true },
    agentHandleWaitCancel: { realHandle: true, wait: true, cancel: true },
    scopedBinding: { strategy: 'STATIC_SCOPED_REFERENCES', contextRefPassedToChild: true } });
  assert.equal(observed.canExecuteVisualCase, true);
  assert.deepEqual(observed.missing, []);
  assert.equal(observed.claimsCallerAuthentication, false);
  assert.equal(observed.claimsOsSandboxing, false);
  assert.equal(assessHarness({ ...observed.evidence, agentHandleWaitCancel: { realHandle: true, wait: true } }).canExecuteVisualCase, false);
});
