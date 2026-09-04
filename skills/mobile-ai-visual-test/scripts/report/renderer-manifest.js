'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { implementationGroups } = require('../lib/agent-contract-manifest');

function reportRendererInfo(skillRoot = path.resolve(__dirname, '../..')) {
  const files = implementationGroups(skillRoot, 'harmony').report;
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const file = path.join(skillRoot, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`REPORT_RENDERER_FILE_MISSING: ${relative}`);
    hash.update(`${relative}\0`, 'utf8');
    hash.update(fs.readFileSync(file));
    hash.update('\0', 'utf8');
  }
  return { reportRendererSha: `report-renderer-${hash.digest('hex').slice(0, 16)}`, rendererFiles: files };
}

module.exports = { reportRendererInfo };
