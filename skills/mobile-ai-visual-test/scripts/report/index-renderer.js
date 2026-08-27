'use strict';

const path = require('path');
const { renderCurrentIndexHtml } = require('./current-index');
const { reportRendererInfo } = require('./renderer-manifest');
const { publishReportBundle } = require('./report-publisher');

function renderIndexArtifacts(rootDir, cases = [], options = {}) {
  const indexPath = path.join(rootDir, 'index.html');
  const generatedAt = options.generatedAt || new Date().toISOString();
  const html = renderCurrentIndexHtml(rootDir, cases);
  publishReportBundle(rootDir, { 'index.html': html }, {
    schemaVersion: 1,
    scope: 'index',
    reportErrors: cases.filter((item) => item.status === 'REPORT_ERROR').map((item) => ({
      caseKey: item.caseKey || null, title: item.title, code: item.reportErrorCode || 'REPORT_DATA_INVALID',
    })),
    ...reportRendererInfo(),
  }, { generatedAt });
  return indexPath;
}

module.exports = { renderIndexArtifacts };
