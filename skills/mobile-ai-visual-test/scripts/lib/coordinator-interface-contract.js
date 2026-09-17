#!/usr/bin/env node
'use strict';

const { validateAgentJson } = require('./agent-json-contract');
const { parseCliArgs } = require('./cli-args');

const INTERNAL_INTERFACE_KIND = 'INTERNAL';
const INTERFACE_ROUTING = Object.freeze({
  'scripts/workspace.js': { module: 'workspace', access: 'DIRECT', roles: ['authoring', 'batch-coordinator', 'maintenance'] },
  'scripts/import-case.js': { module: 'authoring', access: 'ON_DEMAND', roles: ['authoring'] },
  'scripts/import-cases.js': { module: 'authoring', access: 'DIRECT', roles: ['authoring'] },
  'scripts/build-agent-contract.js': { module: 'protocol-maintenance', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/probe-env.sh': { module: 'environment', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/prepare-env.sh': { module: 'environment', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/environment.js': { module: 'environment', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/app-artifact.js': { module: 'app-artifact', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/execution-request.js': { module: 'execution', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/knowledge.js': { module: 'knowledge', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/batch.js': { module: 'execution', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/render-context.js': { module: 'reporting', access: 'ON_DEMAND', roles: ['maintenance'] },
  'scripts/render-index.js': { module: 'reporting', access: 'ON_DEMAND', roles: ['maintenance'] },
});
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
    required: ['caseNo'],
    additionalProperties: false,
    properties: {
      caseNo: STRING,
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
  'scripts/import-cases.js': {
    summary: 'Persist one or more logical cases already identified by the Authoring Agent',
    commands: [command(null, 'Import Agent-authored case drafts', 'node scripts/import-cases.js --workspace <workspace> --request-file <json-file>', {
      workspace: flag(true, 'Workspace path', { value: '<workspace>' }),
      requestFile: flag(true, 'JSON file containing a non-empty cases array', { value: '<json-file>' }),
    }, ['node', 'scripts/import-cases.js', '--workspace', '<workspace>', '--request-file', '<json-file>'], ['imported case metadata'])],
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
        targetsJson: flag(true, 'Non-empty target list using workspace case numbers', { value: '<json>', jsonSchema: TARGETS_SCHEMA }),
        bootstrapPolicyJson: flag(false, 'Batch-level App bootstrap authorization; omit for KEEP_EXISTING', { value: '<json>', jsonSchema: BOOTSTRAP_POLICY_SCHEMA }),
        userInstruction: flag(true, 'The user instruction authorizing this execution', { value: '<text>' }),
      }, ['node', 'scripts/execution-request.js', 'create', '--workspace', '<workspace>', '--batch-id', '<batch-id>', '--mode', 'single', '--targets-json', '[{"caseNo":"004"}]', '--user-instruction', '<instruction>'], ['frozen execution request']),
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
  Object.entries(INTERFACE_CONTRACT_DEFINITIONS).map(([entrypoint, definition]) => {
    const routing = INTERFACE_ROUTING[entrypoint];
    if (!routing) throw new Error(`COORDINATOR_INTERFACE_ROUTING_MISSING: ${entrypoint}`);
    const scriptName = entrypoint.split('/').pop().replace(/\.[^.]+$/, '');
    const normalizeToken = (token) => token === entrypoint ? `<skill-root>/${entrypoint}` : token;
    const commands = definition.commands.map((item) => {
      const anchor = `${scriptName}${item.name ? `-${item.name}` : ''}`;
      return Object.freeze({
        ...item,
        usage: item.usage
          .replace(/^node scripts\//, 'node <skill-root>/scripts/')
          .replace(/^scripts\//, '<skill-root>/scripts/'),
        example: item.example.map(normalizeToken),
        documentationRef: `references/commands/${routing.module}.md#${anchor}`,
      });
    });
    return [entrypoint, Object.freeze({
      interfaceKind: INTERNAL_INTERFACE_KIND,
      ...routing,
      ...definition,
      commands: Object.freeze(commands),
    })];
  }),
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

function parseCoordinatorCliArgs(argv, entrypoint) {
  const definition = INTERFACE_CONTRACTS[entrypoint];
  if (!definition) throw coordinatorContractError(`unknown entrypoint: ${entrypoint}`);
  const named = definition.commands.some((item) => item.name !== null);
  const commandName = named ? argv[0] : null;
  const contract = named
    ? definition.commands.find((item) => item.name === commandName)
    : definition.commands[0];
  if (!contract) {
    throw coordinatorContractError(`unknown command: ${commandName || 'missing'}`, [{
      fieldPath: 'command',
      code: 'UNKNOWN_COMMAND',
      expected: `one of ${definition.commands.map((item) => item.name).join(', ')}`,
    }]);
  }
  let parsed;
  try {
    parsed = parseCliArgs(named ? argv.slice(1) : argv, {
      context: `${entrypoint}${commandName ? ` ${commandName}` : ''}`,
      valueOptions: Object.keys(contract.flags).map((name) => `--${kebabFlag(name)}`),
      maxPositionals: contract.positionals.length,
    });
  } catch (error) {
    error.code = error.code || 'COORDINATOR_CLI_INVALID';
    error.errorKind = 'INPUT';
    throw error;
  }
  const values = {};
  for (const [flag, value] of Object.entries(parsed.values)) {
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  contract.positionals.forEach((descriptor, index) => {
    if (parsed.positionals[index] !== undefined) values[descriptor.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parsed.positionals[index];
  });
  for (const [name, descriptor] of Object.entries(contract.flags)) {
    if (descriptor.required && !values[name]) {
      throw coordinatorContractError(`--${kebabFlag(name)} is required`, [{ fieldPath: name, code: 'REQUIRED_FIELD_MISSING', expected: descriptor.description }]);
    }
    if (values[name] !== undefined && descriptor.enum && !descriptor.enum.includes(values[name])) {
      throw coordinatorContractError(`--${kebabFlag(name)} has an invalid value`, [{ fieldPath: name, code: 'ENUM_INVALID', expected: descriptor.enum.join(' | ') }]);
    }
  }
  contract.positionals.forEach((descriptor) => {
    const name = descriptor.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (descriptor.required && !values[name]) {
      throw coordinatorContractError(`${descriptor.name} is required`, [{ fieldPath: descriptor.name, code: 'REQUIRED_FIELD_MISSING', expected: descriptor.description }]);
    }
  });
  return { ...(named ? { command: commandName } : {}), ...values };
}

function kebabFlag(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function inferIssue(error, contract) {
  const message = error?.message || String(error);
  const flagMatch = message.match(/--([a-z][a-z0-9-]*)/i);
  const fieldPath = flagMatch ? flagMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : 'arguments';
  const descriptor = contract?.flags?.[fieldPath];
  let code = 'INVALID_ARGUMENT';
  if (/duplicate|重复/.test(message)) code = 'DUPLICATE_ARGUMENT';
  else if (/required|missing|缺少|需要/.test(message)) code = 'REQUIRED_FIELD_MISSING';
  else if (/invalid JSON/i.test(message)) code = 'INVALID_JSON';
  else if (/unknown|unsupported|未知/.test(message)) code = 'UNKNOWN_ARGUMENT';
  return {
    fieldPath,
    expected: descriptor?.description || 'arguments matching the command contract',
    code,
  };
}

const INPUT_ERROR_CODES = new Set([
  'AGENT_CONTRACT_CLI_INVALID',
  'APP_ARTIFACT_CLI_INVALID',
  'BATCH_CLI_INVALID',
  'CASE_AUTHORING_CLI_INVALID',
  'CASE_AUTHORING_INPUT_INVALID',
  'CASE_IMPORT_CLI_INVALID',
  'COORDINATOR_CLI_INVALID',
  'COORDINATOR_INPUT_INVALID',
  'ENVIRONMENT_CLI_INVALID',
  'EXECUTION_REQUEST_CLI_INVALID',
  'KNOWLEDGE_CLI_INVALID',
  'REPORT_CONTEXT_CLI_INVALID',
  'REPORT_INDEX_CLI_INVALID',
  'WORKSPACE_CLI_INVALID',
]);

const COMMAND_ERROR_DEFINITIONS = Object.freeze({
  BATCH_IMPLEMENTATION_MISMATCH: {
    module: 'execution', retryable: false,
    summary: '批次冻结的实现与当前 Skill 实现不同，不能继续业务执行。',
    recovery: '不要修改批次文件或反复重试 reconcile；可以继续 status、cancel 和 teardown，若要继续业务执行则创建新批次。',
  },
  BATCH_PROTOCOL_MISMATCH: {
    module: 'execution', retryable: false,
    summary: '批次冻结的 Agent 协议与当前协议不同。',
    recovery: '保留旧批次事实并通过 cancel、teardown 完成收尾；使用当前协议创建新批次执行。',
  },
  BATCH_BINDING_MISMATCH: {
    module: 'execution', retryable: false,
    summary: '批次状态与其冻结契约、目标或环境绑定不一致。',
    recovery: '停止业务推进，不要直接编辑 JSON；保留批次文件进行诊断，只在所有权可证明时执行取消和资源清理。',
  },
  REPORT_PUBLICATION_INCOMPLETE: {
    module: 'execution', retryable: true,
    summary: '批次目标中至少一个用例报告尚未成功生成。',
    recovery: '读取响应中的失败用例和报告错误，修复缺失或被占用的产物后重新执行 reconcile；在全部目标成功前不要把批次视为已发布。',
  },
  IOS_APPIUM_SERVICE_IN_USE: {
    module: 'execution', retryable: true,
    summary: 'iOS Appium 服务由另一个活动批次持有。',
    recovery: '根据 diagnostic.resourceFacts 定位 owner batch，等待其终态或明确取消该批次；不要手工终止无法确认所有权的共享服务。',
  },
  PLATFORM_RUNTIME_RELEASE_FAILED: {
    module: 'execution', retryable: true,
    summary: '框架持有的平台运行资源未能完成释放。',
    recovery: '保留 ownerKey、stage 和 logRefs，修复底层服务问题后重试 teardown；不得用新批次覆盖原所有权。',
  },
});

function errorCode(error, fallback) {
  return error?.code || String(error?.message || error).match(/^([A-Z][A-Z0-9_]+)/)?.[1] || fallback;
}

function commandErrorRef(entrypoint, suffix, code = null) {
  const targeted = code ? COMMAND_ERROR_DEFINITIONS[code] : null;
  if (targeted) return `references/commands/errors/${targeted.module}.md#error-${code.replace(/_/g, '-').toLowerCase()}`;
  const definition = INTERFACE_CONTRACTS[entrypoint];
  return definition ? `references/commands/errors/${definition.module}.md#${suffix}` : 'references/commands.md';
}

function coordinatorCliErrorResponse(error, entrypoint, commandName = null) {
  const contract = commandContract(entrypoint, commandName);
  const code = errorCode(error, 'COORDINATOR_CLI_TECHNICAL');
  const inputInvalid = error?.errorKind === 'INPUT' || INPUT_ERROR_CODES.has(code);
  const domainError = !inputInvalid && error?.errorKind === 'DOMAIN';
  if (!inputInvalid) {
    const diagnostic = error?.diagnostic || {};
    return {
      status: domainError ? (error.status || 'FAILED') : 'TECHNICAL',
      code,
      message: error?.message || String(error),
      command: `${entrypoint}${contract?.name ? ` ${contract.name}` : ''}`,
      retryable: error?.retryable === true || diagnostic.retryable === true,
      ...(domainError ? { category: 'DOMAIN' } : {
        category: 'TECHNICAL',
        technical: {
          stage: diagnostic.stage || 'CLI_EXECUTION',
          ...(diagnostic.logRefs ? { logRefs: diagnostic.logRefs } : {}),
          ...(diagnostic.resourceFacts ? { resourceFacts: diagnostic.resourceFacts } : {}),
        },
      }),
      documentationRef: commandErrorRef(entrypoint, domainError ? 'domain' : 'technical', code),
    };
  }
  return {
    status: 'REQUEST_INVALID',
    code,
    message: error?.message || String(error),
    command: `${entrypoint}${contract?.name ? ` ${contract.name}` : ''}`,
    issues: Array.isArray(error?.issues) && error.issues.length ? error.issues : [inferIssue(error, contract)],
    usage: contract?.usage || entrypoint,
    example: contract?.example || [],
    documentationRef: contract?.documentationRef || commandErrorRef(entrypoint, 'request-invalid'),
  };
}

function coordinatorContractError(message, issues) {
  const error = new Error(`COORDINATOR_CLI_INVALID: ${message}`);
  error.code = 'COORDINATOR_CLI_INVALID';
  error.errorKind = 'INPUT';
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
  writeCoordinatorCliError(coordinatorContractError(message), entrypoint, commandName);
}

module.exports = {
  APP_PROVISIONING_SCHEMA,
  BINDING_SCHEMA,
  BOOTSTRAP_POLICY_SCHEMA,
  COMMAND_ERROR_DEFINITIONS,
  INTERFACE_CONTRACTS,
  INTERNAL_INTERFACE_KIND,
  PROBE_SCHEMA,
  TARGETS_SCHEMA,
  commandContract,
  coordinatorCliErrorResponse,
  coordinatorContractError,
  parseCoordinatorJson,
  parseCoordinatorCliArgs,
  projectCoordinatorCapabilities,
  writeCoordinatorCliError,
};
