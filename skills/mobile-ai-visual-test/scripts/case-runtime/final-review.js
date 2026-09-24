'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const FINAL_REVIEW_EVENT = 'caseFinalReviewRequired';

function sourceText(execDir) {
  return fs.readFileSync(path.join(path.resolve(execDir), 'source.snapshot.md'), 'utf8');
}

function requestFinalReview(execDir, options = {}) {
  if (store.events(execDir).some((event) => event.type === FINAL_REVIEW_EVENT)) return false;
  store.appendEvent(execDir, FINAL_REVIEW_EVENT, {
    reason: 'FINAL_CASE_REVIEW',
  }, options);
  return true;
}

module.exports = { FINAL_REVIEW_EVENT, requestFinalReview, sourceText };
