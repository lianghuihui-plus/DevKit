'use strict';

const { ACTION_FIELDS, describeActionConstraints } = require('./action-contract');
const { BASIS_VALUES } = require('./understanding-contract');
const { FINDING_STATUSES, VERDICTS, VERDICT_BASES } = require('../execution/contracts/result-contract');
const { KNOWLEDGE_ASSESSMENTS } = require('../execution/contracts/execution-event-contract');
const { contractError, ensureArray, ensureObject } = require('./contract-utils');

const NON_EMPTY_TEXT = Object.freeze({ type: 'string', trim: true, minLength: 1 });
const STABLE_ID = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' });
const TEXT_LIST = Object.freeze({ type: 'array', items: NON_EMPTY_TEXT, emptyAllowed: true });
const ID_LIST = Object.freeze({ type: 'array', items: STABLE_ID, emptyAllowed: true });
const NORMALIZED_POINT = Object.freeze({ type: 'tuple', items: ['number 0..1', 'number 0..1'], length: 2 });
const NORMALIZED_BOUNDS = Object.freeze({ type: 'tuple', items: ['number 0..1', 'number 0..1', 'number 0..1', 'number 0..1'], length: 4, positiveArea: true });
const CONCLUDE_REVIEW_RULE = 'required unless the verdict is a pure technical BLOCKED result without a current observation';
const FINDING_SUPPORT_RULE = 'SATISFIED and NOT_SATISFIED findings require explicit evidenceRefs, applicable knowledgeRefs, or an allowed incidentRef';

const OBJECT_FIELDS = Object.freeze({
  understanding: Object.freeze({ required: ['summary', 'startConditions', 'requirements'], optional: ['uncertainties'] }),
  statement: Object.freeze({ required: ['id', 'text', 'basis'], optional: [] }),
  requirement: Object.freeze({ required: ['id', 'text', 'basis', 'requiredInteractions', 'expectedOutcomes'], optional: [] }),
  checkpoint: Object.freeze({ required: ['id', 'objective', 'requirementRefs'], optional: [] }),
  assessment: Object.freeze({ required: ['entryId', 'assessment', 'reason'], optional: [] }),
  finding: Object.freeze({ required: ['requirementRef', 'status', 'reason'], optional: ['evidenceRefs', 'knowledgeRefs', 'incidentRefs', 'necessityReason'] }),
  review: Object.freeze({ required: ['sourceConclusion', 'recoveryConclusion'], optional: [] }),
  knowledgeQuery: Object.freeze({ required: [], optional: ['platform', 'app', 'version', 'page', 'operation', 'symptom', 'keywords'] }),
});

const ENTRYPOINT_FIELDS = Object.freeze({
  understand: Object.freeze({ required: ['understanding'], optional: ['reason'] }),
  plan: Object.freeze({ required: ['checkpoints'], optional: ['reason'] }),
  inspect: Object.freeze({ required: [], optional: ['startConditionRef', 'checkpointRef', 'intent', 'expectedOutcome'] }),
  step: Object.freeze({ required: ['intent', 'action'], optional: ['checkpointRef', 'startConditionRef', 'expectedOutcome'] }),
  markStart: Object.freeze({ required: [], optional: ['reason'] }),
  requestRecovery: Object.freeze({ required: ['reason'], optional: ['triggerType', 'incidentCategory'] }),
  investigate: Object.freeze({
    modes: Object.freeze([
      Object.freeze({ required: ['query'], optional: ['reason'] }),
      Object.freeze({ required: ['queryId', 'assessments', 'conclusion', 'reason'], optional: [] }),
    ]),
  }),
  conclude: Object.freeze({
    required: ['verdict', 'summary', 'findings'],
    optional: ['verdictBasis', 'technicalFailureCode', 'uncertainties', 'queryRefs', 'review', 'reason'],
  }),
});

function sorted(values) {
  return [...values].sort();
}

function fieldsFor(entrypoint, input, code = 'AGENT_FACADE_INVALID') {
  const definition = ENTRYPOINT_FIELDS[entrypoint];
  if (!definition) throw contractError('AGENT_INPUT_CONTRACT_INVALID', `unknown Agent entrypoint: ${entrypoint}`);
  if (!definition.modes) return definition;
  const queryMode = input.query !== undefined;
  const assessmentMode = ['queryId', 'assessments', 'conclusion'].some((field) => input[field] !== undefined);
  if (queryMode && assessmentMode) {
    throw contractError(code, `${entrypoint} request mixes query and assessment fields`, {
      fieldPath: 'query', expected: 'exactly one investigate mode',
    });
  }
  return assessmentMode ? definition.modes[1] : definition.modes[0];
}

