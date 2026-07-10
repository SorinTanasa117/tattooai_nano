'use strict';

const { getUploadsStore, jsonResponse, errorResponse, getAIModelName, requireTenant, getPublicUrl } = require('./_lib');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return errorResponse(405, 'Method not allowed');

  const tenant = requireTenant(event);
  if (tenant.errorResponse) return tenant.errorResponse;

  try {
    const store = getUploadsStore();
    const { blobs } = await store.list({ prefix: tenant.tenantId + '/' });
    const keys = blobs.map((b) => b.key);
    const bodies = keys.filter((f) => /body_\d+\./i.test(f)).sort();
    const tattoos = keys.filter((f) => /tattoo_\d+\./i.test(f)).sort();

    return jsonResponse(200, {
      status: 'ok',
      bodies: bodies.map((f) => ({ filename: f, url: getPublicUrl(f) })),
      tattoos: tattoos.map((f) => ({ filename: f, url: getPublicUrl(f) })),
      ai_model: getAIModelName(),
      ai_ready: !!(process.env.AI_PROVIDER_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    });
  } catch (err) {
    return errorResponse(500, err.message);
  }
};
