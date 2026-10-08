'use strict';

const GRID_MIN = 0;
const GRID_MAX = 10000;

function normalizedPoint(point) {
  return point.map((value) => Number(value) / GRID_MAX);
}

module.exports = {
  GRID_MAX,
  GRID_MIN,
  normalizedPoint,
};
