'use strict';

const {
  getUploadsStore,
  jsonResponse,
  errorResponse,
  isAllowedUploadFilename,
  imageToBase64Part,
  callAI,
  nextFilename,
  getPublicUrl,
  requireTenant,
} = require('./_lib');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return errorResponse(405, 'Method not allowed');
  const t0 = Date.now();

  const tenant = requireTenant(event);
  if (tenant.errorResponse) return tenant.errorResponse;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return errorResponse(400, 'Invalid JSON: ' + e.message);
  }

  const { source_filename } = body;
  if (
    !isAllowedUploadFilename(source_filename) ||
    !/(?:^|\/)steal_src_/i.test(source_filename) ||
    !source_filename.startsWith(tenant.tenantId + '/')
  ) {
    return errorResponse(400, 'Invalid source_filename: must be a steal-source upload (steal_src_N.ext)');
  }

  const store = getUploadsStore();
  let sourceArrayBuffer;
  try {
    sourceArrayBuffer = await store.get(source_filename, { type: 'arrayBuffer' });
  } catch (e) {
    sourceArrayBuffer = null;
  }
  if (!sourceArrayBuffer) return errorResponse(400, 'Source file not found: ' + source_filename);
  const sourceBuffer = Buffer.from(sourceArrayBuffer);

  if (!(process.env.AI_PROVIDER_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return errorResponse(500, 'AI_PROVIDER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY is not configured');
  }

  try {
    const parts = [
      {
        text: [
          'Extract and isolate the tattoo design from this photo.',
          'Remove all skin, body parts, background, and non-tattoo elements.',
          'Return only the tattoo artwork — clean lines and colors on a white background — suitable for reuse as a tattoo template.',
          'Preserve the exact lines, shading, and colors of the tattoo.',
        ].join(' '),
      },
      imageToBase64Part(sourceBuffer, source_filename),
    ];

    const result = await callAI(parts);
    const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const outName = await nextFilename(store, 'stolen', ext, tenant.tenantId);
    await store.set(outName, result.data);

    const elapsed = Date.now() - t0;
    return jsonResponse(200, {
      status: 'done',
      output_filename: outName,
      output_url: getPublicUrl(outName),
      elapsed_ms: elapsed,
    });
  } catch (err) {
    return errorResponse(500, err.message, { step: 'steal' });
  }
};