function assertObjectFields(value, label, definition, code) {
  ensureObject(value, label, code);
  const allowed = new Set([...definition.required, ...definition.optional]);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) {
    throw contractError(code, `${label} contains unsupported fields: ${unknown.join(', ')}`, {
      fieldPath: `${label}.${unknown[0]}`, allowed: [...allowed],
    });
  }
  const missing = definition.required.filter((field) => value[field] === undefined);
  if (missing.length) {
    throw contractError(code, `${label} is missing required fields: ${missing.join(', ')}`, {
      fieldPath: `${label}.${missing[0]}`, expected: 'required field',
    });
  }
  return value;
}

function assertText(value, label, code) {
  if (typeof value !== 'string' || !value.trim()) {
    throw contractError(code, `${label} must be a non-empty string`, { fieldPath: label, expected: NON_EMPTY_TEXT });
  }
}

function assertOptionalText(value, label, code) {
  if (value !== undefined) assertText(value, label, code);
}

function assertString(value, label, code) {
  if (typeof value !== 'string') {
    throw contractError(code, `${label} must be a string`, { fieldPath: label, expected: 'string' });
  }
}

function assertList(value, label, code, itemValidator) {
  ensureArray(value, label, code).forEach((item, index) => itemValidator(item, `${label}[${index}]`, code));
}

function assertStatement(value, label, code, requirement = false) {
  assertObjectFields(value, label, requirement ? OBJECT_FIELDS.requirement : OBJECT_FIELDS.statement, code);
  assertText(value.id, `${label}.id`, code);
  assertText(value.text, `${label}.text`, code);
  assertText(value.basis, `${label}.basis`, code);
  if (requirement) {
    assertList(value.requiredInteractions, `${label}.requiredInteractions`, code, assertString);
    assertList(value.expectedOutcomes, `${label}.expectedOutcomes`, code, assertString);
  }
}

function assertAgentInputShape(entrypoint, input, code) {
  if (entrypoint === 'understand') {
    const understanding = assertObjectFields(input.understanding, 'understanding', OBJECT_FIELDS.understanding, code);
    assertText(understanding.summary, 'understanding.summary', code);
    assertList(understanding.startConditions, 'understanding.startConditions', code, (item, label) => assertStatement(item, label, code));
    assertList(understanding.requirements, 'understanding.requirements', code, (item, label) => assertStatement(item, label, code, true));
    if (understanding.uncertainties !== undefined) assertList(understanding.uncertainties, 'understanding.uncertainties', code, assertString);
    assertOptionalText(input.reason, 'reason', code);
  } else if (entrypoint === 'plan') {
    assertList(input.checkpoints, 'checkpoints', code, (checkpoint, label) => {
      assertObjectFields(checkpoint, label, OBJECT_FIELDS.checkpoint, code);
      assertText(checkpoint.id, `${label}.id`, code);
      assertText(checkpoint.objective, `${label}.objective`, code);
      assertList(checkpoint.requirementRefs, `${label}.requirementRefs`, code, assertText);
    });
    assertOptionalText(input.reason, 'reason', code);
  } else if (entrypoint === 'inspect') {
    for (const field of ['startConditionRef', 'checkpointRef', 'intent', 'expectedOutcome']) assertOptionalText(input[field], field, code);
  } else if (entrypoint === 'step') {
    assertText(input.intent, 'intent', code);
    assertOptionalText(input.checkpointRef, 'checkpointRef', code);
    assertOptionalText(input.startConditionRef, 'startConditionRef', code);
    assertOptionalText(input.expectedOutcome, 'expectedOutcome', code);
    validateSemanticActionInput(input.action, code);
  } else if (entrypoint === 'markStart') {
    assertOptionalText(input.reason, 'reason', code);
  } else if (entrypoint === 'requestRecovery') {
    assertText(input.reason, 'reason', code);
    assertOptionalText(input.triggerType, 'triggerType', code);
    assertOptionalText(input.incidentCategory, 'incidentCategory', code);
  } else if (entrypoint === 'investigate' && input.query !== undefined) {
    const query = assertObjectFields(input.query, 'query', OBJECT_FIELDS.knowledgeQuery, code);
    for (const field of ['platform', 'app', 'version', 'page', 'operation', 'symptom']) assertOptionalText(query[field], `query.${field}`, code);
    if (query.keywords !== undefined) assertList(query.keywords, 'query.keywords', code, assertText);
    assertOptionalText(input.reason, 'reason', code);
  } else if (entrypoint === 'investigate') {
    assertText(input.queryId, 'queryId', code);
    assertList(input.assessments, 'assessments', code, (assessment, label) => {
      assertObjectFields(assessment, label, OBJECT_FIELDS.assessment, code);
      for (const field of OBJECT_FIELDS.assessment.required) assertText(assessment[field], `${label}.${field}`, code);
    });
    assertText(input.conclusion, 'conclusion', code);
    assertText(input.reason, 'reason', code);
  } else if (entrypoint === 'conclude') {
    assertText(input.verdict, 'verdict', code);
    assertText(input.summary, 'summary', code);
    assertList(input.findings, 'findings', code, (finding, label) => {
      assertObjectFields(finding, label, OBJECT_FIELDS.finding, code);
      for (const field of OBJECT_FIELDS.finding.required) assertText(finding[field], `${label}.${field}`, code);
      for (const field of ['evidenceRefs', 'knowledgeRefs', 'incidentRefs']) {
        if (finding[field] !== undefined) assertList(finding[field], `${label}.${field}`, code, assertText);
      }
      assertOptionalText(finding.necessityReason, `${label}.necessityReason`, code);
    });
    if (input.review !== undefined) {
      assertObjectFields(input.review, 'review', OBJECT_FIELDS.review, code);
      for (const field of OBJECT_FIELDS.review.required) assertText(input.review[field], `review.${field}`, code);
    }
    for (const field of ['verdictBasis', 'technicalFailureCode', 'reason']) assertOptionalText(input[field], field, code);
    for (const field of ['uncertainties', 'queryRefs']) {
      if (input[field] !== undefined) assertList(input[field], field, code, assertText);
    }
  }
}

