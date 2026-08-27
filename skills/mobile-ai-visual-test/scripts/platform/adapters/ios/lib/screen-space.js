'use strict';

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`invalid ${label}: ${value}`);
  return number;
}

function attributes(tag) {
  const out = {};
  for (const match of String(tag || '').matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

function sourceViewport(source) {
  const xml = String(source || '');
  const tags = [...xml.matchAll(/<XCUIElementTypeWindow\b[^>]*>/g)].map((match) => attributes(match[0]));
  const window = tags.find((item) => item.visible !== 'false' && Number(item.width) > 0 && Number(item.height) > 0)
    || tags.find((item) => Number(item.width) > 0 && Number(item.height) > 0);
  if (window) return { width: Number(window.width), height: Number(window.height), source: 'window' };
  const application = attributes(xml.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0]);
  if (Number(application.width) > 0 && Number(application.height) > 0) {
    return { width: Number(application.width), height: Number(application.height), source: 'application' };
  }
  return null;
}

function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new Error('invalid PNG screenshot');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function pngSizeFromBase64(value) {
  return pngSize(Buffer.from(String(value || ''), 'base64'));
}

function scaleVisualPoint(point, screenshot, viewport) {
  const sourceWidth = positiveNumber(screenshot?.width, 'screenshot width');
  const sourceHeight = positiveNumber(screenshot?.height, 'screenshot height');
  const targetWidth = positiveNumber(viewport?.width, 'viewport width');
  const targetHeight = positiveNumber(viewport?.height, 'viewport height');
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('invalid visual point');
  return {
    x: Math.round(x * targetWidth / sourceWidth),
    y: Math.round(y * targetHeight / sourceHeight),
    screenshot: { width: sourceWidth, height: sourceHeight },
    viewport: { width: targetWidth, height: targetHeight },
  };
}

module.exports = { pngSize, pngSizeFromBase64, scaleVisualPoint, sourceViewport };
