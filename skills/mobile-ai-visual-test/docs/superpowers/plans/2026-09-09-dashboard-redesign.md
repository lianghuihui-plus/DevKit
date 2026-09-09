# MAVT Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the published MAVT dashboard and execution report with the approved compact matrix design while preserving existing report paths, contracts, and evidence artifacts.

**Architecture:** Keep report generation serverless and self-contained: `current-index.js` renders the workspace overview, `report-service.js` renders the public case-content page, and `current-report.js` renders each platform execution report. Existing projection and evidence models remain authoritative; the redesign only changes their HTML presentation and browser-side interaction.

**Tech Stack:** Node.js CommonJS, generated semantic HTML/CSS/vanilla JavaScript, repository self-tests using Node `assert`.

---

### Task 1: Lock the overview contract with failing tests

**Files:**
- Modify: `scripts/tests/dashboard.test.js`
- Test: `scripts/tests/dashboard.test.js`

- [ ] **Step 1: Add overview assertions**

Add assertions requiring compact platform summaries with counts and percentages, a public case-content link, executed-platform-only rows, per-platform timestamps and duration, and status filtering hooks.

- [ ] **Step 2: Run the dashboard suite and verify RED**

Run: `node scripts/self-test.js dashboard`

Expected: FAIL because the current overview lacks the approved matrix markup and percentage labels.

- [ ] **Step 3: Implement the overview matrix**

Update `current-index.js` so platform summaries derive from `item.platforms`, each case has a common section, and only actual platform executions create platform rows.

- [ ] **Step 4: Run the dashboard suite and verify GREEN**

Run: `node scripts/self-test.js dashboard`

Expected: `dashboard passed` and `self-test passed: dashboard`.

### Task 2: Make the case-level page content-only

**Files:**
- Modify: `scripts/tests/dashboard.test.js`
- Modify: `scripts/report/report-service.js`
- Test: `scripts/tests/dashboard.test.js`

- [ ] **Step 1: Add a content-page isolation assertion**

Require case-level `CONTEXT.html` to contain the original case content and exclude platform verdicts, platform report links, execution duration, and execution identifiers.

- [ ] **Step 2: Run the dashboard suite and verify RED**

Run: `node scripts/self-test.js dashboard`

Expected: FAIL because `rootOverview()` currently includes the platform execution section.

- [ ] **Step 3: Replace `rootOverview()` with a content-only renderer**

Render case number, title, identity metadata, and source markdown only; keep platform reports at their existing platform paths.

- [ ] **Step 4: Run the dashboard suite and verify GREEN**

Run: `node scripts/self-test.js dashboard`

Expected: all dashboard assertions pass.

### Task 3: Lock the six-tab execution report contract

**Files:**
- Modify: `scripts/tests/report-reader.test.js`
- Modify: `scripts/tests/execution-trace.test.js`
- Test: `scripts/tests/report-reader.test.js`
- Test: `scripts/tests/execution-trace.test.js`

- [ ] **Step 1: Add semantic tab and evidence assertions**

Require tabs for result summary, source case, understanding, plan, process, and detailed logs; require action purpose, expected effect, actual effect, screenshot viewer controls, and spatial evidence fields.

- [ ] **Step 2: Run report suites and verify RED**

Run: `node scripts/self-test.js report trace narrative`

Expected: FAIL because the current report exposes three top-level tabs.

- [ ] **Step 3: Recompose the existing narrative and trace projections**

Update `current-report.js` to render the six tabs without changing `buildExecutionTrace()` or `buildExecutionNarrative()` contracts. Preserve annotated screenshots and spatial evidence fields from the existing trace.

- [ ] **Step 4: Run report suites and verify GREEN**

Run: `node scripts/self-test.js report trace narrative`

Expected: all selected suites pass.

### Task 4: Implement and verify screenshot inspection

**Files:**
- Modify: `scripts/tests/report-reader.test.js`
- Modify: `scripts/report/current-report.js`
- Test: `scripts/tests/report-reader.test.js`

- [ ] **Step 1: Assert viewer navigation and manipulation controls**

Require zoom in, zoom out, fit, actual size, previous, next, drag/pan handling, and layered base/overlay rendering.

- [ ] **Step 2: Run the report suite and verify RED if any control is absent**

Run: `node scripts/self-test.js report`

Expected: FAIL only for controls not already implemented.

- [ ] **Step 3: Complete the page-local viewer behavior**

Keep the existing screenshot index, render annotated screenshots from `annotatedScreenshotRef`, and provide mouse/touch pan after zoom without navigating away.

- [ ] **Step 4: Run the report suite and verify GREEN**

Run: `node scripts/self-test.js report`

Expected: all report assertions pass.

### Task 5: Full regression and responsive visual verification

**Files:**
- Modify: `scripts/tests/dashboard.test.js` only if a verified regression exposes a missing assertion
- Modify: `scripts/tests/report-reader.test.js` only if a verified regression exposes a missing assertion

- [ ] **Step 1: Run all repository self-tests**

Run: `node scripts/self-test.js`

Expected: every suite passes with exit code 0.

- [ ] **Step 2: Generate a current fixture report**

Use the repository fixture helpers to publish an overview, case-content page, and platform report into a temporary workspace.

- [ ] **Step 3: Inspect desktop and mobile layouts**

Open the generated `index.html` and platform `CONTEXT.html`; verify 1280x720 and 390x844 viewports, status filtering, case/report navigation, six tabs, screenshot zoom, pan, and spatial overlay rendering.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check` and `git diff --stat`.

Expected: no whitespace errors and only scoped report, test, plan, and retained prototype files are changed.
