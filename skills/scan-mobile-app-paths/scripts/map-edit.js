#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, requiredId, assertAbsolute, readJson, output, main, fail, withFileLock, ensureDir } = require('./lib/common');
const { mapsRoot } = require('./lib/canonical-map-store');
const { buildDeletePlan, buildResetPlan, previewEdit, applyPreview, locatePreview } = require('./lib/canonical-map-editor');

function appRoot(args) {
  const root = assertAbsolute(required(args, 'appMapRoot'), '--app-map-root');
  readJson(path.join(root, 'app.json'));
  return root;
}

function targetFromArgs(args) {
  const edgeId = args.edgeId ? requiredId(args, 'edgeId') : null;
  const reachableStateId = args.reachableStateId ? requiredId(args, 'reachableStateId') : null;
  if (edgeId && reachableStateId) fail('Delete preview accepts exactly one target: --edge-id or --reachable-state-id', 'MAP_EDIT_TARGET_AMBIGUOUS');
  if (!edgeId && !reachableStateId) fail('Delete preview requires --edge-id or --reachable-state-id', 'MAP_EDIT_TARGET_REQUIRED');
  return edgeId ? { edgeId } : { reachableStateId };
}

function summary(plan) {
  const impact = plan.impact || {};
  return {
    operation: plan.operation,
    contextId: plan.contextId,
    target: plan.target,
    counts: {
      reachableStates: (impact.reachableStateIds || []).length,
      visualStates: (impact.visualStateIds || []).length,
      logicalScreens: (impact.logicalScreenIds || []).length,
      edges: (impact.edgeIds || []).length,
      frontiers: (impact.frontierIds || []).length,
      verificationTasks: (impact.verificationIds || []).length,
      backCapabilities: (impact.backCapabilityIds || []).length,
      visualEquivalenceRules: (impact.visualEquivalenceRuleIds || []).length,
      stateEquivalenceRules: (impact.stateEquivalenceRuleIds || []).length
    },
    labels: impact.labels || { states: [], edges: [] }
  };
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'help';
  const root = appRoot(args);
  const lock = path.join(mapsRoot(root), '.canonical-map.lock');
  ensureDir(mapsRoot(root));
  if (command === 'preview-delete') {
    const contextId = required(args, 'context'); const target = targetFromArgs(args);
    const preview = withFileLock(lock, () => previewEdit(root, buildDeletePlan({ appRoot: root, contextId, target, reason: args.reason || null })));
    return output({ schemaVersion: 1, ok: true, edit: preview, summary: summary(preview), nextStep: 'APPLY_DELETE_WITH_CONFIRM_HASH' });
  }
  if (command === 'preview-reset-context') {
    const contextId = required(args, 'context');
    const preview = withFileLock(lock, () => previewEdit(root, buildResetPlan({ appRoot: root, contextId, reason: args.reason || null })));
    return output({ schemaVersion: 1, ok: true, edit: preview, summary: summary(preview), nextStep: 'APPLY_DELETE_WITH_CONFIRM_HASH' });
  }
  if (command === 'apply-delete') {
    const editId = requiredId(args, 'editId'); const confirmHash = required(args, 'confirmHash');
    const result = withFileLock(lock, () => applyPreview(root, { editId, confirmHash }));
    return output({ schemaVersion: 1, ok: true, edit: result.applied, summary: summary(result.applied), mapRevisionId: result.meta.mapRevisionId, previousMapRevisionId: result.meta.previousMapRevisionId });
  }
  if (command === 'show') {
    const editId = requiredId(args, 'editId');
    const located = locatePreview(root, editId);
    return output({ schemaVersion: 1, ok: true, edit: located.preview, summary: summary(located.preview) });
  }
  if (command === 'reset-context') {
    const contextId = required(args, 'context');
    if (args.confirmContext !== contextId) fail('reset-context requires --confirm-context equal to --context', 'MAP_EDIT_CONFIRMATION_REQUIRED');
    const result = withFileLock(lock, () => {
      const plan = buildResetPlan({ appRoot: root, contextId, reason: args.reason || null });
      previewEdit(root, plan);
      return applyPreview(root, { editId: plan.editId, confirmHash: plan.confirmHash });
    });
    return output({ schemaVersion: 1, ok: true, edit: result.applied, summary: summary(result.applied), mapRevisionId: result.meta.mapRevisionId, previousMapRevisionId: result.meta.previousMapRevisionId });
  }
  fail(`Unknown map-edit command: ${command}`, 'COMMAND_INVALID');
});
