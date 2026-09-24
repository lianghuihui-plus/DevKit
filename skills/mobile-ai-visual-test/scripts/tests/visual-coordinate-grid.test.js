#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { GRID_MAX, renderCoordinateRuler } = require('../lib/coordinate-ruler');

const source = {
  width: 100,
  height: 200,
  pixels: Buffer.alloc(100 * 200 * 4),
};
for (let offset = 0; offset < source.pixels.length; offset += 4) {
  source.pixels[offset] = 12;
  source.pixels[offset + 1] = 34;
  source.pixels[offset + 2] = 56;
  source.pixels[offset + 3] = 255;
}

const rendered = renderCoordinateRuler(source);
assert.strictEqual(GRID_MAX, 10000);
assert.deepStrictEqual(rendered.coordinateSpace, {
  kind: 'SCREENSHOT_GRID',
  minimum: 0,
  maximum: 10000,
  origin: 'TOP_LEFT',
  xDirection: 'RIGHT',
  yDirection: 'DOWN',
  contentRect: { x: 82, y: 54, width: 100, height: 200 },
});
assert.strictEqual(rendered.image.width, 264);
assert.strictEqual(rendered.image.height, 308);

const contentOffset = ((54 + 30) * rendered.image.width + 82 + 20) * 4;
assert.deepStrictEqual([...rendered.image.pixels.subarray(contentOffset, contentOffset + 4)], [12, 34, 56, 255],
  'ruler rendering must preserve source screenshot pixels exactly');

const borderOffset = (10 * rendered.image.width + 10) * 4;
assert.notDeepStrictEqual([...rendered.image.pixels.subarray(borderOffset, borderOffset + 4)], [12, 34, 56, 255],
  'ruler must be rendered outside the screenshot content');

function pixelAt(x, y) {
  const offset = (y * rendered.image.width + x) * 4;
  return [...rendered.image.pixels.subarray(offset, offset + 4)];
}

assert.deepStrictEqual(pixelAt(132, 40), [2, 96, 182, 255],
  'the horizontal 5000 position must have a blue major tick');
assert.deepStrictEqual(pixelAt(109, 4), [15, 23, 42, 255],
  'the top 5000 label must be drawn in the ruler margin');

console.log('visual coordinate grid passed');
