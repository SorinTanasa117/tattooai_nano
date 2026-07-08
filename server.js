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
 *   AI_MODEL_NAME     - model to use (defaults to the current Gemini image model)
 *   RENDER_TIMEOUT_MS - max wait for AI render, ms (default 30000)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const ROOT = __dirname;

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
const HOST = process.env.HOST || '127.0.0.1';
const AI_API_BASE_URL = (process.env.AI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const AI_API_KEY = process.env.AI_PROVIDER_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const RAW_AI_MODEL_NAME = process.env.AI_MODEL_NAME || '';
const DEFAULT_AI_MODEL_NAME = ['gemini', '3.1', 'flash', 'image'].join('-');
const LEGACY_PREVIEW_MODEL_NAME = ['gemini', '2.5', 'flash', 'preview', '05', '20'].join('-');
const LEGACY_IMAGE_MODEL_NAME = ['gemini', '2.5', 'flash', 'image'].join('-');
const AI_MODEL_NAME = (!RAW_AI_MODEL_NAME || RAW_AI_MODEL_NAME === LEGACY_PREVIEW_MODEL_NAME)
  ? DEFAULT_AI_MODEL_NAME
  : RAW_AI_MODEL_NAME;
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '30000', 10);

// --- Cloudflare R2 storage -------------------------------------------------
// All session working files (uploads, stolen tattoos, rendered results) live
// in R2, not on local disk, so the same storage backs both this dev server
// and the Netlify functions deployment (see netlify/functions/_lib.js).
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is not configured');
  return value;
}

function getR2Config() {
  return {
    accountId: requireEnv('R2_ACCOUNT_ID'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucketName: requireEnv('R2_BUCKET_NAME'),
  };
}

let r2Client;
function getR2Client(config) {
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: 'https://' + config.accountId + '.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }
  return r2Client;
}

async function streamToBuffer(body) {
  if (!body) return null;
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let uploadsStore;
function getUploadsStore() {
  if (uploadsStore) return uploadsStore;
  const config = getR2Config();
  const client = getR2Client(config);
  const Bucket = config.bucketName;

  uploadsStore = {
    async get(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return await streamToBuffer(result.Body);
      } catch (err) {
        if (err && (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404))) {
          return null;
        }
        throw err;
      }
    },
    async set(key, data, contentType) {
      await client.send(new PutObjectCommand({
        Bucket, Key: key, Body: data,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: 'no-store',
      }));
    },
    async list(prefix) {
      const keys = [];
      let ContinuationToken;
      do {
        const result = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }));
        for (const item of result.Contents || []) {
          if (item.Key) keys.push(item.Key);
        }
        ContinuationToken = result.NextContinuationToken;
      } while (ContinuationToken);
      return keys;
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
  return uploadsStore;
}

// Public URL for a stored file. If R2_PUBLIC_URL is set, images are served
// directly from Cloudflare's CDN; otherwise fall back to the /uploads/
// proxy route below, which streams the object out of R2 on demand.
function getPublicUrl(filename) {
  const base = process.env.R2_PUBLIC_URL;
  if (base) return base.replace(/\/$/, '') + '/' + filename;
  return '/uploads/' + filename;
}

