## Task 4A1 - Sequence record replay foundation

### Files

- Added `scripts/case-runtime/sequence-service.js` with signed record persistence, record-level integrity validation, deterministic reads, terminal lookup, and response replay projection.
- Added and registered `scripts/tests/sequence-record.test.js`.

### RED

- `node scripts/tests/sequence-record.test.js` failed with `MODULE_NOT_FOUND` for `sequence-service.js`.

### GREEN

- `node scripts/tests/sequence-record.test.js` passed after the record/replay helpers were implemented.

### Evidence

- Rewriting the same unsigned record produces the same SHA-256 signature.
- Exact lookup succeeds after `current-scene.json` moves beyond the submitted basis Scene and ignores changed `remainingMs` / `decisionId` metadata.
- A changed stable step produces a different request key and no replay match.
- Tampered and nonterminal same-key records raise `SEQUENCE_RECORD_INCOMPLETE` instead of allowing a duplicate Sequence.

### Self-review

- Integrity checks in 4A1 intentionally cover only record schema, execution binding, reference, request-key shape, and signature.
- Action/event/Scene graph integrity, execution, capture planning, budgets, and crash recovery remain Task 4A/4B work.
