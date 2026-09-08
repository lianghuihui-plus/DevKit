'use strict';

function classifyActionEffect(before, after, operationId = null) {
  const beforeSha = before?.screenshot?.sha256;
  const afterSha = after?.screenshot?.sha256;
  if (!beforeSha || !afterSha) {
    return { status: 'UNKNOWN', reason: '动作前后截图不可比较', operationId };
  }
  if (beforeSha === afterSha) {
    return { status: 'UNCHANGED', reason: '动作前后截图完全一致，仅表示未观察到可见变化', operationId };
  }
  return { status: 'CHANGED', reason: '动作后截图与操作前现场不同，仅表示页面发生可见变化', operationId };
}

module.exports = {
  classifyActionEffect,
};
