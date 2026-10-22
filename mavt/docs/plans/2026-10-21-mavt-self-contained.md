# MAVT self-contained project migration

> 后续开发位置更新：用户要求直接在 main 开发；完整实现已迁入 `/Users/cm/GitProj/DevKit/mavt`。下文的独立工作树约束和记录描述此前实施环境，后续不再使用该分支开发。

**Goal:** Follow the user's explicit correction: MAVT owns its full source, including knowledge management. Copying only the `mavt/` project must suffice to build and verify it without DevKit siblings.

**Architecture:** Move the existing plugin root to `mavt/`; move both complete source modules beneath `mavt/src/`, keeping their sibling relationship and existing runtime layout. Build from project-local mappings. Keep Codex wrappers in `mavt/skills/`, host instructions in `mavt/hosts/`, and all tests/docs inside the project. Retain the installable marketplace structure and immutable per-Run binding contract.

**Tech Stack:** Node.js built-ins, Bash, Markdown, JSON; no new runtime dependencies.

**Constraints:** Continue in `codex/mavt-plugin`; preserve original checkout; no commits, publication, personal configuration writes or device/simulator operations. User executes device acceptance. No symlinks or automatic sibling-source imports as a compatibility workaround.

The first attempt used `runtime/` for source; full source regression showed it collided with the strict installed-bundle guard. Source now uses `src/`, distribution retains `runtime/`; guards are unchanged.

## 1. Prove the project boundary before migration

- [x] Add `plugins/mavt/tests/project-boundary.test.js`: assert complete source ownership and copy the project alone into a fresh directory, execute its own builder, knowledge regression and installed smoke; inspect failure on missing local source.
- [x] Run `node --test plugins/mavt/tests/project-boundary.test.js`; confirm expected RED.

## 2. Move complete sources and fix project-local entrypoints

- [x] Move `plugins/mavt` to `mavt`, and both `skills/mobile-ai-visual-test` / `skills/mavt-knowledge-manager` source trees to its `src/`.
- [x] Update `mavt/build-plugin.js`: `DEFAULT_REPO=__dirname`, project-local `src/` source mappings, local manifest and bundle helper. Build no longer reads any parent source directory.
- [x] Update plugin test source roots and fixtures; keep installed output paths stable. Add a project-local `package.json` with build and scoped test commands, and `.gitignore` for generated outputs.
- [x] Move migration and original implementation plans into `mavt/docs/plans`; update live documentation paths, installation and source ownership explanations. Preserve prior verification as historical.

## 3. Verify source isolation and deliver

- [x] GREEN: project-boundary test, plugin regression, full 88-suite MAVT and 6-suite knowledge regression, 51-doc check and three Skill validators.
- [x] Deny filesystem reads to DevKit while building/testing a relocated source project; run real Codex CLI installation/upgrade from the new output using temporary CODEX_HOME.
- [x] Build final plugin marketplace and full source archive; verify extracted plugin integrity and extracted-source build.
- [x] Update implementation report, evidence, artifact hashes and migration status. Verify diff and internal documentation links. Device acceptance remains user-owned.

## Final evidence

- Full source project built and passed `npm test` with both DevKit roots denied by OS sandbox: 88 runtime suites, 6 knowledge suites, 26 plugin/boundary tests and 51 generated docs.
- Three Skill validators, actual Codex CLI install/upgrade, old-cache removal recovery, source-denied installed smoke and plugin ZIP integrity passed.
- Extracted full source archive rebuilt successfully with DevKit reads denied. Final archive checksums are delivered beside the archives in `dist/SHA256SUMS`.
- Runtime bundle identity is unchanged by source ownership migration: `5d0154601ddf7a976ff4be2b10c23631324ce2afcfe2cd0b46605ae135b95542`.
- No mobile hardware/simulators were operated; no commits or personal configuration changes.
