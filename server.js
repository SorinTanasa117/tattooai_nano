#!/usr/bin/env node
/**
 * InkFrame dev server.
 * Zero npm dependencies. Serves the widget, handles uploads,
 * and proxies placement payloads to an AI image API.
 *
 * Env vars:
 *   PORT              - widget port (default 5000)
 *   AI_API_BASE_URL   - AI provider base URL (default https://generativelanguage.googleapis.com/v1beta)
 *   AI_PROVIDER_API_KEY - API key for the AI provider
 *   AI_MODEL_NAME     - model to use (default gemini-2.5-flash-preview-05-20)
 *   RENDER_TIMEOUT_MS - max wait for AI render, ms (default 30000)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
// Use Netlify's writable OS temporary directory if running in production
const UPLOAD_DIR = process.env.NETLIFY ? '/tmp' : path.join(ROOT, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Load .env from project root (no npm deps required)
(function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip inline comments (outside of quotes)
    if (!val.startsWith('"') && !val.startsWith("'")) {
      val = val.replace(/\s+#.*$/, '');
    }
    val = val.replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
})();
const PORT = parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || 'localhost';
const AI_API_BASE_URL = (process.env.AI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const AI_API_KEY = process.env.AI_PROVIDER_API_KEY || '';
const AI_MODEL_NAME = process.env.AI_MODEL_NAME || 'gemini-2.5-flash-preview-05-20';
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '30000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra) {
  if (!extra) extra = {};
  const body = Object.assign({ status: 'error', message }, extra);
  sendJson(res, status, body);
}

function parseMultipart(req, contentType, saveDir, prefix) {
  return new Promise((resolve, reject) => {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!m) return reject(new Error('No boundary in Content-Type'));
    const boundary = '--' + (m[1] || m[2]);
    const chunks = [];
    let total = 0;
    const limit = 25 * 1024 * 1024;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        req.destroy();
        reject(new Error('Upload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const parts = splitMultipart(buf, boundary);
        for (const part of parts) {
          const disp = part.headers['content-disposition'] || '';
          const nameMatch = /name="([^"]+)"/.exec(disp);
          if (!nameMatch || nameMatch[1] !== 'file') continue;
          const filenameMatch = /filename="([^"]*)"/.exec(disp);
          const origName = filenameMatch ? filenameMatch[1] : 'upload';
          const ext = (path.extname(origName) || '.png').toLowerCase();
          const data = part.body;
          const finalName = nextFilename(saveDir, prefix, ext);
          const outPath = path.join(saveDir, finalName);
          fs.writeFileSync(outPath, data);
          resolve({ filename: finalName, originalName: origName, size: data.length });
          return;
        }
        reject(new Error('No file field in multipart body'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function splitMultipart(buf, boundary) {
  const boundaryBuf = Buffer.from(boundary);
  const parts = [];
  let start = buf.indexOf(boundaryBuf);
  if (start < 0) return parts;
  start += boundaryBuf.length;
  while (start < buf.length) {
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = buf.indexOf(boundaryBuf, start);
    if (next < 0) break;
    let partEnd = next;
    if (buf[partEnd - 2] === 0x0d && buf[partEnd - 1] === 0x0a) partEnd -= 2;
    const section = buf.slice(start, partEnd);
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      start = next + boundaryBuf.length;
      continue;
    }
    const headerStr = section.slice(0, headerEnd).toString('utf8');
    const body = section.slice(headerEnd + 4);
    const headers = {};
    for (const line of headerStr.split('\r\n')) {
      const ci = line.indexOf(':');
      if (ci > 0) headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }
    parts.push({ headers, body });
    start = next + boundaryBuf.length;
  }
  return parts;
}

function nextFilename(dir, prefix, ext) {
  for (let i = 1; i < 10000; i++) {
    const name = `${prefix}_${i}${ext}`;
    const full = path.join(dir, name);
    try {
      const fd = fs.openSync(full, 'wx');
      fs.closeSync(fd);
      return name;
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error('Could not allocate a unique filename for prefix: ' + prefix);
}

function readJsonBody(req, limit) {
  if (!limit) limit = 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^([\\/])+/, '');
  const full = path.join(ROOT, safe);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

/**
 * Call the AI image generation API.
 * Sends an array of parts (text + inline_data) and returns { data: Buffer, mimeType: string }.
 */