function assertAgentInputFields(entrypoint, input, code = 'AGENT_FACADE_INVALID') {
  ensureObject(input, `${entrypoint} request`, code);
  const definition = fieldsFor(entrypoint, input, code);
  const allowed = new Set([...definition.required, ...definition.optional]);
  const unknown = Object.keys(input).filter((field) => !allowed.has(field));
  if (unknown.length) {
    throw contractError(code, `${entrypoint} request contains unsupported fields: ${unknown.join(', ')}`, {
      fieldPath: unknown[0],
      allowed: [...allowed],
    });
  }
  const missing = definition.required.filter((field) => input[field] === undefined);
  if (missing.length) {
    throw contractError(code, `${entrypoint} request is missing required fields: ${missing.join(', ')}`, {
      fieldPath: missing[0],
      expected: 'required field',
    });
  }
  assertAgentInputShape(entrypoint, input, code);
  return input;
}

function normalizeTextList(value, label, code = 'AGENT_FACADE_INVALID') {
  return ensureArray(value, label, code)
    .filter((item) => typeof item !== 'string' || !NON_EMPTY_TEXT.trim || item.trim().length >= NON_EMPTY_TEXT.minLength)
    .map((item, index) => {
      if (typeof item !== 'string') {
        throw contractError(code, `${label}[${index}] must be a non-empty string`, {
          fieldPath: `${label}[${index}]`, expected: 'non-empty string',
        });
      }
      return item.trim();
    });
}

function normalizeOptionalText(value) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized || undefined;
}

function assertNormalizedTuple(value, size, label, code = 'AGENT_FACADE_INVALID') {
  if (!Array.isArray(value) || value.length !== size) {
    throw contractError(code, `${label} must contain ${size === 2 ? '[x,y]' : '[x1,y1,x2,y2]'}`, {
      fieldPath: label,
      expected: size === 2 ? NORMALIZED_POINT : NORMALIZED_BOUNDS,
    });
  }
  value.forEach((item, index) => {
    if (!Number.isFinite(Number(item)) || Number(item) < 0 || Number(item) > 1) {
      throw contractError(code, `${label}[${index}] must be a number from 0 to 1`, {
        fieldPath: `${label}[${index}]`, expected: 'number 0..1', received: item,
      });
    }
  });
  if (size === 4 && (Number(value[2]) <= Number(value[0]) || Number(value[3]) <= Number(value[1]))) {
    throw contractError(code, `${label} must describe a positive area`, {
      fieldPath: label, expected: NORMALIZED_BOUNDS,
    });
  }
  return value;
}

