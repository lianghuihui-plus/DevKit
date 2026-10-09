'use strict';

const { contractError } = require('../../lib/contract-utils');

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)*$/;
const SCHEMA_KEYS = new Set([
  '$ref', 'additionalProperties', 'const', 'enum', 'exactlyOneOf', 'items',
  'maximum', 'maxItems', 'minimum', 'minItems', 'minLength', 'oneOf',
  'pattern', 'properties', 'required', 'type',
]);

function invalid(code, message) {
  throw contractError(code, message);
}

function nonEmptyString(value, field, code) {
  if (typeof value !== 'string' || !value.trim()) invalid(code, `${field} must be a non-empty string`);
}

function validateSchema(schema, field = 'inputSchema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    invalid('CAPABILITY_DEFINITION_INVALID', `${field} must be a JSON Schema object`);
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) invalid('CAPABILITY_DEFINITION_INVALID', `${field}.${key} is not supported`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.properties must be an object`);
    }
    for (const [name, child] of Object.entries(schema.properties)) validateSchema(child, `${field}.properties.${name}`);
  }
  if (schema.items !== undefined) validateSchema(schema.items, `${field}.items`);
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) {
      invalid('CAPABILITY_DEFINITION_INVALID', `${field}.oneOf must be a non-empty array`);
    }
    schema.oneOf.forEach((branch, index) => validateSchema(branch, `${field}.oneOf[${index}]`));
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