async function callAI(parts) {
  if (!AI_API_KEY) throw new Error('AI_PROVIDER_API_KEY is not set in environment');

  const url = `${AI_API_BASE_URL}/models/${AI_MODEL_NAME}:generateContent?key=${AI_API_KEY}`;
  const reqBody = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error('AI API request failed: ' + e.message);
  }

  const rawText = await resp.text().catch(() => '');
  if (!resp.ok) {
    let detail = rawText.slice(0, 400);
    try {
      const parsed = JSON.parse(rawText);
      if (parsed.error && parsed.error.message) detail = parsed.error.message;
    } catch (_) {}
    throw new Error('AI API error (HTTP ' + resp.status + '): ' + detail);
  }

  let parsed;
  try { parsed = JSON.parse(rawText); } catch (_) {
    throw new Error('AI API returned non-JSON response: ' + rawText.slice(0, 200));
  }

  // Extract the first image part from the response
  const candidates = parsed.candidates || [];
  for (const candidate of candidates) {
    const responseParts = (candidate.content && candidate.content.parts) || [];
    for (const part of responseParts) {
      if (part.inlineData && part.inlineData.data) {
        return {
          data: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType || 'image/png',
        };
      }
      // Some API versions use camelCase vs snake_case
      if (part.inline_data && part.inline_data.data) {
        return {
          data: Buffer.from(part.inline_data.data, 'base64'),
          mimeType: part.inline_data.mime_type || 'image/png',
        };
      }
    }
  }

  // Surface any text response for debugging
  let textResponse = '';
  for (const candidate of candidates) {
    const responseParts = (candidate.content && candidate.content.parts) || [];
    for (const part of responseParts) {
      if (part.text) textResponse += part.text;
    }
  }
  throw new Error('AI API returned no image. ' + (textResponse ? 'Response: ' + textResponse.slice(0, 300) : 'Empty response.'));
}

function imageToBase64Part(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const mimeType = mimeMap[ext] || 'image/png';
  const data = fs.readFileSync(filePath).toString('base64');
  return { inlineData: { mimeType, data } };
}

// Allowlist of filename patterns that may be served or read.
// Only files matching these patterns (created by the upload/render handlers) are accessible.
const UPLOAD_PATTERNS = [
  /^body_\d+\.(png|jpe?g|webp)$/i,
  /^tattoo_\d+\.(png|jpe?g|webp)$/i,
  /^steal_src_\d+\.(png|jpe?g|webp|gif)$/i,
  /^stolen_\d+\.(png|jpe?g)$/i,
  /^composite_\d+\.(png|jpe?g|webp)$/i,
  /^result_\d+\.(png|jpe?g)$/i,
];
function isAllowedUploadFilename(name) {
  if (typeof name !== 'string') return false;
  if (name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return UPLOAD_PATTERNS.some((re) => re.test(name));
}

async function handleUpload(req, res, kind) {
  const prefixMap = { body: 'body', tattoo: 'tattoo', 'steal-source': 'steal_src', composite: 'composite' };
  const prefix = prefixMap[kind] || kind;
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) {
    return sendError(res, 400, 'Expected multipart/form-data');
  }
  try {
    const result = await parseMultipart(req, ct, UPLOAD_DIR, prefix);
    log('upload ' + kind + ':', result.filename, '(' + result.size + ' bytes)');
    sendJson(res, 200, {
      status: 'ok',
      kind: kind,
      filename: result.filename,
      originalName: result.originalName,
      size: result.size,
      url: '/uploads/' + result.filename,
    });
  } catch (err) {
    log('upload ' + kind + ' error:', err.message);
    sendError(res, 400, err.message);
  }
}

function handleStatus(res) {
  const files = fs.readdirSync(UPLOAD_DIR);
  const bodies = files.filter((f) => /^body_\d+\./i.test(f)).sort();
  const tattoos = files.filter((f) => /^tattoo_\d+\./i.test(f)).sort();
  sendJson(res, 200, {
    status: 'ok',
    bodies: bodies.map((f) => ({ filename: f, url: '/uploads/' + f })),
    tattoos: tattoos.map((f) => ({ filename: f, url: '/uploads/' + f })),
    ai_model: AI_MODEL_NAME,
    ai_ready: !!AI_API_KEY,
  });
}

