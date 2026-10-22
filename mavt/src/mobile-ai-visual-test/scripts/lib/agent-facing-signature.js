'use strict';

function compactUnionBranch(schema = {}) {
  const discriminator = Object.entries(schema.properties || {})
    .find(([, property]) => property.const !== undefined);
  return discriminator ? `{ ${discriminator[0]}: ${typeName(discriminator[1])}; ... }` : typeName(schema);
}

function typeName(schema = {}) {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((item) => JSON.stringify(item)).join(' | ');
  if (schema.oneOf) return schema.oneOf.map(typeName).join(' | ');
  if (schema.type === 'array') return schema.items?.oneOf || schema.items?.enum
    ? `Array<${schema.items.oneOf
      ? schema.items.oneOf.map(compactUnionBranch).join(' | ')
      : typeName(schema.items)}>` : `${typeName(schema.items)}[]`;
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'object' || schema.properties) return 'object';
  return schema.type || 'unknown';
}

function propertySchemas(schema) {
  if (schema?.properties) return schema.properties;
  if (schema?.oneOf) {
    const merged = {};
    for (const branch of schema.oneOf) {
      for (const [name, property] of Object.entries(propertySchemas(branch))) {
        const candidates = merged[name]?.oneOf || (merged[name] ? [merged[name]] : []);
        if (!candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(property))) candidates.push(property);
        merged[name] = candidates.length === 1 ? candidates[0] : { oneOf: candidates };
      }
    }
    return merged;
  }
  return {};
}

function requiredProperties(schema) {
  if (schema?.required) return new Set(schema.required);
  if (!schema?.oneOf?.length) return new Set();
  const branches = schema.oneOf.map((item) => new Set(item.required || []));
  return new Set([...branches[0]].filter((name) => branches.every((branch) => branch.has(name))));
}

function schemaSignature(methodName, schema) {
  const properties = propertySchemas(schema);
  const required = requiredProperties(schema);
  const params = Object.entries(properties).map(([name, property]) => `${name}${required.has(name) ? '' : '?'}: ${typeName(property)}`);
  return `${methodName}({ ${params.join(', ')} })`;
}

function signatures(method) {
  return (method.inputSchema.oneOf || [method.inputSchema]).map((schema) => schemaSignature(method.name, schema));
}

function signature(method) {
  return signatures(method).join(' / ');
}

function detailedType(schema) {
  if (schema.oneOf) return schema.oneOf.map(detailedType).join(' | ');
  if (schema.type === 'array') return `Array<${detailedType(schema.items)}>`;
  if (schema.properties) return `{ ${Object.entries(schema.properties).map(([name, child]) =>
    `${name}${(schema.required || []).includes(name) ? '' : '?'}: ${detailedType(child)}`).join('; ')} }`;
  return typeName(schema);
}

module.exports = {
  detailedType,
  propertySchemas,
  requiredProperties,
  signature,
  signatures,
  typeName,
};
