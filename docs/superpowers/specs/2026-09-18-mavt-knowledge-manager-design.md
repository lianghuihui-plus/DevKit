# MAVT Knowledge Manager Design

## Summary

Create a new `mavt-knowledge-manager` Skill beside `mobile-ai-visual-test`. The new Skill owns every user-facing knowledge-maintenance workflow for a MAVT workspace: inspecting, adding, updating, deleting, and validating knowledge entries. It accepts arbitrary readable source material and relies on the Agent to extract the business meaning.

MAVT remains a standalone, read-only consumer of knowledge. It keeps the parsing, defensive validation, retrieval, review, snapshot, and result-reference behavior required during test execution, but removes its public maintenance command and authoring guidance. Neither Skill calls or imports the other at runtime.

## Goals

- Let users ask an Agent to create or maintain knowledge from any readable input format.
- Restrict all operations to a ready MAVT workspace and its `knowledge/` directory.
- Support inspect, list, show, add, update, delete, and full validation workflows.
- Write changes directly after the user's request authorizes the operation.
- Prevent partial or invalid knowledge states through prospective validation and atomic commits.
- Keep MAVT independently executable when the manager Skill is not installed.
- Reduce MAVT's public documentation and commands to knowledge consumption only.

## Non-goals

- The manager does not execute MAVT cases or query knowledge for a case verdict.
- The manager does not initialize or repair a MAVT workspace.
- The manager does not prescribe source formats or implement source-specific importers.
- The manager does not add vector search, embeddings, semantic similarity, or confidence scores.
- The manager does not mutate frozen execution snapshots or published reports.
- The first version does not rename knowledge entry IDs; an ID change is an explicit delete plus add.

## Skill Boundary

### `mavt-knowledge-manager`

The manager owns:

- Recognizing knowledge-maintenance intent.
- Reading arbitrary user-provided material with the best available tools.
- Deciding whether the request creates one entry, several entries, or updates existing entries.
- Authoring guidance, templates, and recall-quality review.
- Workspace knowledge discovery and deterministic CRUD operations.
- Structural validation, reference validation, and authoring warnings.
- Recoverable backups and operation summaries.

### `mobile-ai-visual-test`

MAVT retains:

- Read-only parsing of Skill and workspace knowledge roots.
- Compatibility filtering, lexical retrieval, scoring, and candidate limits.
- Defensive validation before freezing a new execution request.
- Candidate snapshots, review conclusions, and result references.
- Runtime-facing documentation that explains when and how knowledge is used.

MAVT removes:

- The public `scripts/knowledge.js validate` maintenance entry point.
- The knowledge module from the maintenance command index and CLI manifest.
- Maintenance-oriented command and error documentation.
- Templates and instructions for creating or editing knowledge entries.

Defensive validation remains internal to MAVT because malformed input must be rejected before execution. It is consumption safety, not a user-facing maintenance capability.

## Workspace Constraint

Every manager operation requires an explicit `--workspace` path. The manager reads `<workspace>/workspace.json` and accepts only:

```json
{
  "schemaVersion": 1,
  "type": "mobile-ai-visual-test-workspace",
  "initializationState": "READY"
}
```

The manager never creates a workspace. Knowledge writes are restricted to `<workspace>/knowledge/`; symlinks and paths escaping that directory are rejected.

## Knowledge Contract

The interoperable file protocol remains Markdown knowledge contract version 1:

1. The first line is `# K-<stable-id> <title>`.
2. Exactly four non-empty level-two sections appear in this order:
   - `适用范围`
   - `可观察现象`
   - `结论与处理建议`
   - `追溯信息`
3. Supported scope metadata is `App`, `Platform`, `Version`, `Page`, `Operation`, `Valid until`, and `Conflicts with`.
4. Comma-separated values are allowed for list metadata.
5. Unknown scope facts are omitted rather than guessed.
6. Every file contains one entry and every entry ID is unique across the workspace knowledge root.

The manager's authoring guide is the canonical user-facing explanation of this contract. MAVT keeps only the parser behavior needed to consume it. Both implementations identify the protocol as version 1 in code and tests.

## Authoring Rules

The Agent applies these semantic rules before invoking deterministic writes:

- One entry describes one independently applicable observable phenomenon or rule.
- Prefer updating an existing entry when scope, phenomenon, and conclusion describe the same rule.
- Split source material when conclusions, scope, expiration, or traceability differ.
- Use stable App IDs, never product display names, in `App` metadata.
- Include only source-supported platform, version, page, operation, expiration, and conflict facts.
- Put objective, observable UI facts in `可观察现象`.
- Put explanation, decision boundaries, and recommended handling in `结论与处理建议`.
- Put source, confirmation method, owner, and date in `追溯信息`.
- Preserve common page, control, message, and symptom wording in the title and observable section so lexical retrieval can find the entry.
- Do not manufacture traceability or convert an uncertain statement into a confirmed rule.

## Deterministic Interface

The public entry point is:

```bash
node <skill-root>/scripts/knowledge-manager.js <operation> --workspace <workspace> [...]
```

Supported operations:

- `inspect`: summarize workspace validity, entry count, expired entries, and validation status.
- `list`: return compact metadata for all entries.
- `show --entry-id <id>`: return one exact entry and its path.
- `validate`: perform full structural and reference validation and return non-blocking authoring warnings.
- `prepare --request <json-path>`: validate a proposed transaction without changing the workspace and return its exact effects plus a `planHash`.
- `apply --request <json-path> --plan-hash <hash>`: revalidate the unchanged plan, commit atomically, and run post-commit validation.