async function handleStealTattoo(req, res) {
  const t0 = Date.now();
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendError(res, 400, 'Invalid JSON: ' + e.message);
  }

  const { source_filename } = body;
  if (!isAllowedUploadFilename(source_filename) || !/^steal_src_/i.test(source_filename))
    return sendError(res, 400, 'Invalid source_filename: must be a steal-source upload (steal_src_N.ext)');

  const sourcePath = path.join(UPLOAD_DIR, source_filename);
  if (!fs.existsSync(sourcePath))
    return sendError(res, 400, 'Source file not found: ' + source_filename);

  if (!AI_API_KEY)
    return sendError(res, 500, 'AI_PROVIDER_API_KEY is not configured');

  try {
    log('steal-tattoo: calling AI to extract tattoo from', source_filename);

    const parts = [
      {
        text: [
          'Extract and isolate the tattoo design from this photo.',
          'Remove all skin, body parts, background, and non-tattoo elements.',
          'Return only the tattoo artwork — clean lines and colors on a white background — suitable for reuse as a tattoo template.',
          'Preserve the exact lines, shading, and colors of the tattoo.',
        ].join(' '),
      },
      imageToBase64Part(sourcePath),
    ];

    const result = await callAI(parts);

    const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const outName = nextFilename(UPLOAD_DIR, 'stolen', ext);
    fs.writeFileSync(path.join(UPLOAD_DIR, outName), result.data);

    const elapsed = Date.now() - t0;
    log('steal-tattoo: done in', elapsed, 'ms ->', outName);
    sendJson(res, 200, {
      status: 'done',
      output_filename: outName,
      output_url: '/uploads/' + outName,
      elapsed_ms: elapsed,
    });
  } catch (err) {
    log('steal-tattoo: error:', err.message);
    sendError(res, 500, err.message, { step: 'steal' });
  }
}

async function handleRunWorkflow(req, res) {
  const t0 = Date.now();
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendError(res, 400, 'Invalid JSON body: ' + e.message);
  }

  const required = ['body_filename', 'tattoo_filename', 'composite_x', 'composite_y', 'rotation', 'width', 'height'];
  const missing = required.filter((k) => payload[k] === undefined || payload[k] === null);
  if (missing.length) return sendError(res, 400, 'Missing payload fields: ' + missing.join(', '));

  // Strict allowlist: body_filename must be a body upload, tattoo_filename must be a tattoo upload
  if (!isAllowedUploadFilename(payload.body_filename) || !/^body_/i.test(payload.body_filename))
    return sendError(res, 400, 'Invalid body_filename: must be a body upload (body_N.ext)');
  if (!isAllowedUploadFilename(payload.tattoo_filename) || !/^tattoo_/i.test(payload.tattoo_filename))
    return sendError(res, 400, 'Invalid tattoo_filename: must be a tattoo upload (tattoo_N.ext)');

  // Composite reference is optional
  let compositePath = null;
  if (payload.composite_filename) {
    if (!isAllowedUploadFilename(payload.composite_filename) || !/^composite_/i.test(payload.composite_filename))
      return sendError(res, 400, 'Invalid composite_filename: must be a composite upload (composite_N.ext)');
    const cp = path.join(UPLOAD_DIR, payload.composite_filename);
    if (fs.existsSync(cp)) compositePath = cp;
  }

  const bodyPath = path.join(UPLOAD_DIR, payload.body_filename);
  const tattooPath = path.join(UPLOAD_DIR, payload.tattoo_filename);
  if (!fs.existsSync(bodyPath)) return sendError(res, 400, 'Body file not found: ' + payload.body_filename);
  if (!fs.existsSync(tattooPath)) return sendError(res, 400, 'Tattoo file not found: ' + payload.tattoo_filename);

  if (!AI_API_KEY)
    return sendError(res, 500, 'AI_PROVIDER_API_KEY is not configured');

  try {
    log('run-workflow: calling AI to render tattoo' + (compositePath ? ' (with composite reference)' : '') + '...');

    const rotation = payload.rotation || 0;

    let prompt, parts;

    if (compositePath) {
      // Composite reference mode: the AI sees exactly where the tattoo sits.
      // The composite was exported at full opacity so placement is unambiguous.
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
        imageToBase64Part(bodyPath),
        imageToBase64Part(tattooPath),
        imageToBase64Part(compositePath),
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
        imageToBase64Part(bodyPath),
        imageToBase64Part(tattooPath),
      ];
    }

    const result = await callAI(parts);

    const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const outName = nextFilename(UPLOAD_DIR, 'result', ext);
    fs.writeFileSync(path.join(UPLOAD_DIR, outName), result.data);

    const elapsed = Date.now() - t0;
    log('run-workflow: done in', elapsed, 'ms ->', outName);
    sendJson(res, 200, {
      status: 'done',
      output_filename: outName,
      output_url: '/uploads/' + outName,
      elapsed_ms: elapsed,
      ai_model: AI_MODEL_NAME,
    });
  } catch (err) {
    log('run-workflow: error:', err.message);
    sendError(res, 500, err.message, { step: 'render' });
  }
}

