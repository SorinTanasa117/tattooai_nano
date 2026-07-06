'use strict';

const {
  getUploadsStore,
  jsonResponse,
  errorResponse,
  isAllowedUploadFilename,
  parseMultipartEvent,
  nextFilename,
  extOf,
  getHeader,
} = require('./_lib');

const PREFIX_MAP = { body: 'body', tattoo: 'tattoo', 'steal-source': 'steal_src', composite: 'composite' };

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return errorResponse(405, 'Method not allowed');

  const kind = (event.queryStringParameters && event.queryStringParameters.kind) || '';
  const prefix = PREFIX_MAP[kind];
  if (!prefix) return errorResponse(400, 'Unknown upload kind: ' + kind);

  const ct = getHeader(event, 'content-type');
  if (!ct.toLowerCase().startsWith('multipart/form-data')) {
    return errorResponse(400, 'Expected multipart/form-data');
  }

  try {
    const { originalName, data } = parseMultipartEvent(event);
    const ext = extOf(originalName);
    const store = getUploadsStore();
    const finalName = await nextFilename(store, prefix, ext);

    if (!isAllowedUploadFilename(finalName)) {
      return errorResponse(400, 'Generated filename not allowed: ' + finalName);
    }

    await store.set(finalName, data);

    return jsonResponse(200, {
      status: 'ok',
      kind,
      filename: finalName,
      originalName,
      size: data.length,
      url: '/uploads/' + finalName,
    });
  } catch (err) {
    return errorResponse(400, err.message);
  }
};