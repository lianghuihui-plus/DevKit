'use strict';

function pathFor(parent, field) {
  if (!parent) return String(field);
  return typeof field === 'number' ? `${parent}[${field}]` : `${parent}.${field}`;
}

function expectedFor(schema) {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.join(' | ');
  if (schema.type === 'string' && schema.pattern) return `string matching ${schema.pattern}`;
  if (schema.type === 'string' && schema.minLength) return 'non-empty string';
  if (schema.type === 'integer') {
    return schema.minimum === undefined ? 'integer' : `integer >= ${schema.minimum}`;
  }
  if (schema.type === 'number') {
    if (schema.minimum !== undefined && schema.maximum !== undefined) return `number from ${schema.minimum} to ${schema.maximum}`;
    return 'number';
  }
  if (schema.type === 'array' && schema.minItems === schema.maxItems) return `array with ${schema.minItems} items`;
  return schema.type || 'valid value';
}

function issue(fieldPath, expected, code) {
  return { fieldPath: fieldPath || 'request', expected, code };
}

function validateType(value, type) {
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function matchingOneOfBranch(value, branches) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return branches.find((branch) => {
    const discriminator = branch.properties?.gesture;
    if (discriminator?.const !== undefined) return value.gesture === discriminator.const;
    if (discriminator?.enum) return discriminator.enum.includes(value.gesture);
    return false;
  }) || null;
}

function validateAgentJson(value, schema, definitions = {}, fieldPath = '') {
  if (schema.$ref) {
    const resolved = definitions[schema.$ref];
    return resolved
      ? validateAgentJson(value, resolved, definitions, fieldPath)
      : [issue(fieldPath, `known schema reference ${schema.$ref}`, 'SCHEMA_REFERENCE_UNKNOWN')];
  }
  if (schema.oneOf) {
    const matched = matchingOneOfBranch(value, schema.oneOf);
    if (matched) return validateAgentJson(value, matched, definitions, fieldPath);
    const attempts = schema.oneOf.map((branch) => validateAgentJson(value, branch, definitions, fieldPath));
    const successful = attempts.filter((items) => items.length === 0);
    if (successful.length === 1) return [];
    const closest = attempts.sort((left, right) => left.length - right.length)[0] || [];
    return closest.length ? closest : [issue(fieldPath, 'exactly one documented variant', 'ONE_OF_MISMATCH')];
  }

  const issues = [];
  if (schema.const !== undefined && value !== schema.const) {
    issues.push(issue(fieldPath, expectedFor(schema), 'CONST_MISMATCH'));
    return issues;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push(issue(fieldPath, expectedFor(schema), 'ENUM_MISMATCH'));
    return issues;
  }
  if (schema.type && !validateType(value, schema.type)) {
    issues.push(issue(fieldPath, expectedFor(schema), 'TYPE_MISMATCH'));
    return issues;
  }

  if (schema.type === 'string' && schema.minLength && value.length < schema.minLength) {
    issues.push(issue(fieldPath, expectedFor(schema), 'MIN_LENGTH'));
  }
  if (schema.type === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    issues.push(issue(fieldPath, expectedFor(schema), 'PATTERN_MISMATCH'));
  }
  if (['integer', 'number'].includes(schema.type)) {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(issue(fieldPath, expectedFor(schema), 'MINIMUM'));
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(issue(fieldPath, expectedFor(schema), 'MAXIMUM'));
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(issue(fieldPath, expectedFor(schema), 'MIN_ITEMS'));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(issue(fieldPath, expectedFor(schema), 'MAX_ITEMS'));
    if (schema.items) {
      value.forEach((item, index) => issues.push(...validateAgentJson(item, schema.items, definitions, pathFor(fieldPath, index))));
    }
  }
  if (schema.type === 'object') {
    for (const field of schema.required || []) {
      if (value[field] === undefined) issues.push(issue(pathFor(fieldPath, field), expectedFor(schema.properties[field] || {}), 'REQUIRED'));
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, field)) {
          issues.push(issue(pathFor(fieldPath, field), `one of ${Object.keys(schema.properties || {}).join(', ')}`, 'FIELD_UNSUPPORTED'));
        }
      }
    }
    for (const [field, childSchema] of Object.entries(schema.properties || {})) {
      if (value[field] !== undefined) {
        issues.push(...validateAgentJson(value[field], childSchema, definitions, pathFor(fieldPath, field)));
      }
    }
    if (schema.exactlyOneOf) {
      const present = schema.exactlyOneOf.filter((field) => value[field] !== undefined);
      if (present.length !== 1) {
        issues.push(issue(fieldPath, `exactly one of ${schema.exactlyOneOf.join(', ')}`, 'EXACTLY_ONE_REQUIRED'));
      }
    }
  }
  return issues;
}

module.exports = { validateAgentJson };
