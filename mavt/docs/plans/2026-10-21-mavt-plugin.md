# MAVT Codex plugin implementation plan

> 后续开发位置更新：按用户要求，完整实现已转入 `/Users/cm/GitProj/DevKit/mavt` 的 main 工作区；下文保留历史实施环境记录。

> Execute in this session using TDD, independent packaging/Skill work and integrated runtime review. Do not commit, merge, publish, change user configuration, or operate mobile devices.

**Goal:** Deliver one locally installable MAVT plugin with three Skills and immutable per-Run runtime binding.

**Architecture:** Own both complete runtime source trees under project-local `src/`. Build a self-contained local marketplace; pin its runtime and host instructions into READY workspaces before creating Runs. Reuse the existing Coordinator and Case state machines.

**Tech Stack:** Node.js built-in modules, Bash, Codex plugin/Skill manifests.

**Spec:** `src/mobile-ai-visual-test/docs/mavt-codex-plugin-tech-design.md` (reviewed design, sections 5–13 and 16; retained research-time statements are historical, implementation evidence is separate).

This completed initial plan is superseded for source ownership by `docs/project-boundary.md` and `docs/plans/2026-10-21-mavt-self-contained.md`; package/runtime contracts remain applicable.

## Global constraints

- One `mavt` plugin; three Skills; Case Agent remains internal.
- Workspace schema 1, Execution schema 14; preserve original business state machines.
- No device tests: user executes all tests requiring mobile hardware or simulators.
- No new Node dependencies, global MCP, hooks, implicit dependency installation, or automatic bundle GC.
- Runtime source now lives under project-local `src/` (user's later project-boundary correction); installed runtime has no root SKILL.md.
- New Runs pin code, documents, and Codex host profile; no fallback to new code.
- doctor is read-only; knowledge maintenance requires an existing READY workspace.
- Original checkout and its untracked documents/archives remain untouched; implement in managed worktree `codex/mavt-plugin`.

## Task 1: Integrity and atomic snapshots

Files: `src/mobile-ai-visual-test/scripts/lib/runtime-bundle.js`, `scripts/tests/runtime-bundle.test.js`.

- [x] Write failing behavioral tests for deterministic manifests, resource bytes/execute bits, path and symlink rejection, tamper/missing/extra detection, concurrent snapshot publication and failed staging.
- [x] Run `node --test scripts/tests/runtime-bundle.test.js` and observe expected failure.
- [x] Implement `createManifest(root, pluginVersion)`, `verifyBundle(root, expectedId)`, `pinBundle(pluginRoot, workspace)` with ordinary-file validation, SHA-256, same-filesystem staging/rename and content-addressed reuse.
- [x] Re-run covering tests; pinning never overwrites a published directory.

Manifest contract: `{schemaVersion:1,bundleId,pluginVersion,files:[{path,sha256,executable}]}`. Records sorted by bytewise path; bundleId = SHA256 of `JSON.stringify({schemaVersion:1,files})`. Only `runtime/` and `hosts/` are snapshotted; all actual files must match records exactly. Version excluded from content identity.

## Task 2: Build and three Skill wrappers

Files: `build-plugin.js`, `.codex-plugin/plugin.json`, `skills/*/SKILL.md`, `hosts/codex/delegation.md`, `tests/build.test.js`, `README.md`.

- [x] Write and run failing build tests: isolated complete file mapping, two-build equality, missing resources, Chinese/space output paths, accidental source inclusion and symlink rejection.
- [x] Build existing `scripts/prompts/references` and knowledge `scripts/references/assets` trees; exclude tests/dev artifacts in release, preserve APK/IME/shell assets.
- [x] Use Task 1 manifest API; emit `.agents/plugins/marketplace.json` and plugin `0.1.0`.
- [x] Behavioral baseline and forward-test three wrappers in fresh agents without devices. Derive plugin entry from actual loaded Skill path, use resume before old docs, preserve all rule ownership from design §5.1.
- [x] Run build/Skill validation and inspect generated installation structure.

## Task 3: Binding and entrypoints

Files: `scripts/lib/runtime-binding.js`, `scripts/coordinator/agent-facing-service.js`, `scripts/coordinator-agent.js`, `scripts/workspace.js`, `scripts/case-agent-bootstrap.js`, `scripts/case-runtime/*`, batch and maintenance entrypoints; `scripts/mavt-entry.js`; plugin integration tests.

- [x] Write failing tests for empty workspace initialization order, read-only doctor, READY-only knowledge, immutable binding/state paired publication, missing/corrupt/wrong bundle refusal before writes, multiple resume candidates and legacy detection.
- [x] Implement binding schema 1 and `runtimeBindingRequired:true`; stage initial Coordinator state and binding then publish directory before environment decisions.
- [x] Implement `workspace --cwd`, `knowledge --workspace`, `resume --workspace [--run]`, `doctor --workspace` as JSON CLI.
- [x] Return absolute runtimeRoot, bundleId, documentationRoot, pinned hostProfilePath and original Coordinator command; resume only reads/validates.
- [x] Guard original Coordinator, Loader, Case clients and mutating maintenance before side effects; keep standalone development behavior.
- [x] Test install A removed/B installed, cancellation before device confirmation, prepare/apply through A, missing binding/code, crash/concurrency and shared reports.

## Task 4: Neutral principles and verification

Files: `references/coordinator-principles.md`, `scripts/lib/agent-contract-manifest.js`, affected tests/contracts/docs, plugin README and validation results.

- [x] Extract original coordination rules into a host-neutral resource; preserve source Skill entry and standalone usage.
- [x] Add documentationRoot to Coordinator and Case bindings; regenerate docs, synchronize intentional exact-field assertions.
- [x] Verify full source regression and generated documentation; run release-only isolated smoke with source reads denied.
- [x] Install formal package in temporary CODEX_HOME, verify actual parser/three Skills and upgrade; no personal config changes.
- [x] Independent review of implementation versus design, fix substantive findings and rerun covering tests.
- [x] Deliver package, commands, evidence and explicit user-owned device checklist; do not claim device acceptance.

## Progress

- Completed: MAVT 88 suites; knowledge 6 suites; plugin 24 tests; 51 generated docs; three Skill validators.
- Real CLI installation/upgrade and source-read-denied package smoke passed against final bundle `5d0154601ddf7a976ff4be2b10c23631324ce2afcfe2cd0b46605ae135b95542`; ZIP unpack integrity passed.
- Independent review findings closed. Package, raw evidence and `src/mobile-ai-visual-test/docs/mavt-codex-plugin-implementation.md` delivered.
- User-owned device acceptance and desktop GUI reload remain unexecuted. No commit, merge, publication or personal configuration change.
- Feasibility evidence remains at the original checkout's `docs/mavt-codex-plugin-verification.md` and is not formal implementation evidence.
