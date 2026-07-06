 'use strict';
/**
 * Shared helpers for InkFrame's Netlify Functions.
 *
 * Storage: Netlify Blobs (a single store named "uploads") replaces the
 * old UPLOAD_DIR-on-disk approach from server.js. Blobs persist reliably
 * across separate function invocations (unlike /tmp), which is required
 * since an editing session spans several requests (upload -> steal ->
 * run-workflow), each of which may hit a different, cold Lambda instance.
 *
 * Nothing here touches the client-side history gallery (IndexedDB in
 * app.js) -- that already survives refresh on its own. This store only
 * holds the transient working files for the *current* editing session,
 * which get wiped by clear-uploads.js on refresh/startup.
 */

const { getStore } = require('@netlify/blobs');

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
  if (name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return UPLOAD_PATTERNS.some((re) => re.test(name));
}

// getStore() auto-detects the site ID/token from the function's execution
// context when running on Netlify's infrastructure -- no manual config
// needed (this differs from using @netlify/blobs outside of a Netlify
// deploy, which would require passing siteID/token explicitly).
function getUploadsStore() {
  return getStore('uploads');
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

// Finds the next unused N for "<prefix>_N.<ext>" by listing existing blobs
// under that prefix. Equivalent to server.js's nextFilename(), just backed
// by store.list() instead of fs.readdirSync().
async function nextFilename(store, prefix, ext) {
  const { blobs } = await store.list({ prefix: prefix + '_' });
  let max = 0;
  const re = new RegExp('^' + prefix + '_(\\d+)\\.');
  for (const b of blobs) {
    const m = re.exec(b.key);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return prefix + '_' + (max + 1) + ext;
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

/**
 * Call the AI image generation API. Identical logic to server.js's callAI.
 */
async function callAI(parts) {
  const AI_API_BASE_URL = (process.env.AI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const AI_API_KEY = process.env.AI_PROVIDER_API_KEY || '';
  const AI_MODEL_NAME = process.env.AI_MODEL_NAME || 'gemini-2.5-flash-preview-05-20';
  const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '25000', 10);

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
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    throw new Error('AI API returned non-JSON response: ' + rawText.slice(0, 200));
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

  let textResponse = '';
  for (const candidate of candidates) {
    const responseParts = (candidate.content && candidate.content.parts) || [];
    for (const part of responseParts) {
      if (part.text) textResponse += part.text;
    }
  }
  throw new Error('AI API returned no image. ' + (textResponse ? 'Response: ' + textResponse.slice(0, 300) : 'Empty response.'));
}

module.exports = {
  MIME,
  isAllowedUploadFilename,
  getUploadsStore,
  jsonResponse,
  errorResponse,
  extOf,
  getHeader,
  nextFilename,
  parseMultipartEvent,
  imageToBase64Part,
  callAI,
};