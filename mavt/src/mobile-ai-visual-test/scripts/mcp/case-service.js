'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { PUBLIC_CONTRACT } = require('../case-runtime/agent-facing-contract');
const { runInVerifiedCaseContext, invalidResponse } = require('../case-runtime/agent-facing-client');
const { readPublishedResource } = require('../case-runtime/agent-resource-store');
const { validate } = require('./contract');

function image(context, ref) {
  const resource = readPublishedResource(context.execDir, ref);
  if (resource.data.type !== 'screenshot') throw Object.assign(new Error('Reference is not a published screenshot'), { code: 'RESOURCE_SCOPE_MISMATCH' });
  const { path: filename, sha256, mediaType } = resource.data.content;
  if (typeof filename !== 'string' || !fs.lstatSync(filename).isFile() || fs.realpathSync(filename) !== filename ||
    typeof sha256 !== 'string' || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(mediaType) ||
    resource.data.mediaType !== mediaType) throw Object.assign(new Error('Published image metadata is invalid'), { code: 'RESOURCE_INTEGRITY_INVALID' });
  const bytes = fs.readFileSync(filename);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw Object.assign(new Error('Published image bytes changed'), { code: 'RESOURCE_INTEGRITY_INVALID' });
  }
  return { status: 'SUCCEEDED', ref, mediaType, sha256, byteLength: bytes.length, path: filename,
    image: { type: 'image', mimeType: mediaType, data: bytes.toString('base64') } };
}

function invoke(context, name, args) {
  if (name === 'mavt_case_image') {
    validate(name, args);
    return image(context, args.ref);
  }
  const method = name.startsWith('mavt_case_') ? name.slice(10) : null;
  if (!Object.hasOwn(PUBLIC_CONTRACT.methods, method)) throw Object.assign(new Error('Unknown Case method'), { code: 'MAVT_MCP_TOOL_UNKNOWN' });
  try { validate(name, args); }
  catch (error) {
    if (error.code !== 'MAVT_MCP_INPUT_INVALID') throw error;
    return invalidResponse(context.execDir, { operation: method, input: args.input }, error.issues.map(issue => ({
      field: issue.fieldPath || issue.field || 'input', code: issue.code || 'INVALID', expected: issue.expected,
    })));
  }
  return runInVerifiedCaseContext(context, { operation: method, input: args.input }, { hostTransport: 'mcp' });
}

module.exports = { invoke };
