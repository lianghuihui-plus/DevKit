'use strict';

const { fail } = require('./common');

const NON_GRAPH_POPUP_KINDS = Object.freeze(['GUIDE_POPUP', 'PROMOTION_POPUP', 'DISMISSIBLE_POPUP']);

function assessmentOf(visualReview) {
  const assessment = visualReview?.popupAssessment;
  if (!assessment || typeof assessment !== 'object') {
    fail('Popup review requires structured popupAssessment evidence', 'POPUP_ASSESSMENT_REQUIRED');
  }
  return assessment;
}

function assertBusinessModalReview(visualReview) {
  const assessment = assessmentOf(visualReview);
  const failures = [];
  if (assessment.popupPresent !== true) failures.push('popupPresent');
  if (assessment.graphRole !== 'STATE') failures.push('graphRole');
  if (assessment.popupKind !== 'BUSINESS_MODAL') failures.push('popupKind');
  if (assessment.openedByUserAction !== true) failures.push('openedByUserAction');
  if (assessment.containsBusinessControls !== true) failures.push('containsBusinessControls');
  if (assessment.stableBusinessSurface !== true) failures.push('stableBusinessSurface');
  if (assessment.dismissalSemantics !== 'CLOSES_BUSINESS_CONTEXT') failures.push('dismissalSemantics');
  if (!Array.isArray(assessment.visualEvidence) || !assessment.visualEvidence.length) failures.push('visualEvidence');
  if (!String(assessment.rationale || '').trim()) failures.push('rationale');
  if (failures.length) {
    fail('BUSINESS_MODAL requires structured visual evidence for a user-opened functional business dialog', 'BUSINESS_MODAL_REVIEW_INSUFFICIENT', 2, { failures, popupAssessment: assessment });
  }
  return assessment;
}

function assertInterruptionCleanupReview(visualReview, disposition) {
  const assessment = assessmentOf(visualReview);
  const failures = [];
  if (assessment.popupPresent !== true) failures.push('popupPresent');
  if (assessment.graphRole !== 'INTERRUPTION') failures.push('graphRole');
  if (!NON_GRAPH_POPUP_KINDS.includes(assessment.popupKind)) failures.push('popupKind');
  if (disposition && assessment.popupKind !== disposition) failures.push('popupKindDispositionMismatch');
  if (assessment.stablePageBlocking !== true) failures.push('stablePageBlocking');
  if (assessment.stablePageAfterDismissalExpected !== true) failures.push('stablePageAfterDismissalExpected');
  if (!assessment.dismissal || typeof assessment.dismissal !== 'object') failures.push('dismissal');
  else {
    if (assessment.dismissal.available !== true) failures.push('dismissal.available');
    if (!['TAP', 'BACK'].includes(assessment.dismissal.method)) failures.push('dismissal.method');
    if (assessment.dismissal.safety !== 'WEAK_DISMISS') failures.push('dismissal.safety');
  }
  if (!Array.isArray(assessment.visualEvidence) || !assessment.visualEvidence.length) failures.push('visualEvidence');
  if (!String(assessment.rationale || '').trim()) failures.push('rationale');
  if (failures.length) {
    fail('Non-business popup cleanup requires structured visual evidence and a weak-dismiss plan', 'INTERRUPTION_CLEANUP_REVIEW_INSUFFICIENT', 2, { failures, disposition, popupAssessment: assessment });
  }
  return assessment;
}

function assertDismissalMatchesAssessment(popupAssessment, dismissAction) {
  const failures = [];
  const method = popupAssessment?.dismissal?.method;
  if (method === 'TAP' && dismissAction?.type !== 'tap') failures.push('dismissAction.type');
  if (method === 'BACK' && (dismissAction?.type !== 'keyEvent' || String(dismissAction.key || '').toUpperCase() !== 'BACK')) failures.push('dismissAction.key');
  if (!['TAP', 'BACK'].includes(method)) failures.push('popupAssessment.dismissal.method');
  if (failures.length) {
    fail('Popup dismissal action does not match visual review dismissal method', 'POPUP_DISMISSAL_MISMATCH', 2, { failures, popupAssessment, dismissAction });
  }
  return true;
}

module.exports = {
  NON_GRAPH_POPUP_KINDS,
  assertBusinessModalReview,
  assertInterruptionCleanupReview,
  assertDismissalMatchesAssessment
};
