'use strict';

const MODE_CONTRACTS = Object.freeze({
  exploration: Object.freeze({
    id: 'exploration',
    strategy: 'exploration',
    scanScope: 'full',
    verificationRule: 'CANONICAL_SCREEN_PATH',
    recommendedProfile: 'standard',
    allowedProfiles: Object.freeze(['quick', 'standard', 'deep']),
    usesSuggestions: true,
    goalSpecPath: null,
    interactionPoints: Object.freeze([]),
    stoppingRules: Object.freeze({ exploration: '已发现安全 Frontier 与必要验证均收敛，或统一硬预算耗尽', goalDirected: null }),
    completedStopReasons: Object.freeze(['WORK_EMPTY'])
  }),
  'goal-directed': Object.freeze({
    id: 'goal-directed',
    strategy: 'goal-directed',
    scanScope: 'targeted',
    verificationRule: 'CONFIRMED_TARGET_PATH',
    recommendedProfile: 'goal',
    allowedProfiles: Object.freeze(['goal']),
    usesSuggestions: true,
    goalSpecPath: 'goal/goal.json',
    interactionPoints: Object.freeze(['发现候选时暂停并等待人工判断']),
    stoppingRules: Object.freeze({ exploration: null, goalDirected: '确认目标路径强验证成功，或统一硬预算耗尽/人工停止' }),
    completedStopReasons: Object.freeze(['GOAL_FOUND_VERIFIED'])
  })
});

function modeContract(scanMode) {
  return MODE_CONTRACTS[scanMode] || null;
}

module.exports = { MODE_CONTRACTS, modeContract };
