#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS_BY_COLOR_TYPE = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const PIXEL_VERIFIABLE_CLAIMS = new Set(['BLACK_SCREEN', 'BLACK_BLOCKS', 'VERTICAL_BLACK_BLOCKS']);
const VALID_QUALITY_CLAIMS = new Set([...PIXEL_VERIFIABLE_CLAIMS, 'VISUAL_CORRUPTION', 'PREVIEW_DECODE_ERROR']);

let crcTable = null;

function buildCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  if (!crcTable) crcTable = buildCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function parsePng(buffer) {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('文件不是 PNG 或 PNG 签名无效');
  }
  let offset = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  let sawIend = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error('PNG chunk 头被截断');
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error('PNG chunk 内容被截断');
    const typeBuffer = buffer.subarray(offset + 4, offset + 8);
    const type = typeBuffer.toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBuffer, data]));
    if (expectedCrc !== actualCrc) throw new Error(`PNG ${type} chunk CRC 无效`);
    if (type === 'IHDR') {
      if (ihdr || length !== 13) throw new Error('PNG IHDR 无效');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawIend = true;
      offset = end;
      break;
    }
    offset = end;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (!sawIend) throw new Error('PNG 缺少 IEND');
  const trailingBytes = buffer.length - offset;
  if (!ihdr.width || !ihdr.height || ihdr.width * ihdr.height > 100_000_000) throw new Error('PNG 尺寸无效或过大');
  if (ihdr.bitDepth !== 8) throw new Error(`暂不支持 PNG bitDepth=${ihdr.bitDepth}`);
  if (!CHANNELS_BY_COLOR_TYPE.has(ihdr.colorType)) throw new Error(`暂不支持 PNG colorType=${ihdr.colorType}`);
  if (ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace !== 0) throw new Error('暂不支持该 PNG 压缩、过滤或交错格式');
  if (ihdr.colorType === 3 && (!palette || palette.length < 3 || palette.length % 3 !== 0)) throw new Error('索引色 PNG 缺少有效 PLTE');
  if (!idat.length) throw new Error('PNG 缺少 IDAT');
  return { ...ihdr, palette, transparency, idat: Buffer.concat(idat), trailingBytes };
}