function validateSemanticActionInput(action, code = 'AGENT_FACADE_INVALID') {
  ensureObject(action, 'action', code);
  for (const field of ['normalizedPoint', 'normalizedFrom', 'normalizedTo']) {
    if (action[field] !== undefined) assertNormalizedTuple(action[field], NORMALIZED_POINT.length, `action.${field}`, code);
  }
  if (action.normalizedBounds !== undefined) assertNormalizedTuple(action.normalizedBounds, NORMALIZED_BOUNDS.length, 'action.normalizedBounds', code);
  if (action.type === 'swipe' && (action.normalizedFrom !== undefined || action.normalizedTo !== undefined)) {
    if (action.normalizedFrom === undefined || action.normalizedTo === undefined) {
      throw contractError(code, 'swipe visual coordinates require both normalizedFrom and normalizedTo', {
        fieldPath: action.normalizedFrom === undefined ? 'action.normalizedFrom' : 'action.normalizedTo',
      });
    }
  }
  return action;
}

function describeAgentInputSchemas(platform) {
  const actionConstraints = describeActionConstraints(platform, 'case-business');
  return {
    primitives: {
      nonEmptyText: NON_EMPTY_TEXT,
      stableId: STABLE_ID,
      textList: TEXT_LIST,
      idList: ID_LIST,
      normalizedPoint: NORMALIZED_POINT,
      normalizedBounds: NORMALIZED_BOUNDS,
    },
    understand: {
      ...ENTRYPOINT_FIELDS.understand,
      understanding: {
        ...OBJECT_FIELDS.understanding,
        summary: NON_EMPTY_TEXT, uncertainties: TEXT_LIST,
        statement: { ...OBJECT_FIELDS.statement, id: STABLE_ID, text: NON_EMPTY_TEXT, basis: sorted(BASIS_VALUES) },
        requirement: {
          ...OBJECT_FIELDS.requirement,
          requiredInteractions: TEXT_LIST, expectedOutcomes: TEXT_LIST,
          rule: 'at least one requiredInteractions or expectedOutcomes item is required',
        },
      },
      reason: { ...NON_EMPTY_TEXT, requiredWhen: 'the submitted semantics change an existing understanding' },
      generated: ['schemaVersion', 'turnId', 'understanding.revision', 'understanding.sourceRefs', 'statement.sourceRefs'],
      empty: 'requirements may be empty only when uncertainties contains at least one non-empty string; zero requirements do not authorize device work',
    },
    plan: {
      ...ENTRYPOINT_FIELDS.plan,
      checkpoint: { ...OBJECT_FIELDS.checkpoint, id: STABLE_ID, objective: NON_EMPTY_TEXT, requirementRefs: ID_LIST },
      reason: NON_EMPTY_TEXT,
      coverage: 'every checkpoint references at least one current requirement and every current requirement belongs to exactly one checkpoint; zero requirements require zero checkpoints',
      generated: ['schemaVersion', 'turnId', 'plan.revision', 'plan.planSha'],
    },
    inspect: {
      ...ENTRYPOINT_FIELDS.inspect,
      intent: NON_EMPTY_TEXT, expectedOutcome: NON_EMPTY_TEXT, startConditionRef: STABLE_ID, checkpointRef: STABLE_ID,
      rules: [
        'stage is framework-derived and is not an input field',
        'startConditionRef is valid only before start establishment',
        'checkpointRef is valid only after start establishment and is omitted when using the active checkpoint',
      ],
      generated: ['stage', 'operationId', 'authorization', 'observationRef', 'observationView'],
    },
    step: {
      ...ENTRYPOINT_FIELDS.step,
      intent: NON_EMPTY_TEXT, expectedOutcome: NON_EMPTY_TEXT, startConditionRef: STABLE_ID, checkpointRef: STABLE_ID,
      rules: [
        'stage is framework-derived and is not an input field',
        'startConditionRef is valid only before start establishment',
        'checkpointRef is valid only after start establishment and is omitted when using the active checkpoint',
      ],
      behavior: 'executes one Agent-selected action and automatically captures the post-action observation',
      generated: ['stage', 'stepId', 'operationId', 'authorization', 'basisObservationRef', 'coordinateAudit', 'postActionObservation.actionEffect'],
    },
    semanticAction: {
      actionTypes: actionConstraints.actionTypes,
      commonRequired: ['type'],
      locatorModes: {
        element: { required: ['targetRef'], targetRef: STABLE_ID },
        visualPoint: { required: ['normalizedPoint'], optional: ['normalizedBounds'], normalizedPoint: NORMALIZED_POINT, normalizedBounds: NORMALIZED_BOUNDS },
        visualSwipe: { required: ['normalizedFrom', 'normalizedTo'], optional: ['normalizedBounds'], normalizedFrom: NORMALIZED_POINT, normalizedTo: NORMALIZED_POINT, normalizedBounds: NORMALIZED_BOUNDS },
        rawFallback: Object.fromEntries(actionConstraints.actionTypes.map((type) => [type, ACTION_FIELDS[type]])),
      },
      inputText: {
        required: ['text'], optional: ['targetRef', 'target', 'mode'], text: NON_EMPTY_TEXT,
        modes: ['replace', 'append'],
        platform: platform === 'harmony' ? 'targetRef or coordinates focus and input the field' : 'focus with a prior tap step, then input without coordinates',
      },
    },
    markStart: { ...ENTRYPOINT_FIELDS.markStart, reason: NON_EMPTY_TEXT },
    requestRecovery: {
      ...ENTRYPOINT_FIELDS.requestRecovery,
      reason: NON_EMPTY_TEXT,
      triggerTypes: ['SOURCE_REQUIRED_COLD_START', 'AGENT_DECIDED_RESTART', 'APP_CRASH', 'SYSTEM_KILLED', 'UNKNOWN_EXIT', 'APP_UNRESPONSIVE', 'AUTOMATION_SESSION_LOST'],
      incidentCategories: ['PRODUCT', 'TECHNICAL'],
      generated: ['recoveryId', 'executionId', 'checkpointId', 'sourceRefs', 'evidenceRefs', 'incident fields'],
    },
    investigate: {
      modes: ENTRYPOINT_FIELDS.investigate.modes,
      query: NON_EMPTY_TEXT, queryId: STABLE_ID, reason: NON_EMPTY_TEXT,
      assessment: { ...OBJECT_FIELDS.assessment, entryId: STABLE_ID, assessment: sorted(KNOWLEDGE_ASSESSMENTS), reason: NON_EMPTY_TEXT },
      conclusions: ['APPLICABLE_FOUND', 'NO_APPLICABLE', 'CONFLICTING', 'INSUFFICIENT'],
    },
    conclude: {
      ...ENTRYPOINT_FIELDS.conclude,
      verdicts: sorted(VERDICTS), verdictBases: sorted(VERDICT_BASES), summary: NON_EMPTY_TEXT,
      uncertainties: TEXT_LIST, queryRefs: ID_LIST,
      finding: {
        ...OBJECT_FIELDS.finding,
        requirementRef: STABLE_ID, status: sorted(FINDING_STATUSES), reason: NON_EMPTY_TEXT,
        supportRule: FINDING_SUPPORT_RULE,
      },
      review: { ...OBJECT_FIELDS.review, requiredWhen: CONCLUDE_REVIEW_RULE, sourceConclusion: NON_EMPTY_TEXT, recoveryConclusion: NON_EMPTY_TEXT },
      coverage: 'exactly one finding for every current requirement',
      knowledgeRule: 'direct-evidence PASS may omit knowledge; FAIL, INCONCLUSIVE, and business BLOCKED require a completed query-level knowledge review',
      generated: ['checkpointFinding', 'verdictReview', 'result identity', 'metrics', 'agentResult'],
    },
  };
}

module.exports = {
  ENTRYPOINT_FIELDS,
  CONCLUDE_REVIEW_RULE,
  FINDING_SUPPORT_RULE,
  NORMALIZED_BOUNDS,
  NORMALIZED_POINT,
  NON_EMPTY_TEXT,
  TEXT_LIST,
  assertAgentInputFields,
  assertNormalizedTuple,
  describeAgentInputSchemas,
  normalizeOptionalText,
  normalizeTextList,
  validateSemanticActionInput,
};
