'use strict';

const fs = require('fs');
const path = require('path');
const { renderIndexArtifacts } = require('../report/index-renderer');

const WORKSPACE_SCHEMA_VERSION = 1;
const WORKSPACE_TYPE = 'mobile-ai-visual-test-workspace';
const TEST_WORKSPACE_TYPE = 'mobile-ai-visual-test-test-workspace';
const INITIALIZATION_STATES = new Set(['INITIALIZING', 'READY']);

function workspaceError(message) {
  const error = new Error(`WORKSPACE_INVALID: ${message}`);
  error.code = 'WORKSPACE_INVALID';
  error.failureCode = 'WORKSPACE_INVALID';
  error.exitCode = 2;
  return error;
}

function markerPath(root) {
  return path.join(root, 'workspace.json');
}

function atomicWrite(file, content) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function writeMarker(root, marker) {
  atomicWrite(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`);
}

function readMarker(root) {
  const file = markerPath(root);
  if (!fs.existsSync(file)) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw workspaceError(`workspace.json is not valid JSON: ${error.message}`);
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw workspaceError('workspace.json must be an object');
  if (marker.schemaVersion !== WORKSPACE_SCHEMA_VERSION) throw workspaceError(`unsupported workspace schemaVersion: ${marker.schemaVersion ?? 'missing'}`);
  if (marker.type !== WORKSPACE_TYPE) throw workspaceError(`workspace.json type must be ${WORKSPACE_TYPE}`);
  const state = marker.initializationState || 'READY';
  if (!INITIALIZATION_STATES.has(state)) throw workspaceError(`workspace initializationState is invalid: ${state}`);
  return { ...marker, initializationState: state };
}

function workspaceEntries(root) {
  return fs.readdirSync(root).filter((name) => name !== '.DS_Store');
}

function ensureWorkspaceDirectories(root) {
  for (const relative of ['cases', 'knowledge', path.join('app-packages', 'ios')]) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  }
}

function completeInitialization(root, marker, options = {}) {
  ensureWorkspaceDirectories(root);
  renderIndexArtifacts(root, [], { generatedAt: options.now });
  if (options.interruptAfterArtifacts === true) throw new Error('MAVT_WORKSPACE_INIT_INTERRUPTED: after-artifacts');
  const ready = { ...marker, initializationState: 'READY', updatedAt: options.now || marker.updatedAt || marker.createdAt };
  writeMarker(root, ready);
  return ready;
}

function initializeEmptyWorkspace(root, options = {}) {
  const now = options.now || new Date().toISOString();
  const marker = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    type: WORKSPACE_TYPE,
    name: path.basename(root),
    initializationState: 'INITIALIZING',
    createdAt: now,
    updatedAt: now,
  };
  writeMarker(root, marker);
  return completeInitialization(root, marker, options);
}

function ensureWorkspace(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  if (!fs.existsSync(root)) throw workspaceError(`workspace directory does not exist: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw workspaceError(`workspace path is not a directory: ${root}`);
  const entries = workspaceEntries(root);
  if (entries.length === 0) {
    const marker = initializeEmptyWorkspace(root, options);
    return { root, marker, initialized: true };
  }
  const marker = readMarker(root);
  if (!marker) throw workspaceError('non-empty directory requires a valid workspace.json marker');
  if (marker.initializationState === 'INITIALIZING') {
    const completed = completeInitialization(root, marker, options);
    return { root, marker: completed, initialized: true, resumedInitialization: true };
  }
  ensureWorkspaceDirectories(root);
  return { root, marker, initialized: false };
}

function assertWorkspace(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw workspaceError(`workspace directory does not exist: ${root}`);
  }
  const file = markerPath(root);
  if (!fs.existsSync(file)) throw workspaceError('workspace.json marker is required');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw workspaceError(`workspace.json is not valid JSON: ${error.message}`);
  }
  if (raw?.type === TEST_WORKSPACE_TYPE && raw.testOnly === true) {
    if (options.allowTest !== true || process.env.MAVT_SELF_TEST !== '1') {
      throw workspaceError('test workspace is not available to formal execution');
    }
    return { root, marker: raw, testOnly: true };
  }
  const marker = readMarker(root);
  if (marker.initializationState !== 'READY') throw workspaceError('workspace initialization is incomplete');
  return { root, marker, testOnly: false };
}

function resolveExternalInput(input, workspaceRoot) {
  if (typeof input !== 'string' || !input.trim()) throw workspaceError('input path is required');
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(workspaceRoot, input);
}

module.exports = {
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_TYPE,
  TEST_WORKSPACE_TYPE,
  assertWorkspace,
  ensureWorkspace,
  initializeEmptyWorkspace,
  markerPath,
  readMarker,
  resolveExternalInput,
  workspaceEntries,
  workspaceError,
};
