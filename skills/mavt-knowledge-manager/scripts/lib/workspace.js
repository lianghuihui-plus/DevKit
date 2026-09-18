'use strict';

const fs = require('fs');
const path = require('path');
const { managerError } = require('./errors');

const WORKSPACE_TYPE = 'mobile-ai-visual-test-workspace';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw managerError('WORKSPACE_INVALID', `workspace.json is not valid JSON: ${error.message}`);
  }
}

function assertMavtWorkspace(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw managerError('WORKSPACE_INVALID', 'workspace path is required');
  }
  const root = path.resolve(workspacePath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw managerError('WORKSPACE_INVALID', `workspace directory does not exist: ${root}`);
  }
  const markerPath = path.join(root, 'workspace.json');
  if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
    throw managerError('WORKSPACE_INVALID', 'workspace.json marker is required');
  }
  const marker = readJson(markerPath);
  if (marker?.schemaVersion !== 1) {
    throw managerError('WORKSPACE_INVALID', `workspace schemaVersion must be 1: ${marker?.schemaVersion ?? 'missing'}`);
  }
  if (marker.type !== WORKSPACE_TYPE) {
    throw managerError('WORKSPACE_INVALID', `workspace type must be ${WORKSPACE_TYPE}`);
  }
  if (marker.initializationState !== 'READY') {
    throw managerError('WORKSPACE_INVALID', 'workspace initializationState must be READY');
  }
  const knowledgeRoot = path.join(root, 'knowledge');
  if (!fs.existsSync(knowledgeRoot)) {
    throw managerError('WORKSPACE_INVALID', 'workspace knowledge directory is required');
  }
  const knowledgeStat = fs.lstatSync(knowledgeRoot);
  if (knowledgeStat.isSymbolicLink() || !knowledgeStat.isDirectory()) {
    throw managerError('WORKSPACE_INVALID', 'workspace knowledge path must be a real directory');
  }
  return {
    root,
    marker,
    knowledgeRoot,
    maintenanceRoot: path.join(root, '.mavt', 'knowledge-maintenance'),
  };
}

module.exports = { WORKSPACE_TYPE, assertMavtWorkspace };