// Finds the next unused "<prefix>_N.<ext>" name by listing existing objects.
async function nextR2Filename(prefix, ext) {
  const keys = await getUploadsStore().list(prefix + '_');
  let max = 0;
  const re = new RegExp('^' + prefix + '_(\\d+)\\.');
  for (const key of keys) {
    const m = re.exec(key);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return prefix + '_' + (max + 1) + ext;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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

// Reads the multipart body and returns the raw "file" field's bytes --
// storage (R2) happens in the caller, not here.
function parseMultipart(req, contentType) {
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
          resolve({ originalName: origName, data: part.body });
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

function toInteractionInput(parts) {
  return parts.map((part) => {
    if (part.text) return { type: 'text', text: part.text };
    if (part.inlineData) {
      return { type: 'image', mime_type: part.inlineData.mimeType, data: part.inlineData.data };
    }
    if (part.inline_data) {
      return { type: 'image', mime_type: part.inline_data.mime_type, data: part.inline_data.data };
    }
    return part;
  });
}

function extractAIResult(parsed) {
  if (parsed.output_image && parsed.output_image.data) {
    return {
      data: Buffer.from(parsed.output_image.data, 'base64'),
      mimeType: parsed.output_image.mime_type || 'image/png',
    };
  }
  if (parsed.outputImage && parsed.outputImage.data) {
    return {
      data: Buffer.from(parsed.outputImage.data, 'base64'),
      mimeType: parsed.outputImage.mimeType || 'image/png',
    };
  }

  for (const step of parsed.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'image' && block.data) {
        return {
          data: Buffer.from(block.data, 'base64'),
          mimeType: block.mime_type || 'image/png',
        };
      }
    }
  }

  for (const candidate of parsed.candidates || []) {
    const responseParts = (candidate.content && candidate.content.parts) || [];
    for (const part of responseParts) {
      if (part.inlineData && part.inlineData.data) {
        return {
          data: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType || 'image/png',
        };
      }
      if (part.inline_data && part.inline_data.data) {
        return {
          data: Buffer.from(part.inline_data.data, 'base64'),
          mimeType: part.inline_data.mime_type || 'image/png',
        };
      }
    }
  }

  return null;
}

function extractAIText(parsed) {
  let textResponse = '';
  if (parsed.output_text) textResponse += parsed.output_text;
  if (parsed.outputText) textResponse += parsed.outputText;
  for (const step of parsed.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'text' && block.text) textResponse += block.text;
    }
  }
  for (const candidate of parsed.candidates || []) {
    const responseParts = (candidate.content && candidate.content.parts) || [];
    for (const part of responseParts) {
      if (part.text) textResponse += part.text;
    }
  }
  return textResponse;
}

function parseAIError(rawText) {
  let detail = rawText.slice(0, 400);
  let reason = '';
  try {
    const parsed = JSON.parse(rawText);
    if (parsed.error && parsed.error.message) detail = parsed.error.message;
    const details = parsed.error && parsed.error.details;
    if (Array.isArray(details)) {
      const info = details.find((item) => item && item.reason);
      if (info) reason = info.reason;
    }
  } catch (_) { }
  return { detail, reason };
}

function isRetryableGeminiAuthError(status, detail, reason) {
  if (status !== 401 && status !== 403) return false;
  return /oauth|authentication|api key|credential|unauthenticated/i.test(detail + ' ' + reason);
}

async function postJSON(url, body, headers, timeoutMs) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error('AI API request failed: ' + e.message);
  }

  const rawText = await resp.text().catch(() => '');
  return { resp, rawText };
}

/**
 * Call the AI image generation API.
 * Sends an array of parts (text + inline_data) and returns { data: Buffer, mimeType: string }.
 */
