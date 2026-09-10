'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureId, ensureInteger, ensureObject, ensureString } = require('../lib/contract-utils');

const HANDOFF_SCHEMA_VERSION = 1;

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function handoffRoot(workspaceRoot) {
  return path.resolve(workspaceRoot, 'runs');
}

function assertWithin(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw contractError('HANDOFF_PATH_INVALID', 'handoff path is outside the workspace handoff directory');
  }
}

function validateInput(options) {
  const requestedRoot = path.resolve(ensureString(options.workspaceRoot, 'workspaceRoot', 'HANDOFF_INVALID'));
  if (!fs.existsSync(requestedRoot)) throw contractError('HANDOFF_PATH_INVALID', 'workspace root does not exist');
  const workspaceRoot = fs.realpathSync(requestedRoot);
  const batchId = ensureId(options.batchId, 'batchId', 'HANDOFF_INVALID');
  const executionId = ensureId(options.executionId, 'executionId', 'HANDOFF_INVALID');
  const caseProtocolSha = ensureString(options.caseProtocolSha, 'caseProtocolSha', 'HANDOFF_INVALID');
  const casePrompt = ensureString(options.casePrompt, 'casePrompt', 'HANDOFF_INVALID');
  const brief = ensureObject(options.brief, 'brief', 'HANDOFF_INVALID');
  const mode = options.mode || 'INITIAL';
  const sequence = options.sequence === undefined ? 1 : ensureInteger(options.sequence, 'sequence', 'HANDOFF_INVALID', 1);
  if (!['INITIAL', 'CONTINUATION'].includes(mode)) throw contractError('HANDOFF_INVALID', `unsupported handoff mode: ${mode}`);
  if ((mode === 'INITIAL' && sequence !== 1) || (mode === 'CONTINUATION' && sequence < 2)) {
    throw contractError('HANDOFF_INVALID', `${mode} handoff sequence is invalid`);
  }
  return { workspaceRoot, batchId, executionId, caseProtocolSha, casePrompt, brief, mode, sequence };
}

function ensureHandoffDirectory(input) {
  let current = input.workspaceRoot;
  for (const segment of ['runs', input.batchId, 'handoffs', input.executionId]) {
    const next = path.join(current, segment);
    if (fs.existsSync(next)) {
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw contractError('HANDOFF_PATH_INVALID', `handoff directory component is not a real directory: ${segment}`);
      }
    } else {
      fs.mkdirSync(next, { mode: 0o700 });
    }
    const real = fs.realpathSync(next);
    assertWithin(input.workspaceRoot, real);
    current = real;
  }
  return current;
}

function publicReference(envelope, handoffPath, sha256) {
  const bootstrap = path.resolve(__dirname, '..', 'case-agent-bootstrap.js');
  const loaderCommand = [
    process.execPath,
    bootstrap,
    '--workspace', path.resolve(handoffPath, '..', '..', '..', '..', '..'),
    '--handoff', handoffPath,
    '--sha256', sha256,
    '--execution-id', envelope.executionId,
    '--case-protocol-sha', envelope.caseProtocolSha,
    '--claim-token', require('../lib/dispatch-lease').claimTokenFor(envelope),
  ].map(shellQuote).join(' ');
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId: envelope.handoffId,
    path: handoffPath,
    sha256,
    loaderCommand,
  };
}

function readEnvelope(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw contractError('HANDOFF_INTEGRITY_INVALID', `handoff cannot be read: ${error.message || error}`);
  }
}

function validateEnvelope(envelope, externalSha, bindings = {}) {
  if (!envelope || envelope.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    throw contractError('HANDOFF_INTEGRITY_INVALID', 'unsupported handoff envelope');
  }
  const { payloadSha256, ...payload } = envelope;
  if (!/^[a-f0-9]{64}$/.test(payloadSha256 || '') || digest(payload) !== payloadSha256) {
    throw contractError('HANDOFF_INTEGRITY_INVALID', 'handoff payload digest does not match');
  }
  if (!/^[a-f0-9]{64}$/.test(externalSha || '') || digest(envelope) !== externalSha) {
    throw contractError('HANDOFF_INTEGRITY_INVALID', 'handoff envelope digest does not match');
  }
  if ((bindings.executionId && envelope.executionId !== bindings.executionId)
    || (bindings.caseProtocolSha && envelope.caseProtocolSha !== bindings.caseProtocolSha)) {
    throw contractError('HANDOFF_BINDING_INVALID', 'handoff does not match the requested execution or protocol');
  }
  return envelope;
}

