#!/usr/bin/env node
'use strict';

const { validateAgentJson } = require('./agent-json-contract');

const INTERNAL_INTERFACE_KIND = 'INTERNAL';
const PLATFORM_SCHEMA = { type: 'string', enum: ['harmony', 'android', 'ios'] };
const STRING = { type: 'string', minLength: 1 };

const BINDING_SCHEMA = {
  type: 'object',
  required: ['platform', 'deviceId', 'appId'],
  additionalProperties: true,
  properties: {
    platform: PLATFORM_SCHEMA,
    deviceId: STRING,
    appId: STRING,
    entry: STRING,
    deviceType: { type: 'string', enum: ['simulator', 'realDevice'] },
    deviceFormFactor: { type: 'string', enum: ['phone', 'tablet', 'foldable', 'widefold', 'triplefold', '2in1', '2in1 foldable', 'wearable', 'tv'] },
    startupDisplayPolicy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        orientation: { type: 'string', enum: ['portrait', 'preserve'] },
        enforcement: { type: 'string', enum: ['required', 'none'] },
        appliesTo: { type: 'array', items: { type: 'string', enum: ['phone', 'tablet', 'foldable', 'widefold', 'triplefold', '2in1', '2in1 foldable', 'wearable', 'tv'] } },
      },
    },
    appiumServer: STRING,
    wdaLocalPort: { type: 'integer', minimum: 1 },
    webDriverAgentUrl: STRING,
    xcodeOrgId: STRING,
    xcodeSigningId: STRING,
    updatedWDABundleId: STRING,
    showXcodeLog: { type: 'boolean' },
    showIOSLog: { type: 'boolean' },
    useNewWDA: { type: 'boolean' },
    allowProvisioningDeviceRegistration: { type: 'boolean' },
    wdaLaunchTimeout: { type: 'integer', minimum: 1 },
    derivedDataPath: STRING,
  },
  refinements: [
    { fieldPath: 'entry', expected: 'required when platform is harmony or android' },
    { fieldPath: 'deviceFormFactor', expected: 'HarmonyOS only' },
    { fieldPath: 'iOS options', expected: 'deviceType and Appium/WDA/signing fields belong to ios only' },
  ],
};

const PROBE_SCHEMA = {
  type: 'object',
  required: ['platform', 'ready', 'devices'],
  additionalProperties: true,
  properties: {
    schemaVersion: { const: 1 },
    type: { const: 'environmentProbe' },
    platform: PLATFORM_SCHEMA,
    ready: { type: 'boolean' },
    devices: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

const APP_PROVISIONING_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'mode'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 2 },
    mode: { type: 'string', enum: ['PREINSTALLED', 'ARTIFACT_MANAGED'] },
    artifactRef: STRING,
    format: { type: 'string', enum: ['APK', 'HAP', 'APP', 'IPA'] },
    platform: PLATFORM_SCHEMA,
    deviceType: { type: 'string', enum: ['simulator', 'realDevice'] },
    appId: STRING,
    version: STRING,
    build: STRING,
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    size: { type: 'integer', minimum: 0 },
    artifactPath: STRING,
    registeredAt: { type: 'string', format: 'date-time' },
    artifactIdentity: { type: 'object', additionalProperties: true },
  },
  refinements: [
    { fieldPath: '', expected: 'PREINSTALLED contains only schemaVersion and mode; ARTIFACT_MANAGED uses the exact manifest returned by app-artifact register' },
  ],
};

const TARGETS_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    required: ['caseNo', 'definitionRef'],
    additionalProperties: false,
    properties: {
      caseNo: STRING,
      definitionRef: {
        type: 'object',
        required: ['definitionId', 'definitionSha'],
        additionalProperties: false,
        properties: { definitionId: STRING, definitionSha: STRING },
      },
    },
  },
};

const BOOTSTRAP_POLICY_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'mode', 'allowedEffects', 'targetAppOnly'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    mode: { type: 'string', enum: ['KEEP_EXISTING', 'REINSTALL_FROZEN'] },
    allowedEffects: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: ['CLEAR_APP_DATA', 'UNINSTALL_TARGET_APP', 'INSTALL_FROZEN_ARTIFACT'] },
    },
    targetAppOnly: { const: true },
    userAuthorization: { description: 'Optional user authorization text or null' },
  },
  refinements: [
    { fieldPath: 'allowedEffects', expected: 'empty for KEEP_EXISTING; includes UNINSTALL_TARGET_APP and INSTALL_FROZEN_ARTIFACT for REINSTALL_FROZEN' },
  ],
};

