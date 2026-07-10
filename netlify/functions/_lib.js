 'use strict';
/**
 * Shared helpers for InkFrame's Netlify Functions.
 *
 * Storage: Cloudflare R2 replaces the old UPLOAD_DIR-on-disk approach
 * from server.js. Objects persist reliably across separate function
 * invocations (unlike /tmp), which is required since an editing session
 * spans several requests (upload -> steal -> run-workflow), each of
 * which may hit a different, cold Lambda instance.
 *
 * Nothing here touches the client-side history gallery (IndexedDB in
 * app.js) -- that already survives refresh on its own. This store only
 * holds the transient working files for the *current* editing session,
 * which get wiped by clear-uploads.js on refresh/startup.
 */

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Allowlist of filename patterns that may be stored/served/read.
// Mirrors server.js's UPLOAD_PATTERNS exactly.
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
  if (name.startsWith('.') || name.includes('\\') || name.includes('..')) return false;
  // Multi-tenant keys look like "t_<hash>/body_3.png" -- exactly one
  // tenant-folder segment is allowed, and the final segment must match
  // one of our generated patterns.
  const segments = name.split('/');
  if (segments.length > 2) return false;
  if (segments.length === 2 && !/^t_[a-f0-9]{16}$/.test(segments[0])) return false;
  const base = segments[segments.length - 1];
  return UPLOAD_PATTERNS.some((re) => re.test(base));
}

// ---------------------------------------------------------------------
// Multi-tenant licensing. Each WordPress customer site sends its license
// key in the X-InkFrame-License header (attached server-side by the WP
// plugin's proxy -- browsers never see it). We map that key to a stable
// tenant folder so different customers' files never collide or leak
// into each other's storage or history listing.
//
// MVP license store: a comma-separated env var. Swap this for a real
// database/table (with per-tenant usage tracking for billing) once you
// have more than a handful of customers.
// ---------------------------------------------------------------------
const crypto = require('crypto');

