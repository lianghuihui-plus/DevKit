'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureObject, sha256 } = require('../../lib/contract-utils');
const { readJson } = require('../../lib/execution-lifecycle');

const VALIDATION_PROFILE_SCHEMA_VERSION = 1;
const PROFILE_FILE = 'validation-profile.snapshot.json';

function validationProfileSha(value) {
  const unsigned = { ...value };
  delete unsigned.profileSha;
  return sha256(canonicalJson(unsigned), 'validation-profile', 24);
}

function validateValidationProfile(value) {
  ensureObject(value, 'validation profile', 'VALIDATION_PROFILE_INVALID');
  if (value.schemaVersion !== VALIDATION_PROFILE_SCHEMA_VERSION) {
    throw contractError('VALIDATION_PROFILE_SCHEMA_UNSUPPORTED', `unsupported validation profile schema: ${value.schemaVersion ?? 'missing'}`);
  }
  const expected = {
    resultContractVersion: 1,
    visualInspectionPolicy: 'REQUIRED_FOR_REFERENCED_SCENES',
    knowledgeClosurePolicy: 'NEGATIVE_CHECKS_V1',
    searchCoveragePolicy: 'CONTINUOUS_BOTH_BOUNDARIES_V1',
    evidenceGraphVersion: 1,
    technicalFactPolicyVersion: 1,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) throw contractError('VALIDATION_PROFILE_INVALID', `${field} must be ${expectedValue}`);
  }
  if (value.profileSha !== validationProfileSha(value)) {
    throw contractError('VALIDATION_PROFILE_INVALID', 'profileSha does not match validation profile');
  }
  return value;
}

function createValidationProfile() {
  const value = {
    schemaVersion: VALIDATION_PROFILE_SCHEMA_VERSION,
    resultContractVersion: 1,
    visualInspectionPolicy: 'REQUIRED_FOR_REFERENCED_SCENES',
    knowledgeClosurePolicy: 'NEGATIVE_CHECKS_V1',
    searchCoveragePolicy: 'CONTINUOUS_BOTH_BOUNDARIES_V1',
    evidenceGraphVersion: 1,
    technicalFactPolicyVersion: 1,
  };
  value.profileSha = validationProfileSha(value);
  return validateValidationProfile(value);
}

function loadValidationProfile(execDir, execution) {
  if (execution?.schemaVersion === 10) return null;
  if (execution?.schemaVersion !== 11) {
    throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', `unsupported execution schema: ${execution?.schemaVersion ?? 'missing'}`);
  }
  const file = path.join(execDir, PROFILE_FILE);
  if (!fs.existsSync(file)) throw contractError('VALIDATION_PROFILE_MISSING', 'validation profile snapshot is missing');
  const profile = validateValidationProfile(readJson(file, null));
  if (execution.validationProfileSha !== profile.profileSha) {
    throw contractError('VALIDATION_PROFILE_CHANGED', 'execution validation profile binding changed');
  }
  return profile;
}

module.exports = {
  PROFILE_FILE,
  VALIDATION_PROFILE_SCHEMA_VERSION,
  createValidationProfile,
  loadValidationProfile,
  validateValidationProfile,
  validationProfileSha,
};
