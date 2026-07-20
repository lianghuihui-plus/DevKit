'use strict';

const PROJECTION_PATTERNS = [
  /^scan\.json$/,
  /^target\.json$/,
  /^plan\.json$/,
  /^continuation\.json$/,
  /^contexts\/[^/]+\/(context|graph|frontier|metrics|live-cursor|verification-queue|back-capabilities|visual-equivalence|state-equivalence)\.json$/,
  /^known\/contexts\/[^/]+\.json$/,
  /^attempts\/[^/]+\.json$/,
  /^operations\/[^/]+\.json$/,
  /^goal\/(goal|match-result|verified-paths)\.json$/,
  /^evidence\/preparations\/[^/]+\.json$/,
  /^evidence\/restores\/[^/]+\.json$/,
  /^evidence\/navigations\/[^/]+\.json$/
];

const EVIDENCE_PATTERNS = [
  /^evidence\/observations\/[^/]+\/(observation|layout)\.json$/,
  /^evidence\/observations\/[^/]+\/screenshot\.png$/,
  /^evidence\/actions\/[^/]+\.json$/,
  /^evidence\/visual-reviews\/[^/]+\.json$/,
  /^evidence\/verifications\/[^/]+\/[^/]+\.json$/,
  /^evidence\/logs\/.+$/
];

const GENERATED_PATTERNS = [
  /^merged\/.+$/,
  /^report\.md$/
];

function normalized(relative) {
  return String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function matches(patterns, relative) {
  const value = normalized(relative);
  return patterns.some(pattern => pattern.test(value));
}

function artifactKind(relative) {
  if (matches(PROJECTION_PATTERNS, relative)) return 'projection';
  if (matches(EVIDENCE_PATTERNS, relative)) return 'evidence';
  if (matches(GENERATED_PATTERNS, relative)) return 'generated';
  return 'unknown';
}

function isProjectionPath(relative) { return artifactKind(relative) === 'projection'; }
function isEvidencePath(relative) { return artifactKind(relative) === 'evidence'; }
function isGeneratedPath(relative) { return artifactKind(relative) === 'generated'; }

module.exports = { artifactKind, isProjectionPath, isEvidencePath, isGeneratedPath };