function getValidLicenseKeys() {
  return (process.env.INKFRAME_LICENSE_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function tenantIdForLicense(licenseKey) {
  return 't_' + crypto.createHash('sha256').update(licenseKey).digest('hex').slice(0, 16);
}

// Call at the top of every handler. Returns { tenantId } on success or
// { errorResponse } if the request should be rejected.
function requireTenant(event) {
  const key = getHeader(event, 'x-inkframe-license');
  if (!key || !getValidLicenseKeys().includes(key)) {
    return { errorResponse: errorResponse(401, 'Invalid or missing license key') };
  }
  return { tenantId: tenantIdForLicense(key) };
}

let r2Client;

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

async function streamToArrayBuffer(body) {
  if (!body) return null;
  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function createR2UploadsStore(config) {
  const client = getR2Client(config);
  const Bucket = config.bucketName;

  return {
    async get(key, options) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        const arrayBuffer = await streamToArrayBuffer(result.Body);
        if (options && options.type === 'arrayBuffer') return arrayBuffer;
        return Buffer.from(arrayBuffer);
      } catch (err) {
        if (err && (err.name === 'NoSuchKey' || err.$metadata && err.$metadata.httpStatusCode === 404)) {
          return null;
        }
        throw err;
      }
    },

    async set(key, data) {
      const ext = extOf(key);
      await client.send(new PutObjectCommand({
        Bucket,
        Key: key,
        Body: data,
        ContentType: MIME[ext] || 'application/octet-stream',
        CacheControl: 'no-store',
      }));
    },

    async list(options) {
      const prefix = options && options.prefix ? options.prefix : undefined;
      const blobs = [];
      let ContinuationToken;

      do {
        const result = await client.send(new ListObjectsV2Command({
          Bucket,
          Prefix: prefix,
          ContinuationToken,
        }));

        for (const item of result.Contents || []) {
          if (item.Key) blobs.push({ key: item.Key });
        }
        ContinuationToken = result.NextContinuationToken;
      } while (ContinuationToken);

      return { blobs };
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

function getUploadsStore() {
  return createR2UploadsStore(getR2Config());
}

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

function errorResponse(statusCode, message, extra) {
  return jsonResponse(statusCode, Object.assign({ status: 'error', message }, extra || {}));
}

function extOf(name) {
  const m = /\.[a-z0-9]+$/i.exec(name || '');
  return m ? m[0].toLowerCase() : '.png';
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return '';
}

// Finds the next unused N for "<prefix>_N.<ext>" by listing existing objects
// under that prefix. Equivalent to server.js's nextFilename(), just backed
// by store.list() instead of fs.readdirSync().
async function nextFilename(store, prefix, ext, tenantId) {
  const listPrefix = tenantId ? tenantId + '/' + prefix + '_' : prefix + '_';
  const { blobs } = await store.list({ prefix: listPrefix });
  let max = 0;
  const re = new RegExp('(?:^|/)' + prefix + '_(\\d+)\\.');
  for (const b of blobs) {
    const m = re.exec(b.key);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  const name = prefix + '_' + (max + 1) + ext;
  return tenantId ? tenantId + '/' + name : name;
}

// Identical multipart body splitter to server.js's splitMultipart, just
// operating on a Buffer decoded from the Lambda event instead of a
// streamed request body.
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

// Extracts the "file" field from a multipart/form-data Lambda event.
function parseMultipartEvent(event) {
  const contentType = getHeader(event, 'content-type');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('No boundary in Content-Type');
  const boundary = '--' + (m[1] || m[2]);

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');

  const limit = 25 * 1024 * 1024;
  if (raw.length > limit) throw new Error('Upload too large');

  const parts = splitMultipart(raw, boundary);
  for (const part of parts) {
    const disp = part.headers['content-disposition'] || '';
    const nameMatch = /name="([^"]+)"/.exec(disp);
    if (!nameMatch || nameMatch[1] !== 'file') continue;
    const filenameMatch = /filename="([^"]*)"/.exec(disp);
    const origName = filenameMatch ? filenameMatch[1] : 'upload';
    return { originalName: origName, data: part.body };
  }
  throw new Error('No file field in multipart body');
}

function imageToBase64Part(buffer, filename) {
  const ext = extOf(filename);
  const mimeType = MIME[ext] || 'image/png';
  return { inlineData: { mimeType, data: buffer.toString('base64') } };
}

const DEFAULT_AI_MODEL_NAME = ['gemini', '3.1', 'flash', 'image'].join('-');
const LEGACY_PREVIEW_MODEL_NAME = ['gemini', '2.5', 'flash', 'preview', '05', '20'].join('-');
const LEGACY_IMAGE_MODEL_NAME = ['gemini', '2.5', 'flash', 'image'].join('-');

function getAIModelName() {
  const model = process.env.AI_MODEL_NAME || '';
  if (!model || model === LEGACY_PREVIEW_MODEL_NAME) return DEFAULT_AI_MODEL_NAME;
  return model;
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
    return { data: Buffer.from(parsed.output_image.data, 'base64'), mimeType: parsed.output_image.mime_type || 'image/png' };
  }
  if (parsed.outputImage && parsed.outputImage.data) {
    return { data: Buffer.from(parsed.outputImage.data, 'base64'), mimeType: parsed.outputImage.mimeType || 'image/png' };
  }

  for (const step of parsed.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'image' && block.data) {
        return { data: Buffer.from(block.data, 'base64'), mimeType: block.mime_type || 'image/png' };
      }
    }
  }

  const candidates = parsed.candidates || [];
  for (const candidate of candidates) {
    const responseParts = (candidate.content && candidate.content.parts) || [];
    for (const part of responseParts) {
      if (part.inlineData && part.inlineData.data) {
        return { data: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType || 'image/png' };
      }
      if (part.inline_data && part.inline_data.data) {
        return { data: Buffer.from(part.inline_data.data, 'base64'), mimeType: part.inline_data.mime_type || 'image/png' };
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
  } catch (_) {}
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
 * Call the Gemini image generation API.
 */
async function callAI(parts) {
  const AI_API_BASE_URL = (process.env.AI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const AI_API_KEY = process.env.AI_PROVIDER_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const AI_MODEL_NAME = getAIModelName();
  const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '25000', 10);

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
  try {
    parsed = JSON.parse(fallback.rawText);
  } catch (_) {
    throw new Error('AI API returned non-JSON response: ' + fallback.rawText.slice(0, 200));
  }

  const result = extractAIResult(parsed);
  if (result) return result;
  const textResponse = extractAIText(parsed);
  throw new Error('AI API returned no image. ' + (textResponse ? 'Response: ' + textResponse.slice(0, 300) : 'Empty response.'));
}


/**
 * Return a public-facing URL for a stored file.
 * If R2_PUBLIC_URL is set (e.g. "https://pub-xxx.r2.dev" or a custom
 * Cloudflare domain), images are served directly from Cloudflare's CDN —
 * fast, no Lambda proxy hop.  Falls back to the /uploads/ proxy route so
 * the app works in local dev (server.js) and on Netlify without a public
 * bucket.
 */
function getPublicUrl(filename) {
  const base = process.env.R2_PUBLIC_URL;
  if (base) return base.replace(/\/$/, '') + '/' + filename;
  return '/uploads/' + filename;
}

module.exports = {
  MIME,
  getPublicUrl,
  isAllowedUploadFilename,
  getUploadsStore,
  jsonResponse,
  errorResponse,
  extOf,
  getHeader,
  nextFilename,
  parseMultipartEvent,
  imageToBase64Part,
  getAIModelName,
  callAI,
  requireTenant,
  tenantIdForLicense,
};