function writeImmutableJson(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink()) throw contractError('HANDOFF_PATH_INVALID', 'handoff file must not be a symbolic link');
    const existing = readEnvelope(file);
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw contractError('HANDOFF_INTEGRITY_INVALID', 'immutable handoff already exists with different content');
    }
    fs.chmodSync(file, 0o600);
    return;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let linked = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.linkSync(temporary, file);
      linked = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  if (!linked) {
    if (fs.lstatSync(file).isSymbolicLink()) throw contractError('HANDOFF_PATH_INVALID', 'handoff file must not be a symbolic link');
    const existing = readEnvelope(file);
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw contractError('HANDOFF_INTEGRITY_INVALID', 'immutable handoff already exists with different content');
    }
  }
  fs.chmodSync(file, 0o600);
}

function existingSequenceHandoff(input) {
  const directory = ensureHandoffDirectory(input);
  const matches = fs.readdirSync(directory).filter((name) => name.startsWith(`${input.sequence}-`) && name.endsWith('.json'));
  if (!matches.length) return null;
  if (matches.length !== 1) {
    throw contractError('HANDOFF_INTEGRITY_INVALID', `handoff sequence ${input.sequence} has multiple immutable files`);
  }
  const handoffPath = path.join(directory, matches[0]);
  const match = matches[0].match(/^[0-9]+-([a-f0-9]{64})\.json$/);
  if (!match) throw contractError('HANDOFF_INTEGRITY_INVALID', 'handoff filename is invalid');
  const sha256 = match[1];
  const envelope = validateEnvelope(readEnvelope(handoffPath), sha256, {
    executionId: input.executionId,
    caseProtocolSha: input.caseProtocolSha,
  });
  if (envelope.batchId !== input.batchId || envelope.mode !== input.mode || envelope.sequence !== input.sequence) {
    throw contractError('HANDOFF_BINDING_INVALID', 'existing handoff does not match the requested batch, mode, or sequence');
  }
  return publicReference(envelope, handoffPath, sha256);
}

function createAgentHandoff(options) {
  const input = validateInput(options);
  const existing = existingSequenceHandoff(input);
  if (existing) return existing;
  const payload = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId: '',
    mode: input.mode,
    sequence: input.sequence,
    batchId: input.batchId,
    executionId: input.executionId,
    caseProtocolSha: input.caseProtocolSha,
    createdAt: options.now || new Date().toISOString(),
    casePrompt: input.casePrompt,
    brief: input.brief,
  };
  const identitySha = digest({ ...payload, handoffId: undefined });
  payload.handoffId = `handoff-${identitySha.slice(0, 16)}`;
  const envelope = { ...payload, payloadSha256: digest(payload) };
  const sha256 = digest(envelope);
  const directory = ensureHandoffDirectory(input);
  const handoffPath = path.join(directory, `${input.sequence}-${sha256}.json`);
  writeImmutableJson(handoffPath, envelope);
  require('../lib/dispatch-lease').registerDispatch(directory, envelope, {
    handoffSha: sha256,
    continuationReason: options.continuationReason,
    now: options.now,
  });
  return publicReference(envelope, handoffPath, sha256);
}

function loadAgentHandoff(options) {
  const requestedRoot = path.resolve(ensureString(options.workspaceRoot, 'workspaceRoot', 'HANDOFF_PATH_INVALID'));
  if (!fs.existsSync(requestedRoot)) throw contractError('HANDOFF_PATH_INVALID', 'workspace root does not exist');
  const workspaceRoot = fs.realpathSync(requestedRoot);
  const handoffPath = path.resolve(ensureString(options.handoffPath, 'handoffPath', 'HANDOFF_PATH_INVALID'));
  assertWithin(handoffRoot(workspaceRoot), handoffPath);
  if (!fs.existsSync(handoffPath)) throw contractError('HANDOFF_PATH_INVALID', 'handoff file does not exist');
  const realHandoffPath = fs.realpathSync(handoffPath);
  assertWithin(fs.realpathSync(handoffRoot(workspaceRoot)), realHandoffPath);
  const envelope = validateEnvelope(readEnvelope(realHandoffPath), options.sha256, {
    executionId: options.executionId,
    caseProtocolSha: options.caseProtocolSha,
  });
  const expectedDirectory = path.join(fs.realpathSync(workspaceRoot), 'runs', envelope.batchId, 'handoffs', envelope.executionId);
  assertWithin(expectedDirectory, realHandoffPath);
  if (path.basename(realHandoffPath) !== `${envelope.sequence}-${options.sha256}.json`) {
    throw contractError('HANDOFF_INTEGRITY_INVALID', 'handoff filename does not match its sequence and digest');
  }
  require('../lib/dispatch-lease').claimDispatch(path.dirname(realHandoffPath), envelope, {
    handoffSha: options.sha256,
    claimToken: options.claimToken,
    now: options.now,
  });
  return { casePrompt: envelope.casePrompt, brief: envelope.brief };
}

module.exports = {
  HANDOFF_SCHEMA_VERSION,
  createAgentHandoff,
  loadAgentHandoff,
};