async function callAI(parts) {
  if (!AI_API_KEY) throw new Error('AI_PROVIDER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY is not set in environment');

  const interactionUrl = `${AI_API_BASE_URL}/interactions`;
  const interactionBody = {
    model: AI_MODEL_NAME,
    input: toInteractionInput(parts),
  };

  const first = await postJSON(interactionUrl, interactionBody, { 'x-goog-api-key': AI_API_KEY }, RENDER_TIMEOUT_MS);
  if (first.resp.ok) {
    try {
      const parsed = JSON.parse(first.rawText);
      const result = extractAIResult(parsed);
      if (result) return result;
      const textResponse = extractAIText(parsed);
      throw new Error('AI API returned no image. ' + (textResponse ? 'Response: ' + textResponse.slice(0, 300) : 'Empty response.'));
    } catch (err) {
      if (/^AI API returned/.test(err.message)) throw err;
      throw new Error('AI API returned non-JSON response: ' + first.rawText.slice(0, 200));
    }
  }

  const firstError = parseAIError(first.rawText);
  if (!isRetryableGeminiAuthError(first.resp.status, firstError.detail, firstError.reason)) {
    throw new Error('AI API error (HTTP ' + first.resp.status + '): ' + firstError.detail);
  }

  const fallbackUrl = `${AI_API_BASE_URL}/models/${LEGACY_IMAGE_MODEL_NAME}:generateContent?key=${encodeURIComponent(AI_API_KEY)}`;
  const fallbackBody = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  };

  const fallback = await postJSON(fallbackUrl, fallbackBody, null, RENDER_TIMEOUT_MS);
  if (!fallback.resp.ok) {
    const fallbackError = parseAIError(fallback.rawText);
    throw new Error(
      'AI API authentication failed for both Gemini image endpoints. ' +
      'Create a fresh Gemini API key in Google AI Studio, or restrict the existing key to the Generative Language API. ' +
      'Interactions HTTP ' + first.resp.status + ': ' + firstError.detail + ' ' +
      'Fallback HTTP ' + fallback.resp.status + ': ' + fallbackError.detail
    );
  }

  let parsed;
  try { parsed = JSON.parse(fallback.rawText); } catch (_) {
    throw new Error('AI API returned non-JSON response: ' + fallback.rawText.slice(0, 200));
  }

  const result = extractAIResult(parsed);
  if (result) return result;
  const textResponse = extractAIText(parsed);
  throw new Error('AI API returned no image. ' + (textResponse ? 'Response: ' + textResponse.slice(0, 300) : 'Empty response.'));
}

function imageToBase64Part(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const mimeType = mimeMap[ext] || 'image/png';
  return { inlineData: { mimeType, data: buffer.toString('base64') } };
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
    const parsed = await parseMultipart(req, ct);
    const ext = (path.extname(parsed.originalName) || '.png').toLowerCase();
    const finalName = await nextR2Filename(prefix, ext);
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    await getUploadsStore().set(finalName, parsed.data, mimeMap[ext] || 'application/octet-stream');
    log('upload ' + kind + ':', finalName, '(' + parsed.data.length + ' bytes)');
    sendJson(res, 200, {
      status: 'ok',
      kind: kind,
      filename: finalName,
      originalName: parsed.originalName,
      size: parsed.data.length,
      url: getPublicUrl(finalName),
    });
  } catch (err) {
    log('upload ' + kind + ' error:', err.message);
    sendError(res, 400, err.message);
  }
}