function flag(required, description, extra = {}) {
  return { required, description, ...extra };
}

function command(name, summary, usage, flags, example, responses, positionals = []) {
  return { name, summary, usage, positionals, flags, example, responses };
}

const commonBatchFlags = {
  workspace: flag(true, 'Absolute or relative MAVT workspace path', { value: '<workspace>' }),
  batchId: flag(true, 'Execution request and batch identifier', { value: '<batch-id>' }),
};

const iosEnvironmentFlags = {
  device: flag(false, 'Explicit device serial or UDID', { value: '<device-id>' }),
  deviceType: flag(false, 'iOS device kind', { value: '<simulator|realDevice>', enum: ['simulator', 'realDevice'] }),
  appiumServer: flag(false, 'Existing Appium server URL', { value: '<url>' }),
  wdaLocalPort: flag(false, 'Local WebDriverAgent port', { value: '<port>' }),
  webDriverAgentUrl: flag(false, 'Existing WebDriverAgent URL', { value: '<url>' }),
  xcodeOrgId: flag(false, 'Apple development team identifier for real-device WDA', { value: '<team-id>' }),
  xcodeSigningId: flag(false, 'Signing identity for real-device WDA', { value: '<identity>' }),
  updatedWdaBundleId: flag(false, 'Unique WDA bundle identifier for real devices', { value: '<bundle-id>' }),
  showXcodeLog: flag(false, 'Enable Xcode build logging', { value: '[true|false]' }),
  showIosLog: flag(false, 'Enable iOS device logging', { value: '[true|false]' }),
  useNewWda: flag(false, 'Force a new WDA deployment', { value: '[true|false]' }),
  allowProvisioningDeviceRegistration: flag(false, 'Allow Xcode to register the real device', { value: '[true|false]' }),
  wdaLaunchTimeout: flag(false, 'WDA launch timeout in milliseconds', { value: '<ms>' }),
  derivedDataPath: flag(false, 'Xcode DerivedData path', { value: '<path>' }),
};

