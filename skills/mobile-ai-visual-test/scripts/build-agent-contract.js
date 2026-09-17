#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { implementationFiles, implementationGroups, roleEntrypoints, roleResources } = require('./lib/agent-contract-manifest');
const { parseCoordinatorCliArgs, writeCoordinatorCliError } = require('./lib/coordinator-interface-contract');

function parseArgs(args) {
  const options = parseCoordinatorCliArgs(args, 'scripts/build-agent-contract.js');
  options.skillRoot = options.skillRoot ? path.resolve(options.skillRoot) : path.resolve(__dirname, '..');
  return options;
}

function contractDigest(skillRoot, role, platform, resources, entrypoints, capabilities = null) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ role, platform, resources, entrypoints, capabilities }));
  hash.update('\0', 'utf8');
  for (const relative of resources) {
    const file = path.join(skillRoot, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`AGENT_PROTOCOL_MISMATCH: missing required skill resource: ${relative}`);
    }
    hash.update(`${relative}\0`, 'utf8');
    hash.update(fs.readFileSync(file));
    hash.update('\0', 'utf8');
  }
  return `agent-protocol-${hash.digest('hex').slice(0, 16)}`;
}

function coordinatorCapabilities(skillRoot, entrypoints) {
  const contractModule = path.join(skillRoot, 'scripts/coordinator/agent-facing-contract.js');
  const resolved = require.resolve(contractModule);
  delete require.cache[resolved];
  const agentFacingContract = require(resolved);
  return {
    interfaceKind: agentFacingContract.AGENT_FACING_INTERFACE_KIND,
    protocol: agentFacingContract.AGENT_FACING_PROTOCOL,
    command: entrypoints[0],
    documentation: 'references/coordinator.md',
  };
}

function publicContract(skillRoot, role) {
  const relative = role === 'case-executor'
    ? 'scripts/case-runtime/agent-facing-contract.js'
    : 'scripts/coordinator/agent-facing-contract.js';
  const resolved = require.resolve(path.join(skillRoot, relative));
  delete require.cache[resolved];
  return require(resolved).PUBLIC_CONTRACT;
}

function filesDigest(skillRoot, files, prefix) {
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const file = path.join(skillRoot, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`AGENT_IMPLEMENTATION_MISMATCH: missing implementation file: ${relative}`);
    }
    hash.update(`${relative}\0`, 'utf8');
    hash.update(fs.readFileSync(file));
    hash.update('\0', 'utf8');
  }
  return `${prefix}-${hash.digest('hex').slice(0, 16)}`;
}

function implementationDigest(skillRoot, role, platform) {
  const files = implementationFiles(skillRoot, role, platform);
  const groups = implementationGroups(skillRoot, platform);
  const value = {
    implementationFiles: files,
    runtimeSha: filesDigest(skillRoot, groups.runtime, 'case-runtime'),
    coordinatorSha: filesDigest(skillRoot, groups.coordinator, 'batch-coordinator'),
    adapterSha: filesDigest(skillRoot, groups.adapter, 'platform-adapter'),
    reportRendererSha: filesDigest(skillRoot, groups.report, 'report-renderer'),
  };
  return value;
}

function buildContract(options) {
  const resources = roleResources(options.role);
  const entrypoints = roleEntrypoints(options.role);
  const capabilities = options.role === 'batch-coordinator'
    ? coordinatorCapabilities(options.skillRoot, entrypoints) : null;
  const protocolDefinition = publicContract(options.skillRoot, options.role);
  const protocolSha = contractDigest(options.skillRoot, options.role, options.platform, resources, entrypoints, protocolDefinition);
  const implementation = implementationDigest(options.skillRoot, options.role, options.platform);
  if (options.verifySha && options.verifySha !== protocolSha) {
    throw new Error(`AGENT_PROTOCOL_MISMATCH: requested ${options.verifySha}, current ${protocolSha}`);
  }
  const value = {
    name: 'mobile-ai-visual-test',
    root: options.skillRoot,
    role: options.role,
    platform: options.platform,
    requiredResources: resources,
    allowedEntrypoints: entrypoints,
    protocolSha,
    runtimeSha: implementation.runtimeSha,
    coordinatorSha: implementation.coordinatorSha,
    adapterSha: implementation.adapterSha,
    reportRendererSha: implementation.reportRendererSha,
    implementationFiles: implementation.implementationFiles,
  };
  if (options.role === 'batch-coordinator') {
    value.coordinatorFacade = capabilities;
  }
  if (options.verifySha) value.verified = true;
  return value;
}

function main() {
  process.stdout.write(`${JSON.stringify(buildContract(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

try {
  if (require.main === module) main();
} catch (error) {
  writeCoordinatorCliError(error, 'scripts/build-agent-contract.js');
  process.exit(error.exitCode || 1);
}

module.exports = {
  buildContract,
  contractDigest,
  implementationDigest,
  filesDigest,
  parseArgs,
};
