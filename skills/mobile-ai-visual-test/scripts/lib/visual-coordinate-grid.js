'use strict';

const GRID_MIN = 0;
const GRID_MAX = 10000;

function normalizedPoint(point) {
  return point.map((value) => Number(value) / GRID_MAX);
}

function normalizePlanSteps(steps) {
  return (steps || []).map((step) => {
    if (step.type === 'act' && step.actionRef?.startsWith('visual:')) {
      const input = { ...(step.input || {}) };
      for (const field of ['point', 'from', 'to']) {
        if (Array.isArray(input[field])) input[field] = normalizedPoint(input[field]);
      }
      return { ...step, ...(step.input ? { input } : {}) };
    }
    if (step.type === 'locate' && step.locator?.kind === 'POINT') {
      return { ...step, locator: { ...step.locator, point: normalizedPoint(step.locator.point) } };
    }
    if (step.type === 'locate' && step.locator?.kind === 'REGION') {
      return { ...step, locator: { ...step.locator, region: normalizedPoint(step.locator.region) } };
    }
    return step;
  });
}

module.exports = {
  GRID_MAX,
  GRID_MIN,
  normalizePlanSteps,
  normalizedPoint,
};
