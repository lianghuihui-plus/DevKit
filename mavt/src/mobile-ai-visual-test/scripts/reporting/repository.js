'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { reportingError, ReportingError, requireInput } = require('./errors');
const EXPORT_VERSION = 1;

function guarded(fn) {
  try { return fn(); } catch (error) {
    if (error instanceof ReportingError) throw error;
    throw reportingError('REPORTING_STORAGE_ERROR', 'Private reporting storage is unavailable');
  }
}
function safeId(value) {
  requireInput(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(value) && value !== '..', 'Invalid local identifier');
  return value;
}
function createRepository(options = {}) {
  const configDir = path.resolve(options.configDir || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mavt'));
  const now = () => typeof options.clock === 'function' ? options.clock() : new Date().toISOString();
  function target(base, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) {
      throw reportingError('REPORTING_PATH_UNSAFE', 'Unsafe private storage path');
    }
    const resolved = path.resolve(base, relative);
    if (!resolved.startsWith(`${base}${path.sep}`)) throw reportingError('REPORTING_PATH_UNSAFE');
    check(base);
    let current = base;
    for (const component of relative.split('/')) { current = path.join(current, component); check(current); }
    return resolved;
  }
  function check(file) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw reportingError('REPORTING_PATH_UNSAFE', 'Private storage cannot use links or special files');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function mkdirPrivate(dir) {
    check(dir);
    if (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (!fs.existsSync(parent)) mkdirPrivate(parent);
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    fs.chmodSync(dir, 0o700);
  }
  function workspaceBase(workspace) {
    const base = path.resolve(workspace);
    check(base); check(path.join(base, '.mavt')); check(path.join(base, '.mavt', 'reporting'));
    return path.join(base, '.mavt', 'reporting');
  }
  function parse(file) {
    check(file);
    let bytes;
    try { bytes = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let value;
    try { value = JSON.parse(bytes); } catch { throw reportingError('REPORTING_STATE_CORRUPT', 'Private reporting state is invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw reportingError('REPORTING_STATE_CORRUPT');
    if (value.schemaVersion !== 1) throw reportingError('REPORTING_STATE_VERSION_UNSUPPORTED', 'Unsupported private state version');
    return value;
  }
  function atomic(file, value, versioned = true) {
    check(file);
    // Do not overwrite a newer bundle's state, even through an explicit write.
    if (versioned) parse(file);
    if (versioned) mkdirPrivate(path.dirname(file));
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const record = versioned ? {schemaVersion:1, identityEpoch:null, exportVersion:EXPORT_VERSION, ...value} : value;
      requireInput(!versioned || record.schemaVersion === 1, 'Writes require the supported state version');
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      check(file); fs.renameSync(temp, file);
      const parent = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return record;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function lock(base, name, callback) {
    requireInput(typeof callback === 'function', 'A synchronous critical section is required');
    mkdirPrivate(base);
    const file = target(base, `.${safeId(name)}.lock`);
    const owner = {schemaVersion:1,pid:process.pid,nonce:crypto.randomUUID()};
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Conservative synchronous stale recovery: only reclaim a completely written,
      // dead owner, and serialize reclaimers with a separate exclusive guard.
      const reap = `${file}.reap`;
      let reapFd;
      try { reapFd = fs.openSync(reap, 'wx', 0o600); } catch { throw reportingError('REPORTING_LOCKED', 'Reporting metadata is busy'); }
      try {
        const previous = parse(file);
        let alive = true;
        if (Number.isInteger(previous?.pid) && previous.pid > 0) {
          try { process.kill(previous.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        }
        if (alive) throw reportingError('REPORTING_LOCKED', 'Reporting metadata is busy');
        fs.unlinkSync(file);
        fd = fs.openSync(file, 'wx', 0o600);
      } finally { fs.closeSync(reapFd); fs.unlinkSync(reap); }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const result = callback();
      requireInput(!result || typeof result.then !== 'function', 'Metadata locks cannot wrap asynchronous work');
      return result;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      const current = parse(file);
      if (current?.nonce === owner.nonce) fs.unlinkSync(file);
    }
  }
  function list(base, relative) {
    const dir = target(base, relative);
    try { return fs.readdirSync(dir).filter(x => !x.startsWith('.')).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return {
    configDir, now,
    readConfig: (relative, readOptions = {}) => guarded(() => {
      const file = target(configDir, relative);
      if (readOptions.private === true && fs.existsSync(file)) {
        const stat = fs.statSync(file), dir = fs.statSync(configDir);
        if ((stat.mode & 0o077) || (dir.mode & 0o077) || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw reportingError('REPORTING_CREDENTIALS_INSECURE', 'Credential storage requires private ownership and permissions');
      }
      return parse(file);
    }),
    writeConfig: (relative, value) => guarded(() => atomic(target(configDir, relative), value)),
    withConfigLock: callback => guarded(() => lock(configDir, 'config', callback)),
    readWorkspace: (workspace, relative) => guarded(() => parse(target(workspaceBase(workspace), relative))),
    writeWorkspace: (workspace, relative, value) => guarded(() => atomic(target(workspaceBase(workspace), relative), value)),
    listWorkspace: (workspace, relative) => guarded(() => list(workspaceBase(workspace), relative)),
    withWorkspaceLock: (workspace, callback) => guarded(() => lock(workspaceBase(workspace), 'metadata', callback)),
    readMarker: workspace => guarded(() => {
      check(path.resolve(workspace)); check(path.join(workspace, 'workspace.json'));
      // Same marker contract as lib/workspace.readMarker, without importing its
      // renderer dependency into the lightweight integration loading boundary.
      let marker;
      try { marker = JSON.parse(fs.readFileSync(path.join(workspace, 'workspace.json'), 'utf8')); }
      catch { throw reportingError('REPORTING_WORKSPACE_INVALID'); }
      if (!marker || Array.isArray(marker) || marker.schemaVersion !== 1 || marker.type !== 'mobile-ai-visual-test-workspace' || (marker.initializationState || 'READY') !== 'READY') throw reportingError('REPORTING_WORKSPACE_INVALID', 'A READY workspace is required');
      return {...marker, initializationState:marker.initializationState || 'READY'};
    }),
    writeMarker: (workspace, marker) => guarded(() => {
      const base = path.resolve(workspace); check(base);
      return atomic(target(base, 'workspace.json'), marker, false);
    }),
    readRunState: (workspace, batchId) => guarded(() => {
      const file = target(path.resolve(workspace), `runs/${safeId(batchId)}/coordinator-state.json`);
      let value;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw reportingError('REPORTING_RUN_STATE_INVALID'); }
      if (!value || value.batchId !== batchId || path.resolve(value.workspace || '') !== path.resolve(workspace)) throw reportingError('REPORTING_RUN_STATE_INVALID');
      return value;
    }),
    credentialPath: () => guarded(() => target(configDir, 'credentials.json')),
  };
}
module.exports = { createRepository, safeId, EXPORT_VERSION };
