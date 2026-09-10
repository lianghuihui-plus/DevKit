'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { resolveArtifact, sha256File } = require('../lib/execution-evidence');
const { inspectPng } = require('../lib/image-evidence');
const { readJson } = require('../lib/execution-lifecycle');
const { technicalFacts, technicalFactState } = require('../lib/technical-facts');
const { evidenceRef, readActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const { validateCaseResult } = require('./contract');
const { validateCaseSpec } = require('../execution/contracts/case-spec-contract');
const { buildKnowledgeIndex } = require('./knowledge-review');
const store = require('./store');

function aggregateVerdict(checks) {
  const statuses = checks.map((check) => check.status);
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  if (statuses.length && statuses.every((status) => status === 'PASS')) return 'PASS';
  return null;
}

function canonicalFilePath(file) {
  const absolute = path.resolve(file || '');
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function validateVerdict(result, events) {
  if (['PASS', 'FAIL'].includes(result.verdict) && result.checks.length === 0) {
    throw contractError('CASE_RESULT_CHECKS_REQUIRED', `${result.verdict} requires at least one check`);
  }
  for (const [index, check] of result.checks.entries()) {
    if (['PASS', 'FAIL'].includes(check.status) && (!Array.isArray(check.sceneRefs) || check.sceneRefs.length === 0)) {
      throw contractError('CASE_RESULT_EVIDENCE_REQUIRED', `checks[${index}] requires at least one Scene reference`);
    }
  }
  const aggregate = aggregateVerdict(result.checks);
  if (aggregate && aggregate !== result.verdict) {
    throw contractError('CASE_RESULT_VERDICT_MISMATCH', `verdict ${result.verdict} does not match check aggregation ${aggregate}`);
  }
  if (['BLOCKED', 'INCONCLUSIVE'].includes(result.verdict)
    && result.checks.length === 0 && (result.uncertainties || []).length === 0) {
    throw contractError('CASE_RESULT_BASIS_REQUIRED', `${result.verdict} requires checks or uncertainties`);
  }
}

function validateExpectationCoverage(execDir, result, events, suppliedExecution = null) {
  const execution = suppliedExecution || readJson(path.join(execDir, 'execution.json'), null);
  if (!execution || execution.schemaVersion !== 10) {
    throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  }

  const sourceText = fs.readFileSync(path.join(execDir, 'source.snapshot.md'), 'utf8');
  const caseSpec = readJson(path.join(execDir, 'case-spec.snapshot.json'), null);
  if (!caseSpec) throw contractError('CASE_SPEC_MISSING', 'frozen CaseSpec snapshot is missing');
  validateCaseSpec(caseSpec, { sourceText, sourceSha: execution.sourceSha });
  if (execution.caseSpecSha !== caseSpec.specSha) throw contractError('CASE_SPEC_CHANGED', 'execution CaseSpec binding changed');
  const missing = [];
  const expectedRefs = caseSpec.expectations.map((item) => item.id);
  const suppliedRefs = result.checks.map((check) => check.expectationRef);
  const duplicates = suppliedRefs.filter((ref, index) => suppliedRefs.indexOf(ref) !== index);
  const unknown = [...new Set(suppliedRefs.filter((ref) => !expectedRefs.includes(ref)))];
  const uncovered = expectedRefs.filter((ref) => !suppliedRefs.includes(ref));
  for (const ref of [...new Set(duplicates)]) missing.push({ field: `checks.${ref}`, reason: '同一验证点只能提交一个最终检查' });
  for (const ref of unknown) missing.push({ field: `checks.${ref}`, reason: '引用了当前用例理解中不存在的验证点' });
  for (const ref of uncovered) missing.push({ field: `checks.${ref}`, reason: '验证点没有最终检查结果' });
  if (missing.length) {
    throw contractError('CASE_RESULT_INCOMPLETE', 'CaseResult does not cover the current expectations', { missing });
  }
  return { expectations: caseSpec.expectations, coveredExpectationRefs: suppliedRefs, complete: true };
}

function investigationConclusion(conclusions) {
  for (const value of ['APPLICABLE_FOUND', 'CONFLICTING', 'INSUFFICIENT', 'NO_APPLICABLE', 'NO_MATCH']) {
    if (conclusions.includes(value)) return value;
  }
  return null;
}

function validateKnowledgeClosure(result, events, execution = null, broker = null) {
  const { queries, reviews, applicableByExpectation } = buildKnowledgeIndex(events);
  const missing = [];
  const investigationRequired = broker?.schemaVersion === 3;
  const investigationByExpectation = {};
  const requiredExpectationRefs = [];
  const completedExpectationRefs = [];
  const technicalByRef = new Map(technicalFacts(events)
    .filter((event) => event.technicalFactRef)
    .map((event) => [event.technicalFactRef, event]));
  const referencedTechnicalFactRefs = new Set();
  for (const check of result.checks) {
    const applicable = applicableByExpectation.get(check.expectationRef) || new Set();
    const supplied = new Set(check.knowledgeRefs || []);
    for (const entryId of supplied) {
      if (!applicable.has(entryId)) {
        missing.push({
          field: `checks.${check.expectationRef}.knowledgeRefs`,
          reason: `知识 ${entryId} 未在该验证点的调查中评估为 APPLICABLE`,
        });
      }
    }
    const technicalRefs = check.technicalRefs || [];
    const unknownTechnicalRefs = technicalRefs.filter((ref) => !technicalByRef.has(ref));
    if (unknownTechnicalRefs.length) {
      missing.push({
        field: `checks.${check.expectationRef}.technicalRefs`,
        reason: `技术事实引用不存在：${unknownTechnicalRefs.join('、')}`,
      });
    }
    if (check.status !== 'BLOCKED' && technicalRefs.length) {
      missing.push({
        field: `checks.${check.expectationRef}.technicalRefs`,
        reason: '只有被 Runtime 技术事实直接阻止的 BLOCKED 检查可以引用技术事实',
      });
    }
    const validTechnicalRefs = [];
    for (const ref of technicalRefs.filter((item) => technicalByRef.has(item))) {
      const state = technicalFactState(technicalByRef.get(ref), events, execution, check.expectationRef);
      if (state.state === 'VALID') {
        validTechnicalRefs.push(ref);
        referencedTechnicalFactRefs.add(ref);
      } else {
        missing.push({
          field: `checks.${check.expectationRef}.technicalRefs`,
          reason: `${ref} ${state.reason}`,
        });
      }
    }
    const requiresInvestigation = investigationRequired && (
      check.status === 'FAIL'
      || check.status === 'INCONCLUSIVE'
      || (check.status === 'BLOCKED' && validTechnicalRefs.length === 0)
    );
    const associatedQueries = [...queries.values()].filter((event) => (event.expectationRefs || []).includes(check.expectationRef));
    const completedReviews = associatedQueries.map((event) => reviews.get(event.queryId)).filter(Boolean);
    const completed = completedReviews.length > 0;
    if (requiresInvestigation) requiredExpectationRefs.push(check.expectationRef);
    if (completed) completedExpectationRefs.push(check.expectationRef);
    const conclusion = investigationConclusion(completedReviews.map((event) => event.conclusion));
    investigationByExpectation[check.expectationRef] = {
      required: requiresInvestigation,
      status: conclusion || (requiresInvestigation ? 'MISSING' : 'NOT_REQUIRED'),
      queryIds: associatedQueries.map((event) => event.queryId),
      reviewedQueryIds: completedReviews.map((event) => event.queryId),
    };
    if (requiresInvestigation && !completed) {
      missing.push({
        field: `checks.${check.expectationRef}.knowledgeInvestigation`,
        reason: '负向结论前尚未完成与该验证点关联的知识调查',
      });
    }
  }
  if (missing.length) {
    throw contractError('CASE_RESULT_INCOMPLETE', 'CaseResult knowledge investigation is incomplete', { missing });
  }
  return {
    queryIds: [...queries.keys()],
    reviewedQueryIds: [...reviews.keys()],
    applicableEntryIds: [...new Set([...applicableByExpectation.values()].flatMap((items) => [...items]))],
    referencedTechnicalFactRefs: [...referencedTechnicalFactRefs],
    investigation: {
      requiredExpectationRefs: [...new Set(requiredExpectationRefs)],
      completedExpectationRefs: [...new Set(completedExpectationRefs)],
      missingExpectationRefs: [...new Set(requiredExpectationRefs.filter((ref) => !completedExpectationRefs.includes(ref)))],
      byExpectation: investigationByExpectation,
    },
  };
}

function validateSearchAbsence(execDir, result, execution, expectationCoverage = null) {
  const missing = [];
  const expectationByRef = new Map((expectationCoverage?.expectations || []).map((item) => [item.id, item]));
  for (const check of result.checks) {
    const searchFailure = expectationByRef.get(check.expectationRef)?.verificationKind === 'SEARCH_EXISTENCE'
      && check.status === 'FAIL';
    if (searchFailure && check.evidenceBasis?.type !== 'SEARCH_ABSENCE') {
      missing.push({ field: `checks.${check.expectationRef}.evidenceBasis`, reason: '搜索型验证点的不存在结论必须引用完整列表覆盖' });
      continue;
    }
    if (check.evidenceBasis?.type !== 'SEARCH_ABSENCE') continue;
    const ref = check.evidenceBasis.scrollContextRef;
    const sceneRef = check.evidenceBasis.sceneRef;
    if (!(check.sceneRefs || []).includes(sceneRef)) {
      missing.push({ field: `checks.${check.expectationRef}.evidenceBasis`, reason: `覆盖 Scene ${sceneRef} 未被该检查引用` });
      continue;
    }
    const evidenceScene = readJson(path.join(execDir, 'scenes', `${sceneRef}.json`), null);
    const context = (evidenceScene?.scrollContexts || []).find((entry) => entry.id === ref);
    if (!context) {
      missing.push({ field: `checks.${check.expectationRef}.evidenceBasis`, reason: `滚动覆盖 ${ref} 不属于 Scene ${sceneRef}` });
      continue;
    }
    if (context.generation !== execution.warmSessionGeneration) {
      missing.push({ field: `checks.${check.expectationRef}.evidenceBasis`, reason: `滚动覆盖 ${ref} 不属于当前 generation` });
    }
    if (context.trackingStatus !== 'TRACKING' || context.coverage !== 'CONTIGUOUS'
      || context.reachedStart !== 'CONFIRMED' || context.reachedEnd !== 'CONFIRMED'
      || context.absenceConclusionSupported !== true) {
      missing.push({ field: `checks.${check.expectationRef}.evidenceBasis`, reason: `滚动覆盖 ${ref} 尚不能支持完整列表不存在结论` });
    }
  }
  if (missing.length) throw contractError('CASE_RESULT_INCOMPLETE', 'CaseResult list search evidence is incomplete', { missing });
  return { searchAbsenceRefs: result.checks.map((check) => check.evidenceBasis?.scrollContextRef).filter(Boolean) };
}

function validateVisualInspectionCoverage(execDir, result, events, scenesById) {
  const runtime = readJson(path.join(execDir, 'runtime.json'), null);
  const required = [2, 3].includes(runtime?.broker?.schemaVersion)
    && runtime.broker.allowedOperations?.includes('inspectVisual') === true;
  if (!required) return { required: false, inspectedSceneRefs: [] };
  const inspections = events.filter((event) => event.type === 'visualInspected');
  const inspected = new Set();
  for (const event of inspections) {
    const sceneEvent = scenesById.get(event.sceneId);
    if (!sceneEvent || event.screenshotRef !== sceneEvent.screenshotRef
      || event.screenshotSha256 !== sceneEvent.screenshotSha256 || !String(event.observation || '').trim()) {
      throw contractError('VISUAL_INSPECTION_INVALID', `visual inspection does not match Scene evidence: ${event.sceneId || 'unknown'}`);
    }
    inspected.add(event.sceneId);
  }
  const cited = [...new Set(result.checks.flatMap((check) => check.sceneRefs || []))];
  const missing = cited.filter((sceneId) => !inspected.has(sceneId)).map((sceneId) => ({
    field: `scenes.${sceneId}.visualInspection`,
    reason: `结论引用的 Scene ${sceneId} 尚未完成截图视觉检查`,
  }));
  if (missing.length) {
    throw contractError('CASE_RESULT_INCOMPLETE', 'CaseResult visual inspection is incomplete', { missing });
  }
  return { required: true, inspectedSceneRefs: [...inspected].sort() };
}

function validateScene(execDir, sceneId, event, files, options = {}) {
  const sceneRef = `scenes/${sceneId}.json`;
  const sceneFile = resolveArtifact(execDir, sceneRef);
  if (!fs.existsSync(sceneFile) || !fs.statSync(sceneFile).isFile()) {
    throw contractError('CASE_RESULT_SCENE_MISSING', `Scene artifact is missing: ${sceneId}`);
  }
  files.add(sceneRef);
  const scene = readJson(sceneFile, null);
  if (!scene || scene.sceneId !== sceneId || event.sceneId !== sceneId) {
    throw contractError('CASE_RESULT_SCENE_INVALID', `Scene identity is invalid: ${sceneId}`);
  }
  if (scene.screenshot?.ref !== event.screenshotRef || scene.screenshot?.sha256 !== event.screenshotSha256) {
    throw contractError('CASE_RESULT_SCENE_INVALID', `Scene event and screenshot metadata disagree: ${sceneId}`);
  }
  if (canonicalJson(scene.app || null) !== canonicalJson(event.app || null)) {
    throw contractError('CASE_RESULT_SCENE_INVALID', `Scene event and App metadata disagree: ${sceneId}`);
  }
  const screenshot = resolveArtifact(execDir, scene.screenshot.ref);
  if (!fs.existsSync(screenshot) || !fs.statSync(screenshot).isFile()) {
    throw contractError('OBSERVATION_SCREENSHOT_MISSING', `Scene screenshot is missing: ${scene.screenshot.ref}`);
  }
  const hashFile = options.hashFile || sha256File;
  if (options.verifyContent !== false && hashFile(screenshot) !== scene.screenshot.sha256) {
    throw contractError('EXECUTION_ARTIFACT_CHANGED', `Scene screenshot digest changed: ${scene.screenshot.ref}`);
  }
  const png = inspectPng(screenshot);
  if (png.decodeStatus !== 'VALID') {
    throw contractError('OBSERVATION_SCREENSHOT_INVALID', `Scene screenshot is not a valid PNG: ${scene.screenshot.ref}`);
  }
  if (canonicalFilePath(scene.screenshot.path) !== canonicalFilePath(screenshot)
    || scene.screenshot.width !== png.width || scene.screenshot.height !== png.height) {
    throw contractError('CASE_RESULT_SCENE_INVALID', `Scene screenshot path or dimensions disagree: ${sceneId}`);
  }
  files.add(scene.screenshot.ref);
  if ((scene.layoutRef || null) !== (event.layoutRef || null)) {
    throw contractError('CASE_RESULT_SCENE_INVALID', `Scene event and layout metadata disagree: ${sceneId}`);
  }
  if (scene.layoutRef) {
    const layout = resolveArtifact(execDir, scene.layoutRef);
    if (!fs.existsSync(layout) || !fs.statSync(layout).isFile()) {
      throw contractError('OBSERVATION_ARTIFACT_MISSING', `Scene layout is missing: ${scene.layoutRef}`);
    }
    files.add(scene.layoutRef);
  }
  return scene;
}

function validateCaseRuntimeEvidenceGraph(execDir, suppliedResult = null, options = {}) {
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (!execution || execution.schemaVersion !== 10) {
    throw contractError('EXECUTION_SCHEMA_UNSUPPORTED', 'This execution was created by an unsupported protocol and must be run again');
  }
  const result = suppliedResult || readJson(path.join(execDir, 'result.json'), null);
  validateCaseResult(result);
  const events = store.events(execDir);
  validateVerdict(result, events);
  const expectationCoverage = validateExpectationCoverage(execDir, result, events, execution);
  const runtime = readJson(path.join(execDir, 'runtime.json'), null);
  const knowledgeCoverage = validateKnowledgeClosure(result, events, execution, runtime?.broker || null);
  const searchCoverage = validateSearchAbsence(execDir, result, execution, expectationCoverage);
  const sceneEvents = events.filter((event) => event.type === 'sceneObserved');
  const byScene = new Map(sceneEvents.map((event) => [event.sceneId, event]));
  if (byScene.size !== sceneEvents.length) throw contractError('CASE_RESULT_SCENE_INVALID', 'Scene event identities must be unique');
  const sceneDir = path.join(execDir, 'scenes');
  const storedSceneIds = fs.existsSync(sceneDir)
    ? fs.readdirSync(sceneDir).filter((name) => name.endsWith('.json')).map((name) => path.basename(name, '.json')).sort()
    : [];
  if (canonicalSceneIds(storedSceneIds) !== canonicalSceneIds([...byScene.keys()].sort())) {
    throw contractError('CASE_RESULT_SCENE_INVALID', 'Scene artifacts and sceneObserved events do not form a one-to-one graph');
  }
  const files = new Set();
  for (const [sceneId, event] of byScene) validateScene(execDir, sceneId, event, files, options);
  for (const event of events.filter((entry) => entry.type === 'actionCompleted' && entry.spatialEvidenceRef)) {
    const expectedRef = evidenceRef(event.operationId);
    if (event.spatialEvidenceRef !== expectedRef) {
      throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `action spatial evidence does not match operation ${event.operationId}`);
    }
    const evidence = readActionSpatialEvidence(execDir, expectedRef, {
      operationId: event.operationId,
      actionType: event.action?.type,
      verifyContent: options.verifyContent !== false,
    });
    if (evidence.screenshot?.ref !== byScene.get(event.sceneId)?.screenshotRef) {
      throw contractError('ACTION_SPATIAL_EVIDENCE_INVALID', `action spatial evidence does not use the operation's basis Scene: ${event.operationId}`);
    }
    files.add(expectedRef);
    if (evidence.screenshot?.ref) files.add(evidence.screenshot.ref);
    if (evidence.annotatedScreenshotRef) files.add(evidence.annotatedScreenshotRef);
  }
  // Schema v7 executions created before spatial evidence remain publishable.
  for (const event of events.filter((entry) => entry.type === 'actionCompleted'
    && !entry.spatialEvidenceRef && entry.coordinateAudit?.overlayRef)) {
    const legacyRef = `coordinate-audits/${event.operationId}.svg`;
    if (event.coordinateAudit.overlayRef !== legacyRef) {
      throw contractError('ACTION_COORDINATE_AUDIT_INVALID', `coordinate overlay does not match operation ${event.operationId}`);
    }
    const overlay = resolveArtifact(execDir, legacyRef);
    if (!fs.existsSync(overlay) || !fs.statSync(overlay).isFile()) {
      throw contractError('ACTION_COORDINATE_AUDIT_MISSING', `coordinate overlay is missing: ${legacyRef}`);
    }
    files.add(legacyRef);
  }
  for (const event of events.filter((entry) => entry.type === 'actionCompleted' && entry.duringActionObservation?.screenshotRef)) {
    const ref = event.duringActionObservation.screenshotRef;
    const screenshot = resolveArtifact(execDir, ref);
    if (!fs.existsSync(screenshot) || !fs.statSync(screenshot).isFile()) {
      throw contractError('DURING_ACTION_OBSERVATION_MISSING', `during-action screenshot is missing: ${ref}`);
    }
    const png = inspectPng(screenshot);
    if (png.decodeStatus !== 'VALID') throw contractError('DURING_ACTION_OBSERVATION_INVALID', `during-action screenshot is invalid: ${ref}`);
    if (event.duringActionObservation.screenshotSha256
      && options.verifyContent !== false
      && (options.hashFile || sha256File)(screenshot) !== event.duringActionObservation.screenshotSha256) {
      throw contractError('EXECUTION_ARTIFACT_CHANGED', `during-action screenshot digest changed: ${ref}`);
    }
    files.add(ref);
  }
  for (const event of events.filter((entry) => entry.type === 'knowledgeQueried')) {
    if (!Array.isArray(event.candidates) || event.candidateCount !== event.candidates.length
      || new Set(event.candidates.map((candidate) => candidate.entryId)).size !== event.candidates.length) {
      throw contractError('KNOWLEDGE_SNAPSHOT_INVALID', `knowledge query candidate metadata is invalid: ${event.queryId}`);
    }
    const candidateRefs = new Set(event.candidateRefs || []);
    for (const candidate of event.candidates || []) {
      if (!candidate.entryId || !candidate.snapshotRef || !candidate.contentSha
        || candidate.snapshotRef !== `knowledge/${candidate.contentSha}.md`
        || !candidateRefs.has(candidate.snapshotRef)) {
        throw contractError('KNOWLEDGE_SNAPSHOT_INVALID', `knowledge candidate metadata is invalid: ${candidate.entryId || 'unknown'}`);
      }
    }
    for (const ref of event.candidateRefs || []) {
      const file = resolveArtifact(execDir, ref);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw contractError('KNOWLEDGE_SNAPSHOT_MISSING', `knowledge snapshot does not exist: ${ref}`);
      }
      const contentSha = path.basename(ref, '.md');
      const hashFile = options.hashFile || sha256File;
      if (!/^[0-9a-f]{64}$/.test(contentSha) || (options.verifyContent !== false && hashFile(file) !== contentSha)) {
        throw contractError('KNOWLEDGE_SNAPSHOT_CHANGED', `knowledge snapshot digest changed: ${ref}`);
      }
      files.add(ref);
    }
  }
  const refs = [...new Set(result.checks.flatMap((check) => check.sceneRefs || []))];
  const unknown = refs.filter((ref) => !byScene.has(ref));
  if (unknown.length) throw contractError('CASE_RESULT_SCENE_UNKNOWN', `CaseResult references unknown scenes: ${unknown.join(', ')}`);
  const visualInspectionCoverage = validateVisualInspectionCoverage(execDir, result, events, byScene);
  return {
    files: [...files].sort(), events, result, sceneRefs: refs,
    technicalFacts: technicalFacts(events), expectationCoverage, knowledgeCoverage, searchCoverage,
    visualInspectionCoverage,
  };
}

function canonicalSceneIds(value) {
  return JSON.stringify(value);
}

function validateResultIntegrity(execDir, result) {
  const validated = validateCaseResult(result);
  const graph = validateCaseRuntimeEvidenceGraph(execDir, validated, { verifyContent: false });
  return { result: validated, graph };
}

module.exports = {
  aggregateVerdict,
  validateCaseRuntimeEvidenceGraph,
  validateExpectationCoverage,
  validateKnowledgeClosure,
  validateSearchAbsence,
  validateVisualInspectionCoverage,
  validateResultIntegrity,
  validateVerdict,
};