function parsePngHeader(buffer) {
  if (!buffer || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

function decodePng(buffer) {
  const parsed = parsePng(buffer);
  const channels = CHANNELS_BY_COLOR_TYPE.get(parsed.colorType);
  const bytesPerPixel = channels;
  const rowBytes = parsed.width * channels;
  const expectedLength = parsed.height * (rowBytes + 1);
  const inflated = zlib.inflateSync(parsed.idat, { maxOutputLength: expectedLength + 1 });
  if (inflated.length !== expectedLength) throw new Error(`PNG 解码长度无效: ${inflated.length} != ${expectedLength}`);
  const pixels = Buffer.alloc(rowBytes * parsed.height);
  let inputOffset = 0;
  for (let y = 0; y < parsed.height; y++) {
    const filter = inflated[inputOffset++];
    if (filter > 4) throw new Error(`PNG scanline filter 无效: ${filter}`);
    const rowOffset = y * rowBytes;
    const previousOffset = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = inflated[inputOffset++];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[previousOffset + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[previousOffset + x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      pixels[rowOffset + x] = (raw + predictor) & 0xff;
    }
  }
  return { ...parsed, channels, rowBytes, pixels };
}

function compositeOnWhite(channel, alpha) {
  return Math.round((channel * alpha + 255 * (255 - alpha)) / 255);
}

function pixelRgb(decoded, x, y) {
  const offset = y * decoded.rowBytes + x * decoded.channels;
  const values = decoded.pixels;
  if (decoded.colorType === 0) {
    const gray = values[offset];
    const transparentGray = decoded.transparency?.length === 2 ? decoded.transparency.readUInt16BE(0) : -1;
    const alpha = gray === transparentGray ? 0 : 255;
    const composite = compositeOnWhite(gray, alpha);
    return [composite, composite, composite];
  }
  if (decoded.colorType === 2) {
    const rgb = [values[offset], values[offset + 1], values[offset + 2]];
    const transparent = decoded.transparency?.length === 6
      ? [decoded.transparency.readUInt16BE(0), decoded.transparency.readUInt16BE(2), decoded.transparency.readUInt16BE(4)]
      : null;
    const alpha = transparent && rgb.every((value, index) => value === transparent[index]) ? 0 : 255;
    return rgb.map((channel) => compositeOnWhite(channel, alpha));
  }
  if (decoded.colorType === 3) {
    const paletteIndex = values[offset];
    const paletteOffset = paletteIndex * 3;
    const alpha = decoded.transparency && paletteIndex < decoded.transparency.length ? decoded.transparency[paletteIndex] : 255;
    return [decoded.palette[paletteOffset] || 0, decoded.palette[paletteOffset + 1] || 0, decoded.palette[paletteOffset + 2] || 0]
      .map((channel) => compositeOnWhite(channel, alpha));
  }
  if (decoded.colorType === 4) {
    const alpha = values[offset + 1];
    const gray = compositeOnWhite(values[offset], alpha);
    return [gray, gray, gray];
  }
  const alpha = values[offset + 3];
  return [
    compositeOnWhite(values[offset], alpha),
    compositeOnWhite(values[offset + 1], alpha),
    compositeOnWhite(values[offset + 2], alpha),
  ];
}

function normalizeRegion(region) {
  if (!region || typeof region !== 'object' || Array.isArray(region)) throw new Error('qualityClaim region 必须是对象');
  const normalized = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(region[key]);
    if (!Number.isFinite(value)) throw new Error(`qualityClaim region.${key} 必须是数字`);
    normalized[key] = value;
  }
  if (normalized.x < 0 || normalized.y < 0 || normalized.width <= 0 || normalized.height <= 0 ||
      normalized.x + normalized.width > 1 || normalized.y + normalized.height > 1) {
    throw new Error('qualityClaim region 必须位于 0..1 的归一化坐标范围内');
  }
  return normalized;
}

function validateQualityClaim(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('qualityClaim 必须是对象');
  if (claim.source !== 'agent_preview') throw new Error('qualityClaim.source 必须是 agent_preview');
  if (!VALID_QUALITY_CLAIMS.has(claim.kind)) throw new Error(`不支持 qualityClaim.kind: ${claim.kind || '-'}`);
  if (claim.coordinateSpace !== undefined && claim.coordinateSpace !== 'normalized') {
    throw new Error('qualityClaim.coordinateSpace 必须是 normalized');
  }
  const regions = Array.isArray(claim.regions) ? claim.regions.map(normalizeRegion) : [];
  if (['BLACK_BLOCKS', 'VERTICAL_BLACK_BLOCKS'].includes(claim.kind) && !regions.length) {
    throw new Error(`${claim.kind} 必须提供至少一个 regions 区域`);
  }
  if (regions.length > 8) throw new Error('qualityClaim.regions 最多允许 8 个区域');
  return { ...claim, coordinateSpace: 'normalized', regions };
}

function regionPixelStats(decoded, region) {
  const x0 = Math.max(0, Math.floor(region.x * decoded.width));
  const y0 = Math.max(0, Math.floor(region.y * decoded.height));
  const x1 = Math.min(decoded.width, Math.max(x0 + 1, Math.ceil((region.x + region.width) * decoded.width - 1e-9)));
  const y1 = Math.min(decoded.height, Math.max(y0 + 1, Math.ceil((region.y + region.height) * decoded.height - 1e-9)));
  let pixels = 0;
  let nearBlack = 0;
  let lumaTotal = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = pixelRgb(decoded, x, y);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      pixels += 1;
      lumaTotal += luma;
      if (r <= 24 && g <= 24 && b <= 24) nearBlack += 1;
    }
  }
  return {
    bounds: [x0, y0, x1, y1],
    pixels,
    nearBlackPixels: nearBlack,
    nearBlackRatio: pixels ? Number((nearBlack / pixels).toFixed(6)) : 0,
    meanLuma: pixels ? Number((lumaTotal / pixels).toFixed(3)) : null,
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function inspectPng(file) {
  let buffer = null;
  try {
    buffer = fs.readFileSync(file);
    const decoded = decodePng(buffer);
    return {
      sha256: sha256(buffer),
      bytes: buffer.length,
      format: 'png',
      width: decoded.width,
      height: decoded.height,
      bitDepth: decoded.bitDepth,
      colorType: decoded.colorType,
      interlace: decoded.interlace,
      trailingBytes: decoded.trailingBytes,
      decodeStatus: 'VALID',
    };
  } catch (error) {
    const unsupported = /^暂不支持/.test(error.message);
    const header = parsePngHeader(buffer);
    return {
      sha256: buffer ? sha256(buffer) : null,
      bytes: buffer ? buffer.length : 0,
      format: 'png',
      width: header?.width || null,
      height: header?.height || null,
      bitDepth: header?.bitDepth,
      colorType: header?.colorType,
      interlace: header?.interlace,
      decodeStatus: unsupported ? 'UNSUPPORTED' : 'INVALID',
      error: error.message,
    };
  }
}

function verifyQualityClaim(file, claim, expectedSha256 = '') {
  const normalizedClaim = validateQualityClaim(claim);
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    return { verdict: 'SOURCE_INVALID', reason: error.message, claim: normalizedClaim, artifactSha256: null, pixelStats: [] };
  }
  const artifactSha256 = sha256(buffer);
  if (expectedSha256 && artifactSha256 !== expectedSha256) {
    return {
      verdict: 'SOURCE_CHANGED',
      reason: `截图 SHA-256 已变化: ${expectedSha256} != ${artifactSha256}`,
      claim: normalizedClaim,
      artifactSha256,
      pixelStats: [],
    };
  }
  let decoded;
  try {
    decoded = decodePng(buffer);
  } catch (error) {
    if (/^暂不支持/.test(error.message)) {
      return { verdict: 'UNVERIFIABLE', reason: error.message, claim: normalizedClaim, artifactSha256, pixelStats: [] };
    }
    return { verdict: 'SOURCE_INVALID', reason: error.message, claim: normalizedClaim, artifactSha256, pixelStats: [] };
  }
  if (!PIXEL_VERIFIABLE_CLAIMS.has(normalizedClaim.kind)) {
    return {
      verdict: 'UNVERIFIABLE',
      reason: `${normalizedClaim.kind} 暂无确定性原始像素判定规则`,
      claim: normalizedClaim,
      artifactSha256,
      image: { width: decoded.width, height: decoded.height },
      pixelStats: [],
    };
  }
  const regions = normalizedClaim.kind === 'BLACK_SCREEN'
    ? [{ x: 0, y: 0, width: 1, height: 1 }]
    : normalizedClaim.regions;
  const pixelStats = regions.map((region) => ({ region, ...regionPixelStats(decoded, region) }));
  const threshold = normalizedClaim.kind === 'BLACK_SCREEN' ? 0.95 : 0.8;
  const present = pixelStats.length > 0 && pixelStats.every((item) => item.nearBlackRatio >= threshold);
  return {
    verdict: present ? 'CLAIM_PRESENT_IN_SOURCE' : 'CLAIM_NOT_PRESENT_IN_SOURCE',
    reason: present
      ? '原始 PNG 的声明区域存在对应近黑像素特征；该结果不等同于截图损坏。'
      : '原始 PNG 的声明区域不存在对应近黑像素特征，疑似预览链路伪影或视觉误判。',
    claim: normalizedClaim,
    artifactSha256,
    image: { width: decoded.width, height: decoded.height },
    pixelStats,
  };
}

function eventObservation(event) {
  return event?.observation && typeof event.observation === 'object' ? event.observation : event;
}

function enrichObservationScreenshot(event, execDir) {
  const observation = eventObservation(event);
  const screenshot = observation?.artifacts?.screenshot;
  if (!screenshot) return event;
  const metadata = inspectPng(path.join(execDir, screenshot));
  observation.artifactMetadata = {
    ...(observation.artifactMetadata || {}),
    screenshot: metadata,
  };
  if (metadata.decodeStatus === 'INVALID') {
    event.ok = false;
    observation.ok = false;
    event.causeFailureCode = 'OBSERVATION_ARTIFACT_INVALID';
    event.failureCode = event.scope === 'precondition-flow'
      ? 'PRECONDITION_FLOW_OBSERVATION_FAILED'
      : 'OBSERVATION_ARTIFACT_INVALID';
    event.reason = event.reason || `截图产物无效: ${metadata.error}`;
  }
  return event;
}

function screenshotMetadata(event) {
  return eventObservation(event)?.artifactMetadata?.screenshot || null;
}

function main() {
  const command = process.argv[2];
  if (command !== 'enrich-observation' || !process.argv[3]) {
    process.stderr.write('Usage: image-evidence.js enrich-observation <execution-dir>\n');
    process.exit(2);
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const event = enrichObservationScreenshot(JSON.parse(input), path.resolve(process.argv[3]));
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
  });
}

if (require.main === module) main();

module.exports = {
  enrichObservationScreenshot,
  inspectPng,
  screenshotMetadata,
  validateQualityClaim,
  verifyQualityClaim,
};
