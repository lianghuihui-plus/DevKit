'use strict';

const { modeContract } = require('./contracts');
const {
  filterFrontiersInStartScope,
  filterSuggestionsInStartScope,
  filterStateIdsInStartScope,
  observedRunDepthFromStart,
  startResolutionWork,
  verificationInStartScope
} = require('../exploration-start');

function identitySuggestion(suggestion) {
  return suggestion;
}

module.exports = {
  ...modeContract('exploration'),
  loadGuidance() {
    return null;
  },
  prioritizeSuggestion: identitySuggestion,
  frontierGoalRank() {
    return 0;
  },
  depthSlack(scan) {
    return Number(scan?.budget?.depthSlack || 0);
  },
  isGoalRelevant() {
    return false;
  },
  filterFrontiers({ items, scanDir, scan, contextId, graph }) {
    return filterFrontiersInStartScope({ items, scanDir, scan, contextId, graph });
  },
  filterSuggestions({ items, scanDir, scan, contextId, graph }) {
    return filterSuggestionsInStartScope({ items, scanDir, scan, contextId, graph });
  },
  filterBackfillStateIds({ stateIds, scanDir, scan, contextId, graph }) {
    return filterStateIdsInStartScope({ stateIds, scanDir, scan, contextId, graph });
  },
  filterVerifications({ items, scanDir, scan, contextId, graph }) {
    return items.filter(item => verificationInStartScope({ verification: item, scanDir, scan, contextId, graph }));
  },
  observedDepthForBudget(context) {
    return observedRunDepthFromStart(context);
  },
  preNextWork(context) {
    return startResolutionWork(context);
  },
  completedStopReasons() {
    return new Set(modeContract('exploration').completedStopReasons);
  }
};
