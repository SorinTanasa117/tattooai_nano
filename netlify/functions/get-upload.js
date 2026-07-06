'use strict';

const { getUploadsStore, isAllowedUploadFilename, extOf, MIME } = require('./_lib');

function getUploadFilename(event) {
  const queryFilename = event.queryStringParameters && event.queryStringParameters.filename;
  if (queryFilename) return queryFilename;

  const candidates = [event.rawUrl, event.path].filter(Boolean);
  for (const value of candidates) {
    const match = /\/uploads\/([^/?#]+)/.exec(value);
    if (match) return decodeURIComponent(match[1]);
  }

  return '';
}

// Serves GET /uploads/:filename by reading the blob out of the "uploads"
// store. Netlify Functions have no persistent disk, so this replaces
// server.js's handleUploads() (which streamed from UPLOAD_DIR on disk).
exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const fname = getUploadFilename(event);

  // Strict allowlist: only ever serve files matching our generated patterns.
  if (!isAllowedUploadFilename(fname)) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  const store = getUploadsStore();
  let arrayBuffer;
  try {
    arrayBuffer = await store.get(fname, { type: 'arrayBuffer' });
  } catch (e) {
    arrayBuffer = null;
  }
  if (!arrayBuffer) {
    return { statusCode: 404, body: 'Not found' };
  }

  const ext = extOf(fname);
  const contentType = MIME[ext] || 'application/octet-stream';
  const wantsDownload = (event.queryStringParameters && event.queryStringParameters.download) === '1';

  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  };
  if (wantsDownload) {
    headers['Content-Disposition'] = 'attachment; filename="' + fname.replace(/[\r\n"\\]/g, '_') + '"';
  }

  return {
    statusCode: 200,
    headers,
    body: Buffer.from(arrayBuffer).toString('base64'),
    isBase64Encoded: true,
  };
};
