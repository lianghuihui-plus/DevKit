'use strict';

const { contractError } = require('../../lib/contract-utils');
const { validateAgentJson } = require('../../lib/agent-json-contract');

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_NAME = /^[a-z][a-z0-9_]*(?:[.-][a-z][a-z0-9_]*)*$/;
const SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'number', 'object', 'string']);
const SCHEMA_KEYS = new Set([
  'additionalProperties', 'const', 'default', 'description', 'enum', 'exactlyOneOf',
  'items', 'maximum', 'maxItems', 'minimum', 'minItems', 'minLength', 'oneOf',
  'pattern', 'properties', 'required', 'type',
]);

function invalid(code, message) {
  throw contractError(code, message);
}

function nonEmptyString(value, field, code) {
  if (typeof value !== 'string' || !value.trim()) invalid(code, `${field} must be a non-empty string`);
}

function jsonValue(value) {
  try { return JSON.stringify(value) !== undefined; } catch (_error) { return false; }
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateSchema(schema, field = 'inputSchema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field} must be a JSON Schema object`);
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) invalid('CAPABILITY_DEFINITION_INVALID', `${field}.${key} is not supported`);
  }
  if (schema.type !== undefined && !SCHEMA_TYPES.has(schema.type)) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.type is not supported`);
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.description must be a string`);
  }
  if (Object.hasOwn(schema, 'const') && (!jsonValue(schema.const)
    || (schema.const !== null && typeof schema.const === 'object'))) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.const must be a JSON scalar`);
  }
  if (Object.hasOwn(schema, 'default') && !jsonValue(schema.default)) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.default must be a JSON value`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length
    || schema.enum.some((item) => !jsonValue(item) || (item && typeof item === 'object')))) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.enum must be a non-empty array of JSON scalars`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.additionalProperties must be boolean`);
  }
  if (schema.additionalProperties !== undefined && schema.type !== 'object') {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.additionalProperties requires type object`);
  }
  if (schema.pattern !== undefined) {
    if (schema.type !== 'string') invalid('CAPABILITY_DEFINITION_INVALID', `${field}.pattern requires type string`);
    if (typeof schema.pattern !== 'string') invalid('CAPABILITY_DEFINITION_INVALID', `${field}.pattern must be a string`);
    try { new RegExp(schema.pattern); } catch (_error) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.pattern must be a valid regular expression`);
    }
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.${key} must be a finite number`);
    }
    if (schema[key] !== undefined && !['integer', 'number'].includes(schema.type)) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.${key} requires a numeric type`);
    }
  }
  for (const key of ['minLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && !nonNegativeInteger(schema[key])) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.${key} must be a non-negative integer`);
    }
  }
  if (schema.minLength !== undefined && schema.type !== 'string') {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.minLength requires type string`);
  }
  if ((schema.minItems !== undefined || schema.maxItems !== undefined) && schema.type !== 'array') {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.minItems and maxItems require type array`);
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.minimum must not exceed maximum`);
  }
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.minItems must not exceed maxItems`);
  }
  if (schema.properties !== undefined) {
    if (schema.type !== 'object') invalid('CAPABILITY_DEFINITION_INVALID', `${field}.properties requires type object`);
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.properties must be an object`);
    }
    for (const [name, child] of Object.entries(schema.properties)) validateSchema(child, `${field}.properties.${name}`);
  }
  if (schema.required !== undefined) {
    if (schema.type !== 'object') invalid('CAPABILITY_DEFINITION_INVALID', `${field}.required requires type object`);
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')
      || new Set(schema.required).size !== schema.required.length) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.required must be an array of unique strings`);
    }
    for (const name of schema.required) {
      if (!Object.hasOwn(schema.properties || {}, name)) {
        invalid('CAPABILITY_DEFINITION_INVALID', `${field}.required references unknown property ${name}`);
      }
    }
  }
  if (schema.items !== undefined) {
    if (schema.type !== 'array') invalid('CAPABILITY_DEFINITION_INVALID', `${field}.items requires type array`);
    validateSchema(schema.items, `${field}.items`);
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.oneOf must be a non-empty array`);
    }
    schema.oneOf.forEach((branch, index) => validateSchema(branch, `${field}.oneOf[${index}]`));
  }
  if (schema.exactlyOneOf !== undefined) {
    if (schema.type !== 'object' || !Array.isArray(schema.exactlyOneOf) || !schema.exactlyOneOf.length
      || schema.exactlyOneOf.some((name) => typeof name !== 'string' || !Object.hasOwn(schema.properties || {}, name))) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.exactlyOneOf must reference object properties`);
    }
  }
  if (Object.hasOwn(schema, 'default') && validateAgentJson(schema.default, schema, {}, field).length) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field}.default does not satisfy its schema`);
  }
  return schema;
}

function validateCapabilityDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    invalid('CAPABILITY_DEFINITION_INVALID', 'capability definition must be an object');
  }
  nonEmptyString(definition.name, 'definition.name', 'CAPABILITY_DEFINITION_INVALID');
  if (!CAPABILITY_NAME.test(definition.name)) {
    invalid('CAPABILITY_DEFINITION_INVALID', 'definition.name must be a stable dotted identifier');
  }
  nonEmptyString(definition.summary, 'definition.summary', 'CAPABILITY_DEFINITION_INVALID');
  validateSchema(definition.inputSchema);
  if (definition.inputSchema.type !== 'object') {
    invalid('CAPABILITY_DEFINITION_INVALID', 'inputSchema must be an object schema');
  }
  if (definition.inputSchema.additionalProperties !== false) {
    invalid('CAPABILITY_DEFINITION_INVALID', 'inputSchema.additionalProperties must be false');
  }
  if (definition.sensitiveFields !== undefined) {
    if (!definition.sensitiveFields || typeof definition.sensitiveFields !== 'object'
      || Array.isArray(definition.sensitiveFields)) {
      invalid('CAPABILITY_DEFINITION_INVALID', 'sensitiveFields must be an object');
    }
    for (const scope of ['input', 'output']) {
      const fields = definition.sensitiveFields[scope];
      if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string' || !field.trim())
        || new Set(fields).size !== fields.length) {
        invalid('CAPABILITY_DEFINITION_INVALID', `sensitiveFields.${scope} must be an array of unique strings`);
      }
    }
  }
  return definition;
}

function validateProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    invalid('CAPABILITY_PROVIDER_INVALID', 'provider must be an object');
  }
  const { manifest } = provider;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    invalid('CAPABILITY_PROVIDER_INVALID', 'provider.manifest must be an object');
  }
  nonEmptyString(manifest.id, 'manifest.id', 'CAPABILITY_PROVIDER_INVALID');
  if (!PROVIDER_ID.test(manifest.id)) {
    invalid('CAPABILITY_PROVIDER_INVALID', 'manifest.id must match ^[a-z][a-z0-9-]*$');
  }
  nonEmptyString(manifest.version, 'manifest.version', 'CAPABILITY_PROVIDER_INVALID');
  nonEmptyString(manifest.summary, 'manifest.summary', 'CAPABILITY_PROVIDER_INVALID');
  for (const method of ['probe', 'listCapabilities', 'invoke']) {
    if (typeof provider[method] !== 'function') invalid('CAPABILITY_PROVIDER_INVALID', `provider.${method} must be a function`);
  }
  return provider;
}

module.exports = {
  validateCapabilityDefinition,
  validateProvider,
  validateSchema,
};
