'use strict';

const { getUploadsStore, jsonResponse, errorResponse } = require('./_lib');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return errorResponse(405, 'Method not allowed');

  try {
    const store = getUploadsStore();
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key);
    const bodies = keys.filter((f) => /^body_\d+\./i.test(f)).sort();
    const tattoos = keys.filter((f) => /^tattoo_\d+\./i.test(f)).sort();

    return jsonResponse(200, {
      status: 'ok',
      bodies: bodies.map((f) => ({ filename: f, url: '/uploads/' + f })),
      tattoos: tattoos.map((f) => ({ filename: f, url: '/uploads/' + f })),
      ai_model: process.env.AI_MODEL_NAME || 'gemini-2.5-flash-preview-05-20',
      ai_ready: !!process.env.AI_PROVIDER_API_KEY,
    });
  } catch (err) {
    return errorResponse(500, err.message);
  }
};