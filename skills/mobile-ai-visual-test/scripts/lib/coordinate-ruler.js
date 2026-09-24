'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { contractError } = require('./contract-utils');
const { atomicWrite } = require('./execution-lifecycle');
const { resolveArtifact } = require('./execution-evidence');
const { encodePngRgba, readPngRgba } = require('./image-evidence');
const { GRID_MAX } = require('./visual-coordinate-grid');

const MARGIN = Object.freeze({ left: 82, right: 82, top: 54, bottom: 54 });
const GLYPHS = Object.freeze({
  0: ['11111', '10001', '10011', '10101', '11001', '10001', '11111'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['11110', '00001', '00001', '11110', '10000', '10000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['10010', '10010', '10010', '11111', '00010', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01111', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '11110'],
});

function setPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  for (let channel = 0; channel < 4; channel++) image.pixels[offset + channel] = color[channel];
}

function fillRect(image, x, y, width, height, color) {
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) setPixel(image, px, py, color);
  }
}

function drawLine(image, x1, y1, x2, y2, color, thickness = 1) {
  const dx = Math.abs(x2 - x1);
  const sx = x1 < x2 ? 1 : -1;
  const dy = -Math.abs(y2 - y1);
  const sy = y1 < y2 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    fillRect(image, x1 - Math.floor(thickness / 2), y1 - Math.floor(thickness / 2), thickness, thickness, color);
    if (x1 === x2 && y1 === y2) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x1 += sx; }
    if (twice <= dx) { error += dx; y1 += sy; }
  }
}

function textWidth(value, scale) {
  return value.length * 5 * scale + Math.max(0, value.length - 1) * scale;
}

function drawText(image, value, x, y, scale, color) {
  let cursor = x;
  for (const character of value) {
    const glyph = GLYPHS[character];
    if (!glyph) continue;
    glyph.forEach((row, rowIndex) => [...row].forEach((bit, columnIndex) => {
      if (bit === '1') fillRect(image, cursor + columnIndex * scale, y + rowIndex * scale, scale, scale, color);
    }));
    cursor += 6 * scale;
  }
}

function coordinateSpace(width, height) {
  return {
    kind: 'SCREENSHOT_GRID', minimum: 0, maximum: GRID_MAX,
    origin: 'TOP_LEFT', xDirection: 'RIGHT', yDirection: 'DOWN',
    contentRect: { x: MARGIN.left, y: MARGIN.top, width, height },
  };
}

function renderCoordinateRuler(source) {
  const image = {
    width: source.width + MARGIN.left + MARGIN.right,
    height: source.height + MARGIN.top + MARGIN.bottom,
    pixels: Buffer.alloc((source.width + MARGIN.left + MARGIN.right) * (source.height + MARGIN.top + MARGIN.bottom) * 4),
  };
  const background = [248, 250, 252, 255];
  const axis = [15, 23, 42, 255];
  const major = [2, 96, 182, 255];
  const minor = [100, 116, 139, 255];
  fillRect(image, 0, 0, image.width, image.height, background);
  for (let y = 0; y < source.height; y++) {
    const from = y * source.width * 4;
    const to = ((y + MARGIN.top) * image.width + MARGIN.left) * 4;
    source.pixels.copy(image.pixels, to, from, from + source.width * 4);
  }
  const left = MARGIN.left;
  const top = MARGIN.top;
  const right = left + source.width - 1;
  const bottom = top + source.height - 1;
  drawLine(image, left, top, right, top, axis, 2);
  drawLine(image, left, bottom, right, bottom, axis, 2);
  drawLine(image, left, top, left, bottom, axis, 2);
  drawLine(image, right, top, right, bottom, axis, 2);
  for (let value = 0; value <= GRID_MAX; value += 100) {
    const isMajor = value % 1000 === 0;
    const isMedium = !isMajor && value % 500 === 0;
    const length = isMajor ? 18 : isMedium ? 12 : 6;
    const color = isMajor ? major : minor;
    const thickness = isMajor ? 2 : 1;
    const x = left + Math.round(value / GRID_MAX * (source.width - 1));
    const y = top + Math.round(value / GRID_MAX * (source.height - 1));
    drawLine(image, x, top - 1, x, top - length, color, thickness);
    drawLine(image, x, bottom + 1, x, bottom + length, color, thickness);
    drawLine(image, left - 1, y, left - length, y, color, thickness);
    drawLine(image, right + 1, y, right + length, y, color, thickness);
    if (!isMajor) continue;
    const label = String(value);
    const scale = 2;
    const width = textWidth(label, scale);
    const labelX = Math.max(2, Math.min(image.width - width - 2, x - Math.round(width / 2)));
    const labelY = Math.max(2, Math.min(image.height - 16, y - 7));
    drawText(image, label, labelX, 4, scale, axis);
    drawText(image, label, labelX, image.height - 18, scale, axis);
    drawText(image, label, 4, labelY, scale, axis);
    drawText(image, label, image.width - width - 4, labelY, scale, axis);
  }
  return { image, coordinateSpace: coordinateSpace(source.width, source.height) };
}

function ensureCoordinateRuler(execDir, screenshot) {
  const sourceRef = screenshot.ref || path.relative(execDir, screenshot.path);
  const sourcePath = resolveArtifact(execDir, sourceRef);
  const sourceBytes = fs.readFileSync(sourcePath);
  const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  if (screenshot.sha256 && screenshot.sha256 !== sourceSha256) {
    throw contractError('RESOURCE_INTEGRITY_INVALID', 'screenshot authority digest mismatch');
  }
  const rendered = renderCoordinateRuler(readPngRgba(sourcePath));
  const outputRef = path.join('screenshots', 'coordinate-grid', path.basename(sourceRef));
  const outputPath = path.join(path.resolve(execDir), outputRef);
  const output = encodePngRgba(rendered.image);
  atomicWrite(outputPath, output);
  return {
    ref: outputRef,
    path: outputPath,
    sha256: crypto.createHash('sha256').update(output).digest('hex'),
    width: rendered.image.width,
    height: rendered.image.height,
    coordinateSpace: {
      ...rendered.coordinateSpace,
      sourceScreenshot: {
        ref: sourceRef,
        width: rendered.coordinateSpace.contentRect.width,
        height: rendered.coordinateSpace.contentRect.height,
        sha256: sourceSha256,
      },
    },
  };
}

module.exports = {
  GRID_MAX,
  ensureCoordinateRuler,
  renderCoordinateRuler,
};
