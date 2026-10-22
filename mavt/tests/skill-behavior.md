# Skill wrapper behavioral evidence

The baseline and forward evaluations below are historical evidence for the `0.1.0` wrappers and retain their original paths. In `0.1.1`, the published names become `mavt:author-cases`, `mavt:run-tests`, and `mavt:manage-knowledge`; current installation/discovery evidence is recorded in [the interface update](../docs/skill-interface.md).

Scope: instruction-only evaluations with no devices, production mutations, or actual entrypoint execution. These checks validate routing and decisions, not runtime implementation or device acceptance.

## Baseline (before wrapper files)

Fresh agent `/root/skill_entries/baseline_wrappers`, no inherited conversation. Scenario combined time pressure, a deleted old installation, a stalled CONSUMED dispatch, unknown old Agent liveness, and a request to inspect business evidence/restart.

Observed baseline:

- Chose to read current installation protocols before selecting the old Run: “所有插件资源从新安装根目录解析；不会沿用已删除安装目录中的脚本路径”. This fails pinned old-document routing.
- Proposed a generic replacement Agent payload: “传入新插件入口、工作区、准确的 Run／Case／dispatch 身份及恢复范围”. This fails the fixed delegationPrompt/loaderCommand-only contract.
- Correctly rejected duplicate writers with unknown liveness and distinguished five logical cases from one workbook. Those existing behaviors need preservation, not additional rules.
- Knowledge answer refused guessed versions and unknown-target deletion, but had no READY-only plugin binding/transaction entry because wrapper/API guidance was absent.

## Execution wrapper

- RED: routing/payload baseline failures above.
- Implemented resume before document loading, pinned paths, candidate selection, fixed dispatch-only delegation and host-specific recovery boundary.
- `python3 /Users/cm/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/mavt/skills/mobile-ai-visual-test`: PASS (`Skill is valid!`).
- GREEN: fresh `/root/skill_entries/wrappers_forward` used only the supplied four instruction files, with installation path relocated to `/tmp/插件 B/plugins/mavt`. It chose the exact `resume --workspace` command before any old-run docs; asked selection for R1/R2; then loaded only A's pinned coordinator principles, method index and host profile. It refused source/screenshots and duplicate Agent under unknown liveness, retained WAITING, and used maintenance continuation only after proven writer termination. It specified only fixed delegationPrompt and loaderCommand for a fresh isolated Agent, and required Coordinator verification after chat completion.

## Authoring wrapper

- Baseline preserved semantic five-case recognition but had no documented plugin bootstrap/fixed runtime import contract.
- GREEN: the same fresh forward evaluation chose `workspace --cwd`, the pinned case-authoring and authoring command references, five semantic drafts with stable sourceLocator/title/sourceText, and `<runtimeRoot>/scripts/import-cases.js`. It refused pre-generated Flow and device-based authoring, verified import metadata, then transitioned to execution without retelling source or claiming Skill switching clears history.
- `quick_validate.py plugins/mavt/skills/mavt-case-authoring`: PASS.

## Knowledge wrapper

- Baseline preserved unknown-fact and deletion caution but lacked the new READY-only binding and same-version prepare/apply protocol.
- GREEN: the same fresh forward evaluation chose `knowledge --workspace`, stopped on non-READY rather than initializing, read pinned workflow then inspect/contracts, kept unknown version facts absent, required resolved IDs and authorization before DELETE, and applied the already authorized K-login update without another confirmation. After hypothetical plugin B upgrade it kept both prepare/apply on the same pinned K absolute entry; loss of the old entry required a fresh prepare instead of reusing the old hash under B. It included formal paths, counts, warnings, transaction and backup in delivery.
- `quick_validate.py plugins/mavt/skills/mavt-knowledge-manager`: PASS.

All three Skill frontmatter validators passed after the final edits. `git diff --check` passed. This is one baseline and one fresh combined forward evaluation, not a statistical reliability claim. No API runtime, actual device lifecycle, Desktop reload, or device acceptance was exercised here.

## Rule ownership

| Source invariant | Required published owner |
| --- | --- |
| Facade state/UNKNOWN/original commands, environment confirmation and initialization recovery | Execution wrapper plus required pinned `references/coordinator-principles.md` and `references/coordinator.md` |
| Single writer, original Loader, independent context, true handles, wait/cancel | Execution wrapper plus required pinned `hosts/codex/delegation.md` |
| No Coordinator access to case/Brief/Scene/screenshots/knowledge investigation or business/device decisions | Execution wrapper plus pinned coordinator principles |
| App initial state/iOS package selection/input dependencies/technical resource ownership | Pinned coordinator principles, Case Prompt and runtime; not duplicated as another Skill |
| Case Baseline/Working Flow, checkpoints, visual evidence, result closure, act/runSequence and target-level input | Existing frozen Case Prompt/Brief and Case Runtime, loaded by Case Agent only |
| Semantic case boundaries, stable sourceLocator, unchanged business semantics, no pre-generated Flow | Authoring wrapper plus required pinned case-authoring and authoring command references |
| READY, no guessed facts, one independently applicable rule, no duplicate knowledge, deletion explicit, authorized apply without reconfirmation, blocking validation, warnings/backups | Knowledge wrapper plus required pinned workflow/contract/writing-guide/template |
| prepare/apply same absolute runtime entry, lost entry means re-prepare | Knowledge wrapper |

Fixed references must be packaged and manifest-verified; their names alone do not establish behavioral migration correctness. Source and release regression are recorded by the implementation owner.