The request document contains a non-empty `reason` and an ordered list of operations:

```json
{
  "schemaVersion": 1,
  "reason": "Record the confirmed HarmonyOS behavior",
  "operations": [
    { "type": "ADD", "draftPath": "/absolute/path/to/K-editor-001.md" },
    { "type": "UPDATE", "entryId": "K-editor-002", "draftPath": "/absolute/path/to/replacement.md" },
    { "type": "DELETE", "entryId": "K-editor-003" }
  ]
}
```

`ADD` fails when the ID already exists. `UPDATE` fails when the ID does not exist or the replacement changes the ID. `DELETE` fails when the ID does not exist or another surviving entry references it through `Conflicts with`. Multiple operations are validated against one prospective final state, allowing related changes to commit together.

New entries use `<workspace>/knowledge/<entryId>.md`. Updates preserve the existing relative path. Operations never edit Skill-level built-in knowledge.

## Mutation Safety

`prepare` captures hashes of all affected files and the current knowledge index. `apply` rejects stale plans when any relevant file changed after preparation.

Before committing, the manager validates the complete prospective knowledge root. It then:

1. Creates `<workspace>/.mavt/knowledge-maintenance/backups/<transactionId>/`.
2. Stores the request, plan, and original content of updated or deleted entries.
3. Writes additions and replacements through same-directory temporary files and atomic renames.
4. Removes deleted entries only after all replacement files are ready.
5. Runs full validation against the committed state.
6. Restores the backup if commit or post-commit validation fails.
7. Writes a transaction result containing before and after content hashes.

Backups make update and delete recoverable in workspaces that are not Git repositories. The Skill reports the backup path after every modifying transaction.

## Authoring Workflow

When triggered, the Agent:

1. Resolves the user-specified workspace and runs `inspect`.
2. Reads all user-provided sources completely using appropriate available tools.
3. Runs `list` and selectively uses `show` to find overlaps and conflicts.
4. Drafts one or more complete entries outside the live `knowledge/` directory.
5. Self-reviews scope accuracy, observability, traceability, and lexical recall terms.
6. Builds a transaction request and runs `prepare`.
7. Corrects all blocking errors and reviews warnings.
8. Applies the prepared plan without an extra confirmation for authorized add or update requests.
9. Deletes only when the user's request explicitly authorizes deletion of the resolved entry.
10. Reports changed IDs, paths, validation results, warnings, and backup location.

If the Agent cannot establish a trustworthy conclusion or traceable source, it must explain the missing evidence instead of writing speculative knowledge.

## Validation

Blocking validation covers:

- Workspace marker and readiness.
- Safe paths, regular files, and forbidden symlinks.
- Maximum file size.
- Heading, fixed section order, and non-empty sections.
- Stable unique entry IDs.
- Supported metadata syntax and App ID shape.
- Platform values, version expressions, and date format.
- Existing, non-self conflict references.
- Transaction operation conflicts and final-state validity.

Non-blocking authoring warnings cover:

- Missing `App` or `Platform` scope.
- Expired entries.
- Very short observable descriptions.
- Observable text with no distinctive business term beyond generic UI wording.
- Missing date-like traceability information.

Warnings never invent facts and do not prevent an explicitly requested operation.

## Compatibility Strategy

The Skills have no runtime imports, command calls, or installation dependency on one another. Compatibility is maintained as a protocol concern:

- Each Skill has standalone contract tests using equivalent valid and invalid fixtures.
- A DevKit-only interoperability test runs when both source directories are present and verifies that manager-produced entries are accepted by MAVT's read-only parser.
- Changes to the knowledge file contract require updating both implementations and the interoperability fixtures in one DevKit change.
- Retrieval semantics remain owned and tested only by MAVT; authoring-quality warnings remain owned and tested only by the manager.

## MAVT Migration

The MAVT change will:

1. Remove `scripts/knowledge.js` and its public command-manifest entry.
2. Remove `references/commands/knowledge.md` and maintenance-only error references.
3. Remove the knowledge row from `references/commands.md`.
4. Rewrite `references/knowledge.md` as a compact runtime-consumption reference.
5. Keep internal parsing and `validateKnowledgeRoots` for execution preflight.
6. Keep query, review, snapshot, integrity, and report behavior unchanged.
7. Adjust entry-point and documentation-boundary tests for the reduced public surface.

Existing workspace knowledge remains valid and requires no migration.

## Testing

The manager test suite will cover:

- Workspace acceptance and rejection.
- Valid and invalid entry parsing.
- List and show behavior.
- Add, update, delete, and mixed transactions.
- Duplicate IDs, ID-changing updates, missing targets, and conflict references.
- Stale `planHash` rejection.
- Atomic rollback after an injected failure.
- Backup contents and transaction result hashes.
- Warnings versus blocking failures.
- Safe path and symlink rejection.
- Standalone execution without importing MAVT.

MAVT's existing full self-test remains the regression gate. A DevKit interoperability test verifies the shared file protocol without introducing a runtime dependency.

## Development Isolation

Implementation occurs only in:

- Branch: `codex/add-mavt-knowledge-manager`
- Worktree: `/Users/cm/GitProj/DevKit-worktrees/add-mavt-knowledge-manager`

The worktree version of the new Skill will not be linked into the active Codex skill directory. Installation or linking occurs only after the branch is reviewed and integrated, so the currently running MAVT installation remains unchanged during development.
