'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  contractError,
  ensureArray,
  ensureObject,
  ensureString,
  sha256,
} = require('./contract-utils');

const APP_PROVISIONING_SCHEMA_VERSION = 2;
const PREPARATION_POLICY_SCHEMA_VERSION = 1;
const BOOTSTRAP_POLICY_SCHEMA_VERSION = 1;
const INITIAL_STATE_REQUIREMENT_SCHEMA_VERSION = 1;
const INITIAL_STATE_PREFLIGHT_SCHEMA_VERSION = 1;
const PROVISIONING_MODES = new Set(['PREINSTALLED', 'ARTIFACT_MANAGED']);
const BOOTSTRAP_MODES = new Set(['KEEP_EXISTING', 'REINSTALL_FROZEN']);
const PREPARATION_EFFECTS = new Set(['CLEAR_APP_DATA', 'UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT']);
const TARGET_STATES = new Set(['APP_LOCAL_STATE_EMPTY', 'FRESH_INSTALL']);
const INITIAL_STATE_TARGETS = new Set(['KEEP_EXISTING', ...TARGET_STATES]);
const FORMATS = Object.freeze({ android: new Set(['APK']), harmony: new Set(['HAP', 'APP']), ios: new Set(['APP', 'IPA']) });

function artifactRoot(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), '.mavt', 'app-artifacts');
}

function contentDigest(target) {
  const resolved = path.resolve(target);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw contractError('APP_INSTALL_ARTIFACT_INVALID', 'installation artifact must not be a symbolic link');
  const hash = crypto.createHash('sha256');
  let size = 0;
  const visit = (file, relative) => {
    const current = fs.lstatSync(file);
    if (current.isSymbolicLink()) throw contractError('APP_INSTALL_ARTIFACT_INVALID', `installation artifact contains a symbolic link: ${relative}`);
    if (current.isDirectory()) {
      hash.update(`D\0${relative}\0`);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.posix.join(relative, name));
      return;
    }
    if (!current.isFile()) throw contractError('APP_INSTALL_ARTIFACT_INVALID', `installation artifact contains an unsupported entry: ${relative}`);
    const data = fs.readFileSync(file);
    hash.update(`F\0${relative}\0${current.mode & 0o777}\0${data.length}\0`);
    hash.update(data);
    size += data.length;
  };
  visit(resolved, '');
  return { sha256: hash.digest('hex'), size, directory: stat.isDirectory() };
}

function inferFormat(file) {
  const extension = path.extname(String(file)).slice(1).toUpperCase();
  if (!['APK', 'HAP', 'APP', 'IPA'].includes(extension)) {
    throw contractError('APP_INSTALL_ARTIFACT_INVALID', 'installation artifact must be .apk, .hap, .app, or .ipa');
  }
  return extension;
}

