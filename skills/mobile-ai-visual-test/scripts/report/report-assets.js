'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let cachedMermaid = null;

function mermaidAssetInfo() {
  if (cachedMermaid) return cachedMermaid;
  const sourcePath = path.resolve(__dirname, '../../assets/vendor/mermaid/mermaid.min.js');
  const content = fs.readFileSync(sourcePath);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  cachedMermaid = Object.freeze({
    sourcePath,
    sha256,
    bytes: content.length,
    workspaceRelativePath: `report-assets/mermaid-${sha256}.min.js`,
  });
  return cachedMermaid;
}

module.exports = { mermaidAssetInfo };
