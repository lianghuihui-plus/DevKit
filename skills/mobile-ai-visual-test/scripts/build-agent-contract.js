#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLE_RESOURCES = Object.freeze({
  'case-executor': [
    'SKILL.md',
    'references/case-executor-contract.md',
    'references/case-agent-policy.md',
  ],
  'batch-coordinator': [
    'SKILL.md',
    'references/agent-runtime.md',
    'references/workflow.md',
    'references/interfaces.md',
    'references/environment-probing.md',
    'references/failure-policy.md',
    'references/flow-format.md',
    'references/case-executor-contract.md',
    'references/context-format.md',
  ],
});

const ROLE_ENTRYPOINTS = Object.freeze({
  'case-executor': [
    'scripts/build-agent-contract.js',
    'scripts/execute-next-work.js',
    'scripts/build-case-agent-result.js',
  ],
  'batch-coordinator': [
    'scripts/build-agent-contract.js',
    'scripts/resolve-execution-targets.js',
    'scripts/parse-case.js',
    'scripts/probe-env.sh',
    'scripts/update-env.js',
    'scripts/preflight-preconditions.js',
    'scripts/prepare-env.sh',
    'scripts/run-case.js',
    'scripts/agent-runtime.js',
    'scripts/batch-runtime.js',
  ],
});

function usage() {
  console.error('Usage: build-agent-contract.js --role <case-executor|batch-coordinator> [--provider <id>] [--skill-root <path>] [--verify-sha <sha>]');
  process.exit(2);
}

function parseArgs(args) {
  const options = { skillRoot: path.resolve(__dirname, '..'), provider: 'codex' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--role': options.role = args[++i]; break;
      case '--provider': options.provider = String(args[++i] || '').trim().toLowerCase(); break;
      case '--skill-root': options.skillRoot = path.resolve(args[++i]); break;
      case '--verify-sha': options.verifySha = args[++i]; break;
      default: usage();
    }
  }
  if (!ROLE_RESOURCES[options.role]) usage();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(options.provider)) usage();
  return options;
}

function contractDigest(skillRoot, resources, entrypoints) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ resources, entrypoints }));
  hash.update('\0', 'utf8');
  for (const relative of [...resources, ...entrypoints]) {
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

function listImplementationFiles(root, relative = 'scripts') {
  const dir = path.join(root, relative);
  const values = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const child = path.join(dir, name);
    const childRelative = path.posix.join(relative, name);
    const stat = fs.statSync(child);
    if (stat.isDirectory()) values.push(...listImplementationFiles(root, childRelative));
    else if (stat.isFile() && !/(^|[-.])self-test\.js$/.test(name)) values.push(childRelative);
  }
  return values;
}

function implementationDigest(skillRoot, role) {
  const allFiles = listImplementationFiles(skillRoot);
  const files = role === 'case-executor'
    ? allFiles.filter((relative) => relative === 'scripts/execute-next-work.js'
      || relative === 'scripts/build-case-agent-result.js'
      || relative === 'scripts/run-case.js'
      || relative === 'scripts/execution/run-case.js'
      || relative === 'scripts/action-observe.sh'
      || relative === 'scripts/action.sh'
      || relative === 'scripts/observe.sh'
      || relative.startsWith('scripts/lib/')
      || relative.startsWith('scripts/platform/adapters/'))
    : allFiles;
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    hash.update(`${relative}\0`, 'utf8');
    hash.update(fs.readFileSync(path.join(skillRoot, relative)));
    hash.update('\0', 'utf8');
  }
  return {
    implementationFiles: files,
    implementationSha: `agent-implementation-${hash.digest('hex').slice(0, 16)}`,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const resources = [...ROLE_RESOURCES[options.role]];
  if (options.role === 'batch-coordinator') resources.splice(2, 0, `references/agent-runtimes/${options.provider}.md`);
  const entrypoints = ROLE_ENTRYPOINTS[options.role];
  const protocolSha = contractDigest(options.skillRoot, resources, entrypoints);
  const implementation = implementationDigest(options.skillRoot, options.role);
  if (options.verifySha && options.verifySha !== protocolSha) {
    throw new Error(`AGENT_PROTOCOL_MISMATCH: requested ${options.verifySha}, current ${protocolSha}`);
  }
  console.log(JSON.stringify({
    schemaVersion: 1,
    name: 'mobile-ai-visual-test',
    root: options.skillRoot,
    role: options.role,
    provider: options.provider,
    requiredResources: resources,
    allowedEntrypoints: entrypoints,
    protocolSha,
    implementationSha: implementation.implementationSha,
    verified: options.verifySha ? true : undefined,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