async function handleStatus(res) {
  const keys = await getUploadsStore().list();
  const bodies = keys.filter((f) => /^body_\d+\./i.test(f)).sort();
  const tattoos = keys.filter((f) => /^tattoo_\d+\./i.test(f)).sort();
  sendJson(res, 200, {
    status: 'ok',
    bodies: bodies.map((f) => ({ filename: f, url: getPublicUrl(f) })),
    tattoos: tattoos.map((f) => ({ filename: f, url: getPublicUrl(f) })),
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

  const sourceData = await getUploadsStore().get(source_filename);
  if (!sourceData)
    return sendError(res, 400, 'Source file not found: ' + source_filename);

  if (!AI_API_KEY)
    return sendError(res, 500, 'AI_PROVIDER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY is not configured');

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
      imageToBase64Part(sourceData, source_filename),
    ];

    const result = await callAI(parts);

    const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const outName = await nextR2Filename('stolen', ext);
    await getUploadsStore().set(outName, result.data, result.mimeType);

    const elapsed = Date.now() - t0;
    log('steal-tattoo: done in', elapsed, 'ms ->', outName);
    sendJson(res, 200, {
      status: 'done',
      output_filename: outName,
      output_url: getPublicUrl(outName),
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

  const store = getUploadsStore();

  // Composite reference is optional
  let compositeData = null;
  if (payload.composite_filename) {
    if (!isAllowedUploadFilename(payload.composite_filename) || !/^composite_/i.test(payload.composite_filename))
      return sendError(res, 400, 'Invalid composite_filename: must be a composite upload (composite_N.ext)');
    compositeData = await store.get(payload.composite_filename);
  }

  const bodyData = await store.get(payload.body_filename);
  const tattooData = await store.get(payload.tattoo_filename);
  if (!bodyData) return sendError(res, 400, 'Body file not found: ' + payload.body_filename);
  if (!tattooData) return sendError(res, 400, 'Tattoo file not found: ' + payload.tattoo_filename);

  if (!AI_API_KEY)
    return sendError(res, 500, 'AI_PROVIDER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY is not configured');

  try {
    log('run-workflow: calling AI to render tattoo' + (compositeData ? ' (with composite reference)' : '') + '...');

    const rotation = payload.rotation || 0;

    let prompt, parts;

    if (compositeData) {
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
        '- Add the appropriate tattoo feel to the original tattoo image such as skin sheen, slight ink absorption, and subtle color saturation changes around the tattoo edges.',
        '- Do NOT add borders, frames, watermarks, or backgrounds.',
        '- Do NOT add any redness, inflammation, swelling, or irritation around the tattoo edges — the skin colour directly adjacent to the tattoo must match the surrounding skin tone exactly, as if the tattoo is fully healed.',
        '- Return ONLY the final full body photo with the tattoo naturally embedded.',
      ].join('\n');

      parts = [
        { text: prompt },
        imageToBase64Part(bodyData, payload.body_filename),
        imageToBase64Part(tattooData, payload.tattoo_filename),
        imageToBase64Part(compositeData, payload.composite_filename),
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
        imageToBase64Part(bodyData, payload.body_filename),
        imageToBase64Part(tattooData, payload.tattoo_filename),
      ];
    }

    const result = await callAI(parts);

    const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const outName = await nextR2Filename('result', ext);
    await store.set(outName, result.data, result.mimeType);

    const elapsed = Date.now() - t0;
    log('run-workflow: done in', elapsed, 'ms ->', outName);
    sendJson(res, 200, {
      status: 'done',
      output_filename: outName,
      output_url: getPublicUrl(outName),
      elapsed_ms: elapsed,
      ai_model: AI_MODEL_NAME,
    });
  } catch (err) {
    log('run-workflow: error:', err.message);
    sendError(res, 500, err.message, { step: 'render' });
  }
}

async function handleClearUploads(req, res) {
  try {
    const store = getUploadsStore();
    const keys = await store.list();
    let deletedCount = 0;
    for (const key of keys) {
      if (isAllowedUploadFilename(key)) {
        await store.delete(key);
        deletedCount++;
      }
    }
    log('Cleared uploads. Deleted ' + deletedCount + ' files.');
    sendJson(res, 200, { status: 'ok', message: 'Uploads cleared' });
  } catch (err) {
    log('Error clearing uploads:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleUploads(req, res, urlPath) {
  const fname = decodeURIComponent(urlPath.replace(/^\/uploads\//, ''));
  // Strict allowlist: only serve files we generated/uploaded, never arbitrary project files
  if (!isAllowedUploadFilename(fname)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  let data;
  try {
    data = await getUploadsStore().get(fname);
  } catch (err) {
    log('Error fetching upload from R2:', err.message);
    res.writeHead(500); return res.end('Storage error');
  }
  if (!data) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(fname).toLowerCase();
  const wantsDownload = (new URL(req.url, 'http://x').searchParams.get('download')) === '1';
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (wantsDownload) {
    headers['Content-Disposition'] = 'attachment; filename="' + fname.replace(/[\r\n"\\]/g, '_') + '"';
  }
  res.writeHead(200, headers);
  res.end(data);
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

server.listen(PORT, HOST, function () {
  log('InkFrame widget  -> http://' + HOST + ':' + PORT);
  log('AI model         -> ' + AI_MODEL_NAME);
  log('AI API base      -> ' + AI_API_BASE_URL);
  log('API key          -> ' + (AI_API_KEY ? '*** (set)' : '(NOT SET — add AI_PROVIDER_API_KEY to .env)'));
});