function runInspection(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function nestedValue(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return String(value[key]);
  for (const child of Object.values(value)) {
    const found = nestedValue(child, keys);
    if (found) return found;
  }
  return null;
}

function inspectArtifactIdentity(options) {
  if (typeof options.inspectArtifact === 'function') return options.inspectArtifact({
    sourcePath: options.sourcePath,
    platform: options.platform,
    format: options.format,
    deviceType: options.deviceType,
  });
  if (options.platform === 'ios' && options.format === 'APP') {
    const plist = path.join(options.sourcePath, 'Info.plist');
    if (fs.existsSync(plist)) {
      const appId = runInspection('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
      const version = runInspection('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
      const build = runInspection('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', plist]);
      if (appId && version && build) return { status: 'VERIFIED', identity: { appId, version, build }, tool: 'plutil', toolVersion: runInspection('plutil', ['-help']) ? 'system' : 'unknown' };
    }
  }
  if (options.platform === 'android' && options.format === 'APK') {
    const appId = runInspection('apkanalyzer', ['manifest', 'application-id', options.sourcePath]);
    const version = runInspection('apkanalyzer', ['manifest', 'version-name', options.sourcePath]);
    const build = runInspection('apkanalyzer', ['manifest', 'version-code', options.sourcePath]);
    if (appId && version && build) return { status: 'VERIFIED', identity: { appId, version, build }, tool: 'apkanalyzer', toolVersion: 'system' };
  }
  if (options.platform === 'harmony' && ['HAP', 'APP'].includes(options.format)) {
    const names = runInspection('unzip', ['-Z1', options.sourcePath]);
    const candidate = names?.split(/\r?\n/).find((name) => /(?:^|\/)(?:module\.json|pack\.info)$/.test(name));
    const content = candidate ? runInspection('unzip', ['-p', options.sourcePath, candidate]) : null;
    try {
      const metadata = JSON.parse(content);
      const appId = nestedValue(metadata, ['bundleName', 'appId']);
      const version = nestedValue(metadata, ['versionName']);
      const build = nestedValue(metadata, ['versionCode']);
      if (appId && version && build) return { status: 'VERIFIED', identity: { appId, version, build }, tool: 'unzip-json', toolVersion: 'system' };
    } catch {
      // Some Harmony artifacts use binary manifests and need platform tooling.
    }
  }
  return { status: 'UNAVAILABLE', identity: null, tool: 'none', toolVersion: 'unavailable' };
}

function normalizeIdentityInspection(value, expected) {
  ensureObject(value, 'artifactIdentity.inspection', 'APP_INSTALL_ARTIFACT_INVALID');
  if (!['VERIFIED', 'UNAVAILABLE'].includes(value.status)) throw contractError('APP_INSTALL_ARTIFACT_INVALID', 'artifact identity inspection status is invalid');
  ensureString(value.tool, 'artifactIdentity.inspection.tool', 'APP_INSTALL_ARTIFACT_INVALID');
  ensureString(value.toolVersion, 'artifactIdentity.inspection.toolVersion', 'APP_INSTALL_ARTIFACT_INVALID');
  if (value.status === 'UNAVAILABLE') return { status: value.status, identity: null, tool: value.tool, toolVersion: value.toolVersion };
  const identity = ensureObject(value.identity, 'artifactIdentity.inspection.identity', 'APP_INSTALL_ARTIFACT_INVALID');
  for (const field of ['appId', 'version', 'build']) ensureString(identity[field], `artifactIdentity.inspection.identity.${field}`, 'APP_INSTALL_ARTIFACT_INVALID');
  if (['appId', 'version', 'build'].some((field) => String(identity[field]) !== String(expected[field]))) {
    throw contractError('APP_ARTIFACT_IDENTITY_MISMATCH', 'extracted artifact identity does not match the expected appId/version/build');
  }
  return { status: value.status, identity: { appId: identity.appId, version: identity.version, build: identity.build }, tool: value.tool, toolVersion: value.toolVersion };
}

function validateInstalledAppIdentity(result, provisioning) {
  if (provisioning?.mode !== 'ARTIFACT_MANAGED') return result;
  const identity = ensureObject(result?.installedIdentity, 'appPreparationResult.installedIdentity', 'APP_ARTIFACT_IDENTITY_UNVERIFIED');
  const mismatches = ['appId', 'version', 'build'].filter((field) => String(identity[field] || '') !== String(provisioning[field]));
  if (mismatches.length) {
    throw contractError('APP_ARTIFACT_IDENTITY_MISMATCH', `installed App identity differs from the frozen artifact: ${mismatches.join(', ')}`);
  }
  return result;
}

function validatePreparationPolicy(value = null) {
  const policy = value || { schemaVersion: PREPARATION_POLICY_SCHEMA_VERSION, allowedEffects: [], targetAppOnly: true };
  ensureObject(policy, 'preparationPolicy', 'PREPARATION_POLICY_INVALID');
  if (policy.schemaVersion !== PREPARATION_POLICY_SCHEMA_VERSION) {
    throw contractError('PREPARATION_POLICY_INVALID', `preparationPolicy.schemaVersion must be ${PREPARATION_POLICY_SCHEMA_VERSION}`);
  }
  const allowed = new Set(['schemaVersion', 'allowedEffects', 'targetAppOnly', 'userAuthorization']);
  const unsupported = Object.keys(policy).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('PREPARATION_POLICY_INVALID', `preparationPolicy contains unsupported fields: ${unsupported.join(', ')}`);
  const effects = ensureArray(policy.allowedEffects, 'preparationPolicy.allowedEffects', 'PREPARATION_POLICY_INVALID');
  for (const [index, effect] of effects.entries()) {
    ensureString(effect, `preparationPolicy.allowedEffects[${index}]`, 'PREPARATION_POLICY_INVALID');
    if (!PREPARATION_EFFECTS.has(effect)) throw contractError('PREPARATION_POLICY_INVALID', `unsupported preparation effect: ${effect}`);
  }
  if (new Set(effects).size !== effects.length) throw contractError('PREPARATION_POLICY_INVALID', 'preparationPolicy.allowedEffects must not contain duplicates');
  if (policy.targetAppOnly !== true) throw contractError('PREPARATION_POLICY_INVALID', 'preparationPolicy.targetAppOnly must be true');
  if (effects.length) ensureString(policy.userAuthorization, 'preparationPolicy.userAuthorization', 'PREPARATION_POLICY_INVALID');
  return { ...policy, allowedEffects: [...effects] };
}

function preparationPolicySha(value) {
  return sha256(canonicalJson(validatePreparationPolicy(value)), 'preparation-policy', 24);
}

function validateInitialStateRequirement(value = null) {
  const requirement = value || {
    schemaVersion: INITIAL_STATE_REQUIREMENT_SCHEMA_VERSION,
    targetState: 'KEEP_EXISTING',
    rationale: 'The case does not require an App state reset',
  };
  ensureObject(requirement, 'initialStateRequirement', 'INITIAL_STATE_REQUIREMENT_INVALID');
  const allowed = new Set(['schemaVersion', 'targetState', 'rationale']);
  const unsupported = Object.keys(requirement).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('INITIAL_STATE_REQUIREMENT_INVALID', `initialStateRequirement contains unsupported fields: ${unsupported.join(', ')}`);
  if (requirement.schemaVersion !== INITIAL_STATE_REQUIREMENT_SCHEMA_VERSION || !INITIAL_STATE_TARGETS.has(requirement.targetState)) {
    throw contractError('INITIAL_STATE_REQUIREMENT_INVALID', 'initialStateRequirement schemaVersion or targetState is invalid');
  }
  ensureString(requirement.rationale, 'initialStateRequirement.rationale', 'INITIAL_STATE_REQUIREMENT_INVALID');
  return { ...requirement };
}

function initialStateRequirementSha(value) {
  return sha256(canonicalJson(validateInitialStateRequirement(value)), 'initial-state-requirement', 24);
}

function initialStateStrategy(platform, targetState) {
  if (targetState === 'KEEP_EXISTING') return { strategy: 'NONE', requiredEffects: [] };
  const strategy = targetState === 'FRESH_INSTALL' || platform === 'ios' ? 'REINSTALL_APP' : 'CLEAR_APP_DATA';
  return {
    strategy,
    requiredEffects: strategy === 'REINSTALL_APP'
      ? ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'] : ['CLEAR_APP_DATA'],
  };
}

function initialStatePreflightSha(value) {
  const unsigned = { ...value };
  delete unsigned.preflightSha;
  return sha256(canonicalJson(unsigned), 'initial-state-preflight', 24);
}

function createInitialStatePreflight(options) {
  const requirement = validateInitialStateRequirement(options.requirement);
  const policy = validatePreparationPolicy(options.preparationPolicy);
  const provisioning = validateAppProvisioning(options.appProvisioning, options.provisioningOptions || {});
  const platform = ensureString(options.platform, 'initialStatePreflight.platform', 'INITIAL_STATE_PREFLIGHT_INVALID');
  if (!Object.prototype.hasOwnProperty.call(FORMATS, platform)) {
    throw contractError('INITIAL_STATE_PREFLIGHT_INVALID', `unsupported initial state platform: ${platform}`);
  }
  const checkedAt = ensureString(options.now || new Date().toISOString(), 'initialStatePreflight.checkedAt', 'INITIAL_STATE_PREFLIGHT_INVALID');
  if (Number.isNaN(Date.parse(checkedAt))) {
    throw contractError('INITIAL_STATE_PREFLIGHT_INVALID', 'initialStatePreflight.checkedAt must be a timestamp');
  }
  const { strategy, requiredEffects } = initialStateStrategy(platform, requirement.targetState);
  const missing = requiredEffects.filter((effect) => !policy.allowedEffects.includes(effect));
  if (missing.length) {
    throw contractError('INITIAL_STATE_PREFLIGHT_FAILED', `initial state is not authorized: ${missing.join(', ')}`);
  }
  if (strategy === 'REINSTALL_APP' && provisioning.mode !== 'ARTIFACT_MANAGED') {
    throw contractError('INITIAL_STATE_PREFLIGHT_FAILED', 'initial state requires a frozen installation artifact');
  }
  const value = {
    schemaVersion: INITIAL_STATE_PREFLIGHT_SCHEMA_VERSION,
    status: 'READY',
    targetState: requirement.targetState,
    strategy,
    requiredEffects,
    requirementSha: initialStateRequirementSha(requirement),
    preparationPolicySha: preparationPolicySha(policy),
    appProvisioningSha: appProvisioningSha(provisioning),
    platform,
    checkedAt,
  };
  value.preflightSha = initialStatePreflightSha(value);
  return value;
}

function validateInitialStatePreflight(value, context) {
  ensureObject(value, 'initialStatePreflight', 'INITIAL_STATE_PREFLIGHT_INVALID');
  ensureString(value.checkedAt, 'initialStatePreflight.checkedAt', 'INITIAL_STATE_PREFLIGHT_INVALID');
  if (Number.isNaN(Date.parse(value.checkedAt))) {
    throw contractError('INITIAL_STATE_PREFLIGHT_INVALID', 'initialStatePreflight.checkedAt must be a timestamp');
  }
  const expected = createInitialStatePreflight({ ...context, now: value.checkedAt });
  if (canonicalJson(value) !== canonicalJson(expected) || value.preflightSha !== initialStatePreflightSha(value)) {
    throw contractError('INITIAL_STATE_PREFLIGHT_INVALID', 'initial state preflight does not match its frozen inputs');
  }
  return value;
}

function validateBootstrapPolicy(value = null) {
  const policy = value || {
    schemaVersion: BOOTSTRAP_POLICY_SCHEMA_VERSION,
    mode: 'KEEP_EXISTING',
    allowedEffects: [],
    targetAppOnly: true,
    userAuthorization: null,
  };
  ensureObject(policy, 'bootstrapPolicy', 'BOOTSTRAP_POLICY_INVALID');
  const allowed = new Set(['schemaVersion', 'mode', 'allowedEffects', 'targetAppOnly', 'userAuthorization']);
  const unsupported = Object.keys(policy).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('BOOTSTRAP_POLICY_INVALID', `bootstrapPolicy contains unsupported fields: ${unsupported.join(', ')}`);
  if (policy.schemaVersion !== BOOTSTRAP_POLICY_SCHEMA_VERSION || !BOOTSTRAP_MODES.has(policy.mode)) {
    throw contractError('BOOTSTRAP_POLICY_INVALID', 'bootstrapPolicy schemaVersion or mode is invalid');
  }
  const effects = ensureArray(policy.allowedEffects, 'bootstrapPolicy.allowedEffects', 'BOOTSTRAP_POLICY_INVALID');
  if (new Set(effects).size !== effects.length || effects.some((effect) => !PREPARATION_EFFECTS.has(effect))) {
    throw contractError('BOOTSTRAP_POLICY_INVALID', 'bootstrapPolicy.allowedEffects contains an unsupported or duplicate effect');
  }
  if (policy.targetAppOnly !== true) throw contractError('BOOTSTRAP_POLICY_INVALID', 'bootstrapPolicy.targetAppOnly must be true');
  if (policy.mode === 'KEEP_EXISTING' && effects.length) {
    throw contractError('BOOTSTRAP_POLICY_INVALID', 'KEEP_EXISTING cannot authorize destructive effects');
  }
  if (policy.mode === 'REINSTALL_FROZEN') {
    const required = ['UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'];
    const missing = required.filter((effect) => !effects.includes(effect));
    if (missing.length) throw contractError('BOOTSTRAP_POLICY_INVALID', `REINSTALL_FROZEN requires: ${missing.join(', ')}`);
    ensureString(policy.userAuthorization, 'bootstrapPolicy.userAuthorization', 'BOOTSTRAP_POLICY_INVALID');
  }
  return { ...policy, allowedEffects: [...effects], userAuthorization: policy.userAuthorization || null };
}

function bootstrapPolicySha(value) {
  return sha256(canonicalJson(validateBootstrapPolicy(value)), 'bootstrap-policy', 24);
}

function defaultAppProvisioning() {
  return { schemaVersion: APP_PROVISIONING_SCHEMA_VERSION, mode: 'PREINSTALLED' };
}

function validateAppProvisioning(value = null, options = {}) {
  const provisioning = value || defaultAppProvisioning();
  ensureObject(provisioning, 'appProvisioning', 'APP_PROVISIONING_INVALID');
  if (provisioning.schemaVersion !== APP_PROVISIONING_SCHEMA_VERSION || !PROVISIONING_MODES.has(provisioning.mode)) {
    throw contractError('APP_PROVISIONING_INVALID', 'appProvisioning schemaVersion or mode is invalid');
  }
  if (provisioning.mode === 'PREINSTALLED') {
    if (Object.keys(provisioning).some((field) => !['schemaVersion', 'mode'].includes(field))) {
      throw contractError('APP_PROVISIONING_INVALID', 'PREINSTALLED provisioning cannot contain an installation artifact');
    }
    return { ...provisioning };
  }
  const allowed = new Set([
    'schemaVersion', 'mode', 'artifactRef', 'format', 'platform', 'deviceType', 'appId', 'version', 'build',
    'sha256', 'size', 'artifactPath', 'registeredAt', 'artifactIdentity',
  ]);
  const unsupported = Object.keys(provisioning).filter((field) => !allowed.has(field));
  if (unsupported.length) throw contractError('APP_PROVISIONING_INVALID', `appProvisioning contains unsupported fields: ${unsupported.join(', ')}`);
  for (const field of ['artifactRef', 'format', 'platform', 'appId', 'version', 'build', 'sha256', 'artifactPath', 'registeredAt']) {
    ensureString(provisioning[field], `appProvisioning.${field}`, 'APP_PROVISIONING_INVALID');
  }
  if (!FORMATS[provisioning.platform]?.has(provisioning.format)) throw contractError('APP_PROVISIONING_INVALID', 'artifact format does not match platform');
  if (options.platform && provisioning.platform !== options.platform) throw contractError('APP_PROVISIONING_INVALID', 'artifact platform does not match environment');
  if (options.appId && provisioning.appId !== options.appId) throw contractError('APP_PROVISIONING_INVALID', 'artifact App identity does not match environment');
  if (!/^[0-9a-f]{64}$/.test(provisioning.sha256) || provisioning.artifactRef !== `app-artifact-${provisioning.sha256.slice(0, 24)}`) {
    throw contractError('APP_PROVISIONING_INVALID', 'artifact identity does not match its SHA-256');
  }
  if (!Number.isInteger(provisioning.size) || provisioning.size < 0) throw contractError('APP_PROVISIONING_INVALID', 'artifact size is invalid');
  if (provisioning.platform === 'ios') {
    if (!['simulator', 'realDevice'].includes(provisioning.deviceType)) throw contractError('APP_PROVISIONING_INVALID', 'iOS artifact requires simulator or realDevice deviceType');
    if (provisioning.deviceType === 'simulator' && provisioning.format !== 'APP') throw contractError('APP_PROVISIONING_INVALID', 'iOS simulator requires an APP artifact');
    if (provisioning.deviceType === 'realDevice' && !['IPA', 'APP'].includes(provisioning.format)) throw contractError('APP_PROVISIONING_INVALID', 'iOS real device requires an IPA or APP artifact');
    if (options.deviceType && provisioning.deviceType !== options.deviceType) throw contractError('APP_PROVISIONING_INVALID', 'iOS artifact device type does not match environment');
  } else if (provisioning.deviceType !== undefined) {
    throw contractError('APP_PROVISIONING_INVALID', 'deviceType only belongs to iOS provisioning');
  }
  if (Number.isNaN(Date.parse(provisioning.registeredAt))) throw contractError('APP_PROVISIONING_INVALID', 'artifact registeredAt is invalid');
  const artifactIdentity = ensureObject(provisioning.artifactIdentity, 'appProvisioning.artifactIdentity', 'APP_PROVISIONING_INVALID');
  const expectedIdentity = { appId: provisioning.appId, version: provisioning.version, build: provisioning.build };
  if (canonicalJson(artifactIdentity.expected) !== canonicalJson(expectedIdentity)) {
    throw contractError('APP_PROVISIONING_INVALID', 'artifactIdentity.expected does not match provisioning metadata');
  }
  normalizeIdentityInspection(artifactIdentity.inspection, expectedIdentity);
  if (options.workspaceRoot) {
    const root = artifactRoot(options.workspaceRoot);
    const resolved = path.resolve(provisioning.artifactPath);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw contractError('APP_INSTALL_ARTIFACT_INVALID', 'artifact path is outside the workspace cache');
    if (!fs.existsSync(resolved)) throw contractError('APP_INSTALL_ARTIFACT_UNAVAILABLE', 'frozen installation artifact is unavailable');
    const realRoot = fs.realpathSync(root);
    const realArtifact = fs.realpathSync(resolved);
    const realRelative = path.relative(realRoot, realArtifact);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw contractError('APP_INSTALL_ARTIFACT_INVALID', 'artifact resolves outside the workspace cache');
    }
    const digest = contentDigest(resolved);
    if (digest.sha256 !== provisioning.sha256 || digest.size !== provisioning.size) throw contractError('APP_INSTALL_ARTIFACT_MISMATCH', 'frozen installation artifact content changed');
  }
  return { ...provisioning };
}

function appProvisioningSha(value) {
  return sha256(canonicalJson(validateAppProvisioning(value)), 'app-provisioning', 24);
}

function registerAppArtifact(options) {
  const source = path.resolve(ensureString(options.sourcePath, 'sourcePath', 'APP_INSTALL_ARTIFACT_INVALID'));
  if (!fs.existsSync(source)) throw contractError('APP_INSTALL_ARTIFACT_UNAVAILABLE', `installation artifact does not exist: ${source}`);
  const platform = ensureString(options.platform, 'platform', 'APP_INSTALL_ARTIFACT_INVALID').toLowerCase();
  const format = String(options.format || inferFormat(source)).toUpperCase();
  const appId = ensureString(options.appId, 'appId', 'APP_INSTALL_ARTIFACT_INVALID');
  const version = ensureString(options.version, 'version', 'APP_INSTALL_ARTIFACT_INVALID');
  const build = ensureString(options.build, 'build', 'APP_INSTALL_ARTIFACT_INVALID');
  const expectedIdentity = { appId, version, build };
  const inspection = normalizeIdentityInspection(inspectArtifactIdentity({ ...options, sourcePath: source, platform, format }), expectedIdentity);
  const digest = contentDigest(source);
  const cacheRoot = artifactRoot(options.workspaceRoot);
  fs.mkdirSync(cacheRoot, { recursive: true });
  if (fs.lstatSync(cacheRoot).isSymbolicLink()) throw contractError('APP_INSTALL_ARTIFACT_INVALID', 'artifact cache must not be a symbolic link');
  const destinationDir = path.join(cacheRoot, digest.sha256);
  const destination = path.join(destinationDir, path.basename(source));
  const manifestPath = path.join(destinationDir, 'manifest.json');
  fs.mkdirSync(destinationDir, { recursive: true });
  if (fs.lstatSync(destinationDir).isSymbolicLink()) throw contractError('APP_INSTALL_ARTIFACT_INVALID', 'artifact cache entry must not be a symbolic link');
  if (fs.existsSync(manifestPath)) {
    if (fs.lstatSync(manifestPath).isSymbolicLink()) throw contractError('APP_INSTALL_ARTIFACT_CONFLICT', 'cached artifact manifest must not be a symbolic link');
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw contractError('APP_INSTALL_ARTIFACT_CONFLICT', `cached artifact manifest is invalid: ${error.message}`);
    }
    const validated = validateAppProvisioning(existing, {
      workspaceRoot: options.workspaceRoot,
      platform,
      appId,
      deviceType: options.deviceType,
    });
    const expected = { format, platform, appId, version, build, sha256: digest.sha256, size: digest.size };
    if (Object.entries(expected).some(([field, value]) => validated[field] !== value)
      || (platform === 'ios' && validated.deviceType !== options.deviceType)) {
      throw contractError('APP_INSTALL_ARTIFACT_CONFLICT', 'the same artifact content is already registered with different metadata');
    }
    return validated;
  }
  if (!fs.existsSync(destination)) fs.cpSync(source, destination, { recursive: true, errorOnExist: true, preserveTimestamps: false });
  const value = {
    schemaVersion: APP_PROVISIONING_SCHEMA_VERSION,
    mode: 'ARTIFACT_MANAGED',
    artifactRef: `app-artifact-${digest.sha256.slice(0, 24)}`,
    format,
    platform,
    ...(platform === 'ios' ? { deviceType: options.deviceType } : {}),
    appId,
    version,
    build,
    artifactIdentity: { expected: expectedIdentity, inspection },
    sha256: digest.sha256,
    size: digest.size,
    artifactPath: destination,
    registeredAt: options.now || new Date().toISOString(),
  };
  const validated = validateAppProvisioning(value, {
    workspaceRoot: options.workspaceRoot,
    platform,
    appId,
    deviceType: options.deviceType,
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx' });
  return validated;
}

module.exports = {
  APP_PROVISIONING_SCHEMA_VERSION,
  BOOTSTRAP_MODES,
  BOOTSTRAP_POLICY_SCHEMA_VERSION,
  INITIAL_STATE_PREFLIGHT_SCHEMA_VERSION,
  INITIAL_STATE_REQUIREMENT_SCHEMA_VERSION,
  INITIAL_STATE_TARGETS,
  PREPARATION_EFFECTS,
  PREPARATION_POLICY_SCHEMA_VERSION,
  TARGET_STATES,
  appProvisioningSha,
  artifactRoot,
  bootstrapPolicySha,
  contentDigest,
  defaultAppProvisioning,
  inspectArtifactIdentity,
  preparationPolicySha,
  createInitialStatePreflight,
  initialStatePreflightSha,
  initialStateRequirementSha,
  initialStateStrategy,
  registerAppArtifact,
  validateAppProvisioning,
  validateBootstrapPolicy,
  validateInstalledAppIdentity,
  validatePreparationPolicy,
  validateInitialStatePreflight,
  validateInitialStateRequirement,
};
