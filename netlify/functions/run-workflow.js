'use strict';

const {
  getUploadsStore,
  jsonResponse,
  errorResponse,
  isAllowedUploadFilename,
  imageToBase64Part,
  callAI,
  nextFilename,
  getAIModelName,
  getPublicUrl,
  requireTenant,
} = require('./_lib');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return errorResponse(405, 'Method not allowed');
  const t0 = Date.now();

  const tenant = requireTenant(event);
  if (tenant.errorResponse) return tenant.errorResponse;

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return errorResponse(400, 'Invalid JSON: ' + e.message);
  }

  const required = ['body_filename', 'tattoo_filename', 'composite_x', 'composite_y', 'rotation', 'width', 'height'];
  const missing = required.filter((k) => payload[k] === undefined || payload[k] === null);
  if (missing.length) return errorResponse(400, 'Missing payload fields: ' + missing.join(', '));

  // Strict allowlist: body_filename must be a body upload, tattoo_filename must be a tattoo upload,
  // and both must belong to the requesting tenant.
  const ownsFile = (name) => typeof name === 'string' && name.startsWith(tenant.tenantId + '/');
  if (!isAllowedUploadFilename(payload.body_filename) || !/(?:^|\/)body_/i.test(payload.body_filename) || !ownsFile(payload.body_filename)) {
    return errorResponse(400, 'Invalid body_filename: must be a body upload (body_N.ext)');
  }
  if (!isAllowedUploadFilename(payload.tattoo_filename) || !/(?:^|\/)tattoo_/i.test(payload.tattoo_filename) || !ownsFile(payload.tattoo_filename)) {
    return errorResponse(400, 'Invalid tattoo_filename: must be a tattoo upload (tattoo_N.ext)');
  }

  const store = getUploadsStore();

  // Composite reference is optional
  let compositeBuffer = null;
  if (payload.composite_filename) {
    if (!isAllowedUploadFilename(payload.composite_filename) || !/(?:^|\/)composite_/i.test(payload.composite_filename) || !ownsFile(payload.composite_filename)) {
      return errorResponse(400, 'Invalid composite_filename: must be a composite upload (composite_N.ext)');
    }
    try {
      const ab = await store.get(payload.composite_filename, { type: 'arrayBuffer' });
      if (ab) compositeBuffer = Buffer.from(ab);
    } catch (e) {
      compositeBuffer = null;
    }
  }

  let bodyArrayBuffer, tattooArrayBuffer;
  try {
    bodyArrayBuffer = await store.get(payload.body_filename, { type: 'arrayBuffer' });
  } catch (e) {
    bodyArrayBuffer = null;
  }
  try {
    tattooArrayBuffer = await store.get(payload.tattoo_filename, { type: 'arrayBuffer' });
  } catch (e) {
    tattooArrayBuffer = null;
  }
  if (!bodyArrayBuffer) return errorResponse(400, 'Body file not found: ' + payload.body_filename);
  if (!tattooArrayBuffer) return errorResponse(400, 'Tattoo file not found: ' + payload.tattoo_filename);

  const bodyBuffer = Buffer.from(bodyArrayBuffer);
  const tattooBuffer = Buffer.from(tattooArrayBuffer);

  if (!(process.env.AI_PROVIDER_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return errorResponse(500, 'AI_PROVIDER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY is not configured');
  }

  try {
    const rotation = payload.rotation || 0;
    let prompt, parts;

    if (compositeBuffer) {
      // Composite reference mode: the AI sees exactly where the tattoo sits.
      prompt = [
        'You are given three images:',
        '  Image 1: the original body photo (clean, no tattoo).',
        '  Image 2: the tattoo design on a white background (black ink artwork).',
        '  Image 3: a placement reference — Image 1 with the tattoo already composited at 100% opacity showing its exact position, rotation, scale, and orientation on the body.',
        '',
        'Your task: produce a photorealistic render of the tattoo permanently embedded in the skin.',
        '',
        'Rules — follow every one precisely:',
        '- Match the tattoo placement EXACTLY as shown in Image 3: same position, same rotation (' + rotation + '°), same size relative to the body.',
        '- Render the tattoo as REAL PERMANENT INK — fully opaque, rich dark black lines, NOT a semi-transparent grey ghost overlay.',
        '- Use the exact linework, shading, and black-and-grey tones from Image 2 as the ink color source.',
        '- The ink sits IN the skin surface: skin texture, pores, fine hairs, and natural lighting are visible ON TOP of the ink.',
        '- Follow the 3D curvature and muscle contour of the body — the tattoo wraps around the form.',
        '- Preserve every detail of the original body photo (colors, lighting, background) in all areas outside the tattoo.',
        '- Do NOT add any transparency, glow, blending modes, or opacity reduction to the tattoo.',
        '- Do NOT add borders, frames, watermarks, or backgrounds.',
        '- Do NOT add any redness, inflammation, swelling, or irritation around the tattoo edges — the skin colour directly adjacent to the tattoo must match the surrounding skin tone exactly, as if the tattoo is fully healed.',
        '- Return ONLY the final full body photo with the tattoo naturally embedded.',
      ].join('\n');

      parts = [
        { text: prompt },
        imageToBase64Part(bodyBuffer, payload.body_filename),
        imageToBase64Part(tattooBuffer, payload.tattoo_filename),
        imageToBase64Part(compositeBuffer, payload.composite_filename),
      ];
    } else {
      // Fallback: no composite reference, use coordinate hints only
      prompt = [
        'You are given two images: Image 1 is the body photo, Image 2 is the tattoo design on a white background.',
        'Apply the tattoo as real permanent black ink onto the body photo.',
        `Placement: centre approximately at ${payload.composite_x}px from left, ${payload.composite_y}px from top.`,
        `Tattoo size: ${payload.width}px wide by ${payload.height}px tall.`,
        rotation !== 0 ? `Rotation: ${rotation} degrees clockwise.` : '',
        'The ink is fully opaque — NOT semi-transparent or grey. Use the exact dark lines from the tattoo design.',
        'Skin texture and natural lighting show on top of the ink. Tattoo wraps around body curves.',
        'Preserve the original body photo everywhere outside the tattoo.',
        'Return only the final full body photo.',
      ].filter(Boolean).join(' ');

      parts = [
        { text: prompt },
        imageToBase64Part(bodyBuffer, payload.body_filename),
        imageToBase64Part(tattooBuffer, payload.tattoo_filename),
      ];
    }

    const result = await callAI(parts);

    const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const outName = await nextFilename(store, 'result', ext, tenant.tenantId);
    await store.set(outName, result.data);

    const elapsed = Date.now() - t0;
    return jsonResponse(200, {
      status: 'done',
      output_filename: outName,
      output_url: getPublicUrl(outName),
      elapsed_ms: elapsed,
      ai_model: getAIModelName(),
    });
  } catch (err) {
    return errorResponse(500, err.message, { step: 'render' });
  }
};