function handleClearUploads(req, res) {
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    let deletedCount = 0;
    for (const file of files) {
      if (isAllowedUploadFilename(file)) {
        const filePath = path.join(UPLOAD_DIR, file);
        if (fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
    }
    log('Cleared uploads directory. Deleted ' + deletedCount + ' files.');
    sendJson(res, 200, { status: 'ok', message: 'Uploads cleared' });
  } catch (err) {
    log('Error clearing uploads:', err.message);
    sendError(res, 500, err.message);
  }
}

function handleUploads(req, res, urlPath) {
  const fname = urlPath.replace(/^\/uploads\//, '');
  // Strict allowlist: only serve files we generated/uploaded, never arbitrary project files
  if (!isAllowedUploadFilename(fname)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  const full = path.join(UPLOAD_DIR, fname);
  if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(full).toLowerCase();
  const wantsDownload = (new URL(req.url, 'http://x').searchParams.get('download')) === '1';
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (wantsDownload) {
    headers['Content-Disposition'] = 'attachment; filename="' + fname.replace(/[\r\n"\\]/g, '_') + '"';
  }
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://' + req.headers.host);
  const urlPath = urlObj.pathname;

  try {
    if (req.method === 'GET' && urlPath === '/healthz') {
      return sendJson(res, 200, { ok: true, ai_model: AI_MODEL_NAME });
    }
    if (req.method === 'GET' && urlPath === '/api/status') {
      return handleStatus(res);
    }
    if (req.method === 'POST' && urlPath === '/api/upload/body') {
      return handleUpload(req, res, 'body');
    }
    if (req.method === 'POST' && urlPath === '/api/upload/tattoo') {
      return handleUpload(req, res, 'tattoo');
    }
    if (req.method === 'POST' && urlPath === '/api/upload/steal-source') {
      return handleUpload(req, res, 'steal-source');
    }
    if (req.method === 'POST' && urlPath === '/api/upload/composite') {
      return handleUpload(req, res, 'composite');
    }
    if (req.method === 'POST' && urlPath === '/api/steal-tattoo') {
      return handleStealTattoo(req, res);
    }
    if (req.method === 'POST' && urlPath === '/api/run-workflow') {
      return handleRunWorkflow(req, res);
    }
    if (req.method === 'POST' && urlPath === '/api/clear-uploads') {
      return handleClearUploads(req, res);
    }
    if (req.method === 'GET' && urlPath.indexOf('/uploads/') === 0) {
      return handleUploads(req, res, urlPath);
    }
    if (req.method === 'GET') {
      return serveStatic(req, res, urlPath);
    }
    res.writeHead(405); return res.end('Method not allowed');
  } catch (err) {
    log('unhandled error:', err);
    sendError(res, 500, err.message || 'Internal error');
  }
});

server.listen(PORT, HOST, function() {
  log('InkFrame widget  -> http://' + HOST + ':' + PORT);
  log('AI model         -> ' + AI_MODEL_NAME);
  log('AI API base      -> ' + AI_API_BASE_URL);
  log('API key          -> ' + (AI_API_KEY ? '*** (set)' : '(NOT SET — add AI_PROVIDER_API_KEY to .env)'));
});
