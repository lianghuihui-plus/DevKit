'use strict';

const { normalizeText } = require('./fingerprint');

function collectTexts(value, out = new Set()) {
  if (!value) return out; if (Array.isArray(value)) { value.forEach(x => collectTexts(x, out)); return out; }
  if (typeof value !== 'object') return out;
  for (const key of ['text', 'content', 'label', 'accessibilityLabel']) { const text = normalizeText(value[key]); if (text) out.add(text); }
  Object.values(value).forEach(x => { if (x && typeof x === 'object') collectTexts(x, out); }); return out;
}

function includesSemantic(texts, expected) { return texts.some(actual => actual.includes(expected) || expected.includes(actual)); }

function evaluate(goal, layout, agentAssessment = null) {
  const texts = [...collectTexts(layout)]; const criteria = goal.successCriteria || {};
  const required = criteria.requiredTexts || []; const optional = criteria.optionalTexts || [];
  const requiredMatches = required.filter(x => includesSemantic(texts, x)); const optionalMatches = optional.filter(x => includesSemantic(texts, x));
  let status = 'NOT_MATCHED'; const visual = agentAssessment?.status || null;
  if (visual === 'STRONG' && required.length > 0 && requiredMatches.length === required.length) status = 'CANDIDATE_STRONG';
  else if (visual !== 'NO_MATCH' && (visual === 'STRONG' || visual === 'UNCERTAIN' || requiredMatches.length > 0 || optionalMatches.length > 0)) status = 'CANDIDATE_UNCERTAIN';
  return { status, evidence: { observedTexts: texts, requiredMatches, missingRequiredTexts: required.filter(x => !requiredMatches.includes(x)), optionalMatches, agentAssessment } };
}

module.exports = { collectTexts, evaluate };
