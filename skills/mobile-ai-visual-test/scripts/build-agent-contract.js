#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { implementationFiles, roleEntrypoints, roleResources } = require('./lib/agent-contract-manifest');

function usage() {
  console.error('Usage: build-agent-contract.js --role <case-executor|batch-coordinator> --platform <harmony|android|ios> [--provider <id>] [--skill-root <path>] [--verify-sha <sha>]');
  process.exit(2);
}

function parseArgs(args) {
  const options = { skillRoot: path.resolve(__dirname, '..'), provider: 'codex' };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--role': options.role = args[++index]; break;
      case '--provider': options.provider = String(args[++index] || '').trim().toLowerCase(); break;
      case '--platform': options.platform = String(args[++index] || '').trim().toLowerCase(); break;
      case '--skill-root': options.skillRoot = path.resolve(args[++index]); break;
      case '--verify-sha': options.verifySha = args[++index]; break;
      default: usage();
    }
  }
  if (!['case-executor', 'batch-coordinator'].includes(options.role)) usage();
  if (!['harmony', 'android', 'ios'].includes(options.platform)) usage();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(options.provider)) usage();
  return options;
}

function contractDigest(skillRoot, role, provider, platform, resources, entrypoints) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ role, provider, platform, resources, entrypoints }));
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

function implementationDigest(skillRoot, role, platform) {
  const files = implementationFiles(skillRoot, role, platform);
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
  const value = {
    implementationFiles: files,
    implementationSha: `agent-implementation-${hash.digest('hex').slice(0, 16)}`,
  };
  return value;
}

function buildContract(options) {
  const resources = roleResources(options.role);
  const entrypoints = roleEntrypoints(options.role);
  const protocolSha = contractDigest(options.skillRoot, options.role, options.provider, options.platform, resources, entrypoints);
  const implementation = implementationDigest(options.skillRoot, options.role, options.platform);
  if (options.verifySha && options.verifySha !== protocolSha) {
    throw new Error(`AGENT_PROTOCOL_MISMATCH: requested ${options.verifySha}, current ${protocolSha}`);
  }
  const value = {
    schemaVersion: 2,
    name: 'mobile-ai-visual-test',
    root: options.skillRoot,
    role: options.role,
    provider: options.provider,
    platform: options.platform,
    requiredResources: resources,
    allowedEntrypoints: entrypoints,
    protocolSha,
    implementationSha: implementation.implementationSha,
    implementationFiles: implementation.implementationFiles,
  };
  if (options.verifySha) value.verified = true;
  return value;
}

function main() {
  process.stdout.write(`${JSON.stringify(buildContract(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

try {
  if (require.main === module) main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}

module.exports = {
  buildContract,
  contractDigest,
  implementationDigest,
  parseArgs,
};
