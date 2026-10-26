'use strict';
const { reportingError } = require('./errors');
const uuid = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** Bind the current key to the immutable original through durable 410 rotations. */
function assertSessionKey(state, originalKey, receipt) {
  const fail = () => { throw reportingError('REPORTING_STATE_CORRUPT'); };
  if (!uuid(originalKey) || !uuid(state?.key)) fail();
  const rotations = state.keyRotations === undefined ? [] : state.keyRotations;
  if (!Array.isArray(rotations)) fail();
  let key = originalKey, sequence = 0;
  const seen = new Set([key]);
  for (const rotation of rotations) {
    if (rotation?.reason !== 'SESSION_EXPIRED' || rotation.previousKey !== key
      || !uuid(rotation.key) || seen.has(rotation.key)
      || !Number.isSafeInteger(rotation.sequence) || rotation.sequence <= sequence
      || rotation.sequence > state.sequence) fail();
    key = rotation.key;
    sequence = rotation.sequence;
    seen.add(key);
  }
  if (state.key !== key) fail();
  // Older, never-rotated receipts did not store the key. Rotated sessions must
  // carry an explicit terminal binding, so changing state cannot bless a receipt.
  if (receipt && (rotations.length || receipt.sessionKey !== undefined)
    && receipt.sessionKey !== key) fail();
}
module.exports = { assertSessionKey };