const INTERFACE_CONTRACT_DEFINITIONS = {
  'scripts/workspace.js': {
    summary: 'Validate or initialize a MAVT workspace and return this coordinator capability index',
    commands: [command(null, 'Open the workspace', 'node scripts/workspace.js --cwd <workspace>', {
      cwd: flag(true, 'Workspace path', { value: '<workspace>' }),
    }, ['node', 'scripts/workspace.js', '--cwd', '<workspace>'], ['workspace metadata and coordinatorCapabilities'])],
  },
  'scripts/import-case.js': {
    summary: 'Import a non-empty source file as a workspace case without interpreting its business semantics',
    commands: [command(null, 'Import one source file', 'node scripts/import-case.js <input-file> --workspace <workspace>', {
      workspace: flag(true, 'Workspace path', { value: '<workspace>' }),
    }, ['node', 'scripts/import-case.js', '<input-file>', '--workspace', '<workspace>'], ['imported case metadata'], [
      { name: 'input-file', required: true, description: 'Path to the source test-case file' },
    ])],
  },
  'scripts/case-definition.js': {
    summary: 'Inspect, load, or publish an immutable CaseDefinition',
    commands: [
      command('status', 'Check whether a case has a published definition', 'node scripts/case-definition.js status (--case-dir <case-dir> | --workspace <workspace> --case-no <no>)', {
        caseDir: flag(false, 'Case directory', { value: '<case-dir>' }), workspace: flag(false, 'Workspace path', { value: '<workspace>' }), caseNo: flag(false, 'Display case number', { value: '<no>' }),
      }, ['node', 'scripts/case-definition.js', 'status', '--workspace', '<workspace>', '--case-no', '<no>'], ['READY', 'CASE_DEFINITION_REQUIRED']),
      command('load-source', 'Load one source and its publisher contract for an isolated Compiler', 'node scripts/case-definition.js load-source (--case-dir <case-dir> | --workspace <workspace> --case-no <no>)', {
        caseDir: flag(false, 'Case directory', { value: '<case-dir>' }), workspace: flag(false, 'Workspace path', { value: '<workspace>' }), caseNo: flag(false, 'Display case number', { value: '<no>' }),
      }, ['node', 'scripts/case-definition.js', 'load-source', '--case-dir', '<case-dir>'], ['source, Compiler Prompt, and publisher contract']),
      command('publish', 'Publish a compiler candidate using the contract returned by load-source', 'node scripts/case-definition.js publish --case-dir <case-dir> --compiler-profile-sha <sha> --candidate-json <json>', {
        caseDir: flag(true, 'Case directory supplied by the Loader', { value: '<case-dir>' }),
        compilerProfileSha: flag(false, 'Compiler profile digest', { value: '<sha>' }),
        candidateJson: flag(true, 'Candidate matching publisher.contract', { value: '<json>', contractSource: 'load-source.publisher.contract' }),
      }, ['node', 'scripts/case-definition.js', 'publish', '--case-dir', '<case-dir>', '--compiler-profile-sha', '<sha>', '--candidate-json', '<publisher.contract.example>'], ['published CaseDefinition']),
    ],
  },
  'scripts/build-agent-contract.js': {
    summary: 'Build and optionally verify the role-scoped Agent protocol and implementation digests',
    commands: [command(null, 'Build an Agent contract', 'node scripts/build-agent-contract.js --role <case-executor|batch-coordinator> --platform <harmony|android|ios> [--skill-root <path>] [--verify-sha <sha>]', {
      role: flag(true, 'Agent role', { value: '<role>', enum: ['case-executor', 'batch-coordinator'] }),
      platform: flag(true, 'Target platform', { value: '<platform>', enum: ['harmony', 'android', 'ios'] }),
      skillRoot: flag(false, 'Skill root override', { value: '<path>' }),
      verifySha: flag(false, 'Expected protocol SHA', { value: '<sha>' }),
    }, ['node', 'scripts/build-agent-contract.js', '--role', 'batch-coordinator', '--platform', 'harmony'], ['role-scoped Agent contract'])],
  },
  'scripts/probe-env.sh': {
    summary: 'Read platform and device capabilities without choosing or launching a target App',
    commands: [command(null, 'Probe a platform', 'scripts/probe-env.sh --platform <harmony|android|ios> [platform options]', {
      platform: flag(true, 'Platform to probe', { value: '<platform>', enum: ['harmony', 'android', 'ios'] }),
      device: flag(false, 'Explicit device serial or UDID', { value: '<device-id>' }),
      deviceFormFactor: flag(false, 'HarmonyOS static device form factor override', { value: '<form-factor>', enum: ['phone', 'tablet', 'foldable', 'widefold', 'triplefold', '2in1', '2in1 foldable', 'wearable', 'tv'] }),
      ...iosEnvironmentFlags,
    }, ['scripts/probe-env.sh', '--platform', 'harmony', '--device', '<device-id>'], ['environmentProbe matching probeJson schema'])],
  },
  'scripts/prepare-env.sh': {
    summary: 'Prepare platform tooling dependencies before environment confirmation',
    commands: [command(null, 'Prepare a platform', 'scripts/prepare-env.sh --platform <harmony|android|ios> [platform options]', {
      platform: flag(true, 'Platform to prepare', { value: '<platform>', enum: ['harmony', 'android', 'ios'] }),
      ...iosEnvironmentFlags,
    }, ['scripts/prepare-env.sh', '--platform', 'android', '--device', '<device-id>'], ['environmentPrepare result'])],
  },
  'scripts/environment.js': {
    summary: 'Persist or read the user-confirmed target environment',
    commands: [
      command('confirm', 'Confirm a probed device and target App', 'node scripts/environment.js confirm --workspace <workspace> --binding-json <json> --probe-json <json> [--app-provisioning-json <json>] --user-confirmation <text>', {
        workspace: flag(true, 'Workspace path', { value: '<workspace>' }),
        bindingJson: flag(true, 'Selected platform, device, and App binding', { value: '<json>', jsonSchema: BINDING_SCHEMA }),
        probeJson: flag(true, 'Unmodified successful probe response', { value: '<json>', jsonSchema: PROBE_SCHEMA }),
        appProvisioningJson: flag(false, 'Manifest returned by app-artifact register; omit for PREINSTALLED', { value: '<json>', jsonSchema: APP_PROVISIONING_SCHEMA }),
        userConfirmation: flag(true, 'User statement confirming this exact environment', { value: '<text>' }),
      }, ['node', 'scripts/environment.js', 'confirm', '--workspace', '<workspace>', '--binding-json', '{"platform":"harmony","deviceId":"<device-id>","appId":"<app-id>","entry":"<entry>"}', '--probe-json', '<probe response>', '--user-confirmation', '<confirmation>'], ['CONFIRMED']),
      command('status', 'Read the current environment confirmation', 'node scripts/environment.js status --workspace <workspace>', {
        workspace: flag(true, 'Workspace path', { value: '<workspace>' }),
      }, ['node', 'scripts/environment.js', 'status', '--workspace', '<workspace>'], ['current environment confirmation']),
    ],
  },
  'scripts/app-artifact.js': {
    summary: 'Validate and freeze an installation artifact in the workspace cache',
    commands: [command('register', 'Register an installation artifact', 'node scripts/app-artifact.js register --workspace <workspace> --path <artifact> --platform <harmony|android|ios> --app-id <id> --version <version> --build <build> [--format <format>] [--device-type <simulator|realDevice>]', {
      workspace: flag(true, 'Workspace path', { value: '<workspace>' }), path: flag(true, 'APK, HAP, APP, or IPA path', { value: '<artifact>' }),
      platform: flag(true, 'Artifact platform', { value: '<platform>', enum: ['harmony', 'android', 'ios'] }), appId: flag(true, 'Expected App identifier', { value: '<id>' }),
      version: flag(true, 'Expected semantic version', { value: '<version>' }), build: flag(true, 'Expected build identifier', { value: '<build>' }),
      format: flag(false, 'Explicit artifact format', { value: '<APK|HAP|APP|IPA>', enum: ['APK', 'HAP', 'APP', 'IPA'] }),
      deviceType: flag(false, 'Required for iOS', { value: '<simulator|realDevice>', enum: ['simulator', 'realDevice'] }),
    }, ['node', 'scripts/app-artifact.js', 'register', '--workspace', '<workspace>', '--path', '<artifact>', '--platform', 'harmony', '--app-id', '<app-id>', '--version', '<version>', '--build', '<build>'], ['ARTIFACT_MANAGED provisioning manifest'])],
  },
  'scripts/execution-request.js': {
    summary: 'Create or read an explicit execution authorization',
    commands: [
      command('create', 'Freeze authorized targets and execution policies', 'node scripts/execution-request.js create --workspace <workspace> --batch-id <id> --mode <single|batch> --targets-json <json> [--bootstrap-policy-json <json>] --user-instruction <text>', {
        ...commonBatchFlags,
        mode: flag(true, 'Execution cardinality', { value: '<single|batch>', enum: ['single', 'batch'] }),
        targetsJson: flag(true, 'Non-empty target list using published definition references', { value: '<json>', jsonSchema: TARGETS_SCHEMA }),
        bootstrapPolicyJson: flag(false, 'Batch-level App bootstrap authorization; omit for KEEP_EXISTING', { value: '<json>', jsonSchema: BOOTSTRAP_POLICY_SCHEMA }),
        userInstruction: flag(true, 'The user instruction authorizing this execution', { value: '<text>' }),
      }, ['node', 'scripts/execution-request.js', 'create', '--workspace', '<workspace>', '--batch-id', '<batch-id>', '--mode', 'single', '--targets-json', '[{"caseNo":"004","definitionRef":{"definitionId":"<id>","definitionSha":"<sha>"}}]', '--user-instruction', '<instruction>'], ['frozen execution request']),
      command('status', 'Read an execution request', 'node scripts/execution-request.js status --workspace <workspace> --batch-id <id>', commonBatchFlags,
        ['node', 'scripts/execution-request.js', 'status', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['current execution request']),
    ],
  },
  'scripts/knowledge.js': {
    summary: 'Validate built-in and workspace knowledge before creating a new execution request',
    commands: [command('validate', 'Validate knowledge roots', 'node scripts/knowledge.js validate --workspace <workspace> [--now <iso-time>]', {
      workspace: flag(true, 'Workspace path', { value: '<workspace>' }), now: flag(false, 'Validation clock override', { value: '<iso-time>' }),
    }, ['node', 'scripts/knowledge.js', 'validate', '--workspace', '<workspace>'], ['knowledge validation summary'])],
  },
  'scripts/batch.js': {
    summary: 'Drive the deterministic batch state machine',
    commands: [
      command('init', 'Initialize from an existing execution request', 'node scripts/batch.js init --workspace <workspace> --batch-id <id>', commonBatchFlags, ['node', 'scripts/batch.js', 'init', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['INITIALIZING']),
      command('bootstrap', 'Acquire the platform runtime and establish the warm session', 'node scripts/batch.js bootstrap --workspace <workspace> --batch-id <id>', commonBatchFlags, ['node', 'scripts/batch.js', 'bootstrap', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['batch state or terminal closure']),
      command('reconcile', 'Advance all deterministic transitions until Agent work or terminal state', 'node scripts/batch.js reconcile --workspace <workspace> --batch-id <id>', commonBatchFlags, ['node', 'scripts/batch.js', 'reconcile', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['BOOTSTRAP', 'NEED_CASE_AGENT', 'WAIT_EXECUTION_RESULT', 'BATCH_COMPLETE', 'BATCH_CANCELLED', 'BATCH_BLOCKED']),
      command('start', 'Create the next opaque Case Agent Handoff', 'node scripts/batch.js start --workspace <workspace> --batch-id <id> [--continuation-reason <reason>]', {
        ...commonBatchFlags, continuationReason: flag(false, 'Required only when replacing a lost Agent handle', { value: '<reason>' }),
      }, ['node', 'scripts/batch.js', 'start', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['Agent dispatch metadata and optional opaque handoff']),
      command('commit', 'Commit a completed current execution and refresh its report', 'node scripts/batch.js commit --workspace <workspace> --batch-id <id>', commonBatchFlags, ['node', 'scripts/batch.js', 'commit', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['committed case and dashboard refresh status']),
      command('status', 'Read batch state without advancing it', 'node scripts/batch.js status --workspace <workspace> --batch-id <id>', commonBatchFlags, ['node', 'scripts/batch.js', 'status', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['batch state and platform runtime status']),
      command('cancel', 'Record user cancellation', 'node scripts/batch.js cancel --workspace <workspace> --batch-id <id> --reason <reason>', {
        ...commonBatchFlags, reason: flag(true, 'Cancellation reason', { value: '<reason>' }),
      }, ['node', 'scripts/batch.js', 'cancel', '--workspace', '<workspace>', '--batch-id', '<batch-id>', '--reason', '<reason>'], ['CANCELLING or terminal closure']),
      command('teardown', 'Release platform resources without cancelling business execution', 'node scripts/batch.js teardown --workspace <workspace> --batch-id <id>', commonBatchFlags, ['node', 'scripts/batch.js', 'teardown', '--workspace', '<workspace>', '--batch-id', '<batch-id>'], ['batch state and platform cleanup result']),
    ],
  },
  'scripts/render-context.js': {
    summary: 'Rebuild one case report from immutable artifacts',
    commands: [command(null, 'Render a case detail report', 'node scripts/render-context.js <case-dir> [--platform <harmony|android|ios>]', {
      platform: flag(false, 'Optional platform-specific report', { value: '<platform>', enum: ['harmony', 'android', 'ios'] }),
    }, ['node', 'scripts/render-context.js', '<case-dir>'], ['absolute context.html path'], [{ name: 'case-dir', required: true, description: 'Case directory' }])],
  },
  'scripts/render-index.js': {
    summary: 'Rebuild the workspace dashboard from independently readable cases',
    commands: [command(null, 'Render the workspace index', 'node scripts/render-index.js [workspace-cwd]', {}, ['node', 'scripts/render-index.js', '<workspace>'], ['absolute index.html path'], [
      { name: 'workspace-cwd', required: false, description: 'Workspace path; defaults to cwd' },
    ])],
  },
};

const INTERFACE_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(INTERFACE_CONTRACT_DEFINITIONS).map(([entrypoint, definition]) => [entrypoint, Object.freeze({
    interfaceKind: INTERNAL_INTERFACE_KIND,
    ...definition,
  })]),
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectCoordinatorCapabilities(entrypoints) {
  const interfaces = {};
  for (const entrypoint of entrypoints) {
    if (!INTERFACE_CONTRACTS[entrypoint]) throw new Error(`COORDINATOR_INTERFACE_CONTRACT_MISSING: ${entrypoint}`);
    interfaces[entrypoint] = clone(INTERFACE_CONTRACTS[entrypoint]);
  }
  return { schemaVersion: 1, interfaces };
}

function commandContract(entrypoint, commandName = null) {
  const definition = INTERFACE_CONTRACTS[entrypoint];
  if (!definition) return null;
  return definition.commands.find((item) => item.name === (commandName || null)) || definition.commands[0] || null;
}

function inferIssue(error, contract) {
  const message = error?.message || String(error);
  const flagMatch = message.match(/--([a-z][a-z0-9-]*)/i);
  const fieldPath = flagMatch ? flagMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : 'arguments';
  const descriptor = contract?.flags?.[fieldPath];
  let code = 'INVALID_ARGUMENT';
  if (/required|missing|缺少|需要/.test(message)) code = 'REQUIRED_FIELD_MISSING';
  else if (/invalid JSON/i.test(message)) code = 'INVALID_JSON';
  else if (/unknown|unsupported|未知/.test(message)) code = 'UNKNOWN_ARGUMENT';
  return {
    fieldPath,
    expected: descriptor?.description || 'arguments matching the command contract',
    code,
  };
}

function coordinatorCliErrorResponse(error, entrypoint, commandName = null) {
  const contract = commandContract(entrypoint, commandName);
  return {
    status: 'REQUEST_INVALID',
    code: error?.code || String(error?.message || error).match(/^([A-Z][A-Z0-9_]+)/)?.[1] || 'COORDINATOR_CLI_INVALID',
    message: error?.message || String(error),
    command: `${entrypoint}${contract?.name ? ` ${contract.name}` : ''}`,
    issues: Array.isArray(error?.issues) && error.issues.length ? error.issues : [inferIssue(error, contract)],
    usage: contract?.usage || entrypoint,
    example: contract?.example || [],
  };
}

function coordinatorContractError(message, issues) {
  const error = new Error(`COORDINATOR_CLI_INVALID: ${message}`);
  error.code = 'COORDINATOR_CLI_INVALID';
  error.exitCode = 2;
  error.issues = issues;
  return error;
}

function parseCoordinatorJson(value, entrypoint, commandName, flagName, options = {}) {
  const contract = commandContract(entrypoint, commandName);
  const descriptor = contract?.flags?.[flagName];
  if (value === undefined || value === null || value === '') {
    if (options.required === false || descriptor?.required === false) return undefined;
    throw coordinatorContractError(`--${flagName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`, [{
      fieldPath: flagName,
      expected: descriptor?.description || 'valid JSON',
      code: 'REQUIRED_FIELD_MISSING',
    }]);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw coordinatorContractError(`--${flagName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is invalid JSON`, [{
      fieldPath: flagName,
      expected: 'valid JSON matching the documented schema',
      code: 'INVALID_JSON',
    }]);
  }
  if (!descriptor?.jsonSchema) return parsed;
  const issues = validateAgentJson(parsed, descriptor.jsonSchema, {}, flagName);
  if (issues.length) throw coordinatorContractError(`${flagName} does not match its command contract`, issues);
  return parsed;
}

function writeCoordinatorCliError(error, entrypoint, commandName = null) {
  process.stderr.write(`${JSON.stringify(coordinatorCliErrorResponse(error, entrypoint, commandName), null, 2)}\n`);
}

if (require.main === module) {
  const entrypointIndex = process.argv.indexOf('--error-entrypoint');
  const commandIndex = process.argv.indexOf('--command');
  const messageIndex = process.argv.indexOf('--message');
  const entrypoint = entrypointIndex >= 0 ? process.argv[entrypointIndex + 1] : '';
  const commandName = commandIndex >= 0 ? process.argv[commandIndex + 1] : null;
  const message = messageIndex >= 0 ? process.argv[messageIndex + 1] : 'invalid arguments';
  writeCoordinatorCliError(new Error(message), entrypoint, commandName);
}

module.exports = {
  APP_PROVISIONING_SCHEMA,
  BINDING_SCHEMA,
  BOOTSTRAP_POLICY_SCHEMA,
  INTERFACE_CONTRACTS,
  INTERNAL_INTERFACE_KIND,
  PROBE_SCHEMA,
  TARGETS_SCHEMA,
  commandContract,
  coordinatorCliErrorResponse,
  parseCoordinatorJson,
  projectCoordinatorCapabilities,
  writeCoordinatorCliError,
};
