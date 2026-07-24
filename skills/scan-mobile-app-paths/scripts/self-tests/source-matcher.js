#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { candidateControlMatch } = require('../lib/semantic-fingerprint');
const { sourceMatchEligible } = require('../lib/source-matcher');

let tests = 0;
function check(value, expected) {
  assert.deepEqual(value, expected);
  tests += 1;
}

const courseNodes = [
  { text: '全部课程', id: 'title', bounds: [0, 0, 200, 80] },
  { text: '正式课', id: 'tab-formal', bounds: [0, 120, 120, 180] }
];

const ambiguousTextOnly = { type: 'tap', target: '正式课' };
const boundedText = { type: 'tap', target: '正式课', fallbackBounds: [0, 120, 120, 180] };
const idBased = { type: 'tap', target: '正式课', selector: { id: 'tab-formal' } };

check(candidateControlMatch(courseNodes, ambiguousTextOnly), { matched: false, textMatched: true, idMatched: false, boundsMatched: false });
check(candidateControlMatch(courseNodes, boundedText), { matched: true, textMatched: true, idMatched: false, boundsMatched: true });
check(candidateControlMatch(courseNodes, idBased), { matched: true, textMatched: true, idMatched: true, boundsMatched: false });

const similarButNotSamePage = {
  status: 'SAME_PAGE',
  reasonCode: 'SEMANTIC_ANCHORS_MATCHED',
  evidence: {
    sameLayout: false,
    sameRoleStructure: false,
    idScore: 0.1,
    titleScore: 0,
    anchorScore: 0.45,
    candidateControlTextMatched: true,
    candidateControlIdMatched: false,
    candidateControlBoundsMatched: false
  }
};
check(sourceMatchEligible(ambiguousTextOnly, similarButNotSamePage), false);

const strongPageWithBoundedControl = {
  status: 'SAME_PAGE',
  reasonCode: 'SEMANTIC_ANCHORS_MATCHED',
  evidence: {
    sameLayout: true,
    sameRoleStructure: false,
    idScore: 0.1,
    titleScore: 0,
    anchorScore: 0.45,
    candidateControlTextMatched: true,
    candidateControlIdMatched: false,
    candidateControlBoundsMatched: true
  }
};
check(sourceMatchEligible(boundedText, strongPageWithBoundedControl), true);

const reviewedRule = {
  status: 'SAME_PAGE',
  reasonCode: 'STATE_EQUIVALENCE_RULE_MATCHED',
  evidence: {
    sameLayout: false,
    sameRoleStructure: false,
    idScore: 0.1,
    titleScore: 0,
    anchorScore: 0.45,
    candidateControlTextMatched: true,
    candidateControlIdMatched: false,
    candidateControlBoundsMatched: false
  }
};
check(sourceMatchEligible(ambiguousTextOnly, reviewedRule), true);

console.log(JSON.stringify({ schemaVersion: 1, ok: true, scope: 'source-matcher', tests }, null, 2));
