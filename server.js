#!/usr/bin/env node
/**
 * InkFrame dev server.
 * Zero npm dependencies. Serves the widget, handles uploads,
 * and proxies placement payloads into a ComfyUI workflow.
 *
 * Env vars:
 *   PORT          - widget port (default 5173)
 *   COMFYUI_URL   - ComfyUI base URL (default http://127.0.0.1:8188)
 *   WORKFLOW_FILE     - workflow template JSON (default merged-tattoo-rotator-v6.json)
 *   PATCH_SCRIPT      - path to patch_workflow.py (default scripts/patch_workflow.py)
 *   RENDER_TIMEOUT_MS - max wait for ComfyUI render, ms (default 10000000 = 10000s)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { guiToPrompt } = require('./scripts/gui_to_prompt.js');

const ROOT = __dirname;
// Netlify allows writing files ONLY inside the OS /tmp directory
const UPLOAD_DIR = process.env.NETLIFY ? '/tmp' : ROOT;
const PORT = parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || 'localhost';
const COMFYUI_URL = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || path.join(ROOT, 'merged-tattoo-rotator-v6.json');
const PATCH_SCRIPT = process.env.PATCH_SCRIPT || path.join(ROOT, 'scripts', 'patch_workflow.py');
// Default 10000s -- CPU systems can easily take 5-10 min for a Flux2 inpaint+IP-Adapter pass.
// Override with the RENDER_TIMEOUT_MS env var (value in milliseconds).
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '10000000', 10);

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
  // Promote well-known structured error fields to top-level keys so the
  // browser console / UI can show them without digging into a nested object.
  if (extra && extra.comfyuiNodeErrors) body.comfyui_node_errors = extra.comfyuiNodeErrors;
  if (extra && extra.comfyuiResponse)   body.comfyui_response     = extra.comfyuiResponse;
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
  // Use exclusive-create (wx) to atomically claim a filename, avoiding the
  // TOCTOU race between existsSync and writeFileSync under concurrent uploads.
  for (let i = 1; i < 10000; i++) {
    const name = `${prefix}_${i}${ext}`;
    const full = path.join(dir, name);
    try {
      const fd = fs.openSync(full, 'wx');
      fs.closeSync(fd);
      return name; // we created (and own) this file; caller overwrites it
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

async function uploadToComfyUI(filePath, originalName) {
  const fileBuf = fs.readFileSync(filePath);
  const blob = new Blob([fileBuf], { type: 'image/png' });
  const form = new FormData();
  form.append('image', blob, originalName);
  const resp = await fetch(COMFYUI_URL + '/upload/image', { method: 'POST', body: form });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('ComfyUI upload failed (' + resp.status + '): ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  if (!data.name) throw new Error('ComfyUI upload returned no name');
  return data.name;
}

async function queuePrompt(workflow) {
  // Detect GUI/API format (the shape of final.json) and convert to prompt
  // format before POSTing. The /prompt endpoint expects
  //   { "1": {class_type, inputs}, "2": {...}, ... }
  // not the GUI's { nodes: [...], links: [...] } shape. Sending GUI format
  // triggers AttributeErrors / TypeErrors in node_replace_manager and any
  // on_prompt_handler that expects a dict of {class_type, inputs}.
  let promptPayload = workflow;
  const isGuiFormat = workflow && Array.isArray(workflow.nodes);
  if (isGuiFormat) {
    try {
      promptPayload = guiToPrompt(workflow);
    } catch (e) {
      const err = new Error('Failed to convert workflow to prompt format: ' + e.message);
      err.comfyuiResponse = { conversion_error: e.message };
      throw err;
    }
  }

  // Always include the original GUI-format workflow in extra_data so ComfyUI
  // can resolve subgraph GUID class_types (from definitions.subgraphs) that
  // exist in workflows like steal_tattoo.json.  Harmless for plain workflows.
  const body = { prompt: promptPayload, client_id: 'inkframe-widget' };
  if (isGuiFormat) {
    body.extra_data = { extra_pnginfo: { workflow: workflow } };
  }

  const resp = await fetch(COMFYUI_URL + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Read body once, regardless of status code — ComfyUI returns structured
  // errors in JSON on both 400 (validation) and 500 (execution crash).
  const rawBody = await resp.text().catch(() => '');
  let parsed = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch (_) { /* not JSON */ }

  if (!resp.ok) {
    // Build the most informative error we can: status, top-level error,
    // per-node errors, and a slice of the raw text.
    const lines = [];
    lines.push('ComfyUI /prompt failed (HTTP ' + resp.status + ')');
    if (parsed && parsed.error) {
      lines.push('error: ' + (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)));
    }
    if (parsed && parsed.node_errors && Object.keys(parsed.node_errors).length) {
      lines.push('node_errors:');
      for (const nodeId of Object.keys(parsed.node_errors)) {
        const ne = parsed.node_errors[nodeId];
        const msg = (ne && (ne.message || ne.error || JSON.stringify(ne))) || 'unknown';
        const type = (ne && ne.class_type) ? ' (' + ne.class_type + ')' : '';
        lines.push('  node ' + nodeId + type + ': ' + String(msg).slice(0, 400));
      }
    }
    if (!parsed) {
      lines.push('raw body: ' + rawBody.slice(0, 800));
    }
    const err = new Error(lines.join('\n'));
    err.comfyuiStatus = resp.status;
    err.comfyuiResponse = parsed || { raw: rawBody.slice(0, 4000) };
    err.comfyuiNodeErrors = (parsed && parsed.node_errors) || null;
    throw err;
  }

  // 2xx but with a structured error embedded (ComfyUI does this for validation).
  if (parsed && (parsed.error || (parsed.node_errors && Object.keys(parsed.node_errors).length))) {
    const lines = ['ComfyUI rejected workflow'];
    if (parsed.error) lines.push('error: ' + (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)));
    if (parsed.node_errors) {
      for (const nodeId of Object.keys(parsed.node_errors)) {
        const ne = parsed.node_errors[nodeId];
        const msg = (ne && (ne.message || ne.error || JSON.stringify(ne))) || 'unknown';
        lines.push('  node ' + nodeId + ': ' + String(msg).slice(0, 400));
      }
    }
    const err = new Error(lines.join('\n'));
    err.comfyuiResponse = parsed;
    err.comfyuiNodeErrors = parsed.node_errors || null;
    throw err;
  }

  if (!parsed || !parsed.prompt_id) {
    throw new Error('ComfyUI did not return a prompt_id (raw: ' + rawBody.slice(0, 200) + ')');
  }
  return parsed.prompt_id;
}

async function pollForResult(promptId, timeoutMs) {
  const start = Date.now();
  let lastStatus = null;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    const resp = await fetch(COMFYUI_URL + '/history/' + promptId);
    if (!resp.ok) continue;
    const history = await resp.json();
    const entry = history[promptId];
    if (!entry) continue;
    const status = entry.status || {};
    lastStatus = status.status_str || status.state || 'unknown';
    if (status.completed === true) {
      const outputs = entry.outputs || {};
      for (const nodeId of Object.keys(outputs)) {
        const out = outputs[nodeId];
        if (out.images && out.images.length > 0) {
          return { image: out.images[0], promptId: promptId };
        }
      }
      throw new Error('ComfyUI finished but produced no image output');
    }
    if (status.status_str === 'error' || status.state === 'error') {
      throw new Error('ComfyUI execution error: ' + JSON.stringify(entry).slice(0, 300));
    }
  }
  throw new Error('ComfyUI render timed out after ' + Math.round(timeoutMs / 1000) + 's (last status: ' + lastStatus + ')');
}

function runPatchScript(payloadObj) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PATCH_SCRIPT)) return reject(new Error('Patch script not found: ' + PATCH_SCRIPT));
    if (!fs.existsSync(WORKFLOW_FILE)) return reject(new Error('Workflow file not found: ' + WORKFLOW_FILE + '. Drop merged-tattoo-rotator-v6.json into the project root or set WORKFLOW_FILE.'));
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(py, [PATCH_SCRIPT, '--workflow', WORKFLOW_FILE, '--print-summary'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', (c) => outChunks.push(c));
    proc.stderr.on('data', (c) => errChunks.push(c));
    proc.on('error', (e) => reject(new Error('Failed to spawn patch script (' + py + '): ' + e.message)));
    proc.on('close', (code) => {
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) return reject(new Error('Patch script exited ' + code + ': ' + stderr.slice(0, 400)));
      try {
        const stdout = Buffer.concat(outChunks).toString('utf8');
        const lines = stdout.split('\n');
        const jsonStart = lines.findIndex((l) => l.trim().startsWith('{'));
        const jsonText = jsonStart >= 0 ? lines.slice(jsonStart).join('\n') : stdout;
        const workflow = JSON.parse(jsonText);
        resolve(workflow);
      } catch (e) {
        reject(new Error('Failed to parse patched workflow: ' + e.message));
      }
    });
    proc.stdin.write(JSON.stringify(payloadObj));
    proc.stdin.end();
  });
}

async function handleUpload(req, res, kind) {
  const prefix = kind === 'body' ? 'body' : kind === 'steal-source' ? 'steal_src' : 'tattoo';
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) {
    return sendError(res, 400, 'Expected multipart/form-data');
  }
  try {
try {
    const result = await parseMultipart(req, ct, UPLOAD_DIR, prefix); // <-- NEW
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
  const files = fs.readdirSync(ROOT);
  const bodies = files.filter((f) => /^body_\d+\./i.test(f)).sort();
  const tattoos = files.filter((f) => /^tattoo_\d+\./i.test(f)).sort();
  const hasWorkflow = fs.existsSync(WORKFLOW_FILE);
  sendJson(res, 200, {
    status: 'ok',
    bodies: bodies.map((f) => ({ filename: f, url: '/uploads/' + f })),
    tattoos: tattoos.map((f) => ({ filename: f, url: '/uploads/' + f })),
    workflow: hasWorkflow ? path.basename(WORKFLOW_FILE) : null,
    comfyuiUrl: COMFYUI_URL,
  });
}

const STEAL_WORKFLOW_FILE = path.join(ROOT, 'steal_tattoo.json');

async function handleStealTattoo(req, res) {
  const t0 = Date.now();
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendError(res, 400, 'Invalid JSON: ' + e.message);
  }

  const { source_filename } = body;
  // Restrict to files uploaded via /api/upload/steal-source only.
  // Pattern: steal_src_<N>.<ext> — prevents callers from pointing at
  // arbitrary project files (server.js, .env, tattoo_N.png, etc.).
  const isStealSourceFilename = (name) =>
    typeof name === 'string' &&
    /^steal_src_\d+\.(png|jpe?g|webp|gif)$/i.test(name);

  if (!isStealSourceFilename(source_filename))
    return sendError(res, 400, 'Invalid source_filename: must be a steal-source upload (steal_src_N.ext)');

  const sourcePath = path.join(ROOT, source_filename);
  if (!fs.existsSync(sourcePath))
    return sendError(res, 400, 'Source file not found: ' + source_filename);

  if (!fs.existsSync(STEAL_WORKFLOW_FILE))
    return sendError(res, 500, 'steal_tattoo.json not found in project root');

  try {
    const ping = await fetch(COMFYUI_URL + '/system_stats', { signal: AbortSignal.timeout(3000) });
    if (!ping.ok) throw new Error('status ' + ping.status);
  } catch (e) {
    return sendError(res, 502, 'ComfyUI is not reachable at ' + COMFYUI_URL + ' (' + e.message + ')');
  }

  try {
    log('steal-tattoo: uploading source image to ComfyUI...');
    const comfyName = await uploadToComfyUI(sourcePath, source_filename);
    log('steal-tattoo: uploaded as', comfyName);

    // Patch the GUI-format workflow: set node 24 (LoadImage) to the uploaded filename.
    const workflow = JSON.parse(fs.readFileSync(STEAL_WORKFLOW_FILE, 'utf8'));
    const loadNode = workflow.nodes.find((n) => n.id === 24);
    if (!loadNode) throw new Error('steal_tattoo.json: LoadImage node (id=24) not found');
    loadNode.widgets_values = [comfyName, 'image'];

    log('steal-tattoo: queuing prompt...');
    const promptId = await queuePrompt(workflow);
    log('steal-tattoo: prompt_id =', promptId);

    log('steal-tattoo: polling for result...');
    const result = await pollForResult(promptId, RENDER_TIMEOUT_MS);
    const image = result.image;
    const outputUrl = '/api/output?filename=' + encodeURIComponent(image.filename) +
      '&subfolder=' + encodeURIComponent(image.subfolder || '') +
      '&type=' + encodeURIComponent(image.type || 'output');

    const elapsed = Date.now() - t0;
    log('steal-tattoo: done in', elapsed, 'ms ->', image.filename);
    sendJson(res, 200, {
      status: 'done',
      prompt_id: promptId,
      output_filename: image.filename,
      output_subfolder: image.subfolder || '',
      output_type: image.type || 'output',
      output_url: outputUrl,
      elapsed_ms: elapsed,
    });
  } catch (err) {
    log('steal-tattoo: error:', err.message);
    if (err.stack) log(err.stack);
    const extra = { step: 'steal' };
    if (err.comfyuiStatus) extra.comfyuiStatus = err.comfyuiStatus;
    if (err.comfyuiNodeErrors) extra.comfyuiNodeErrors = err.comfyuiNodeErrors;
    if (err.comfyuiResponse) extra.comfyuiResponse = err.comfyuiResponse;
    sendError(res, 500, err.message, extra);
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

  // Validate filenames: must be a bare filename (no path separators or ..)
  // and must match the expected upload naming pattern to prevent path traversal.
  const isSafeFilename = (name) =>
    typeof name === 'string' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    /^[a-zA-Z0-9_.\-]+$/.test(name);
  if (!isSafeFilename(payload.body_filename))
    return sendError(res, 400, 'Invalid body_filename: must be a plain filename with no path components');
  if (!isSafeFilename(payload.tattoo_filename))
    return sendError(res, 400, 'Invalid tattoo_filename: must be a plain filename with no path components');

  const bodyPath = path.join(ROOT, payload.body_filename);
  const tattooPath = path.join(ROOT, payload.tattoo_filename);
  if (!fs.existsSync(bodyPath)) return sendError(res, 400, 'Body file not found: ' + payload.body_filename);
  if (!fs.existsSync(tattooPath)) return sendError(res, 400, 'Tattoo file not found: ' + payload.tattoo_filename);

  try {
    const ping = await fetch(COMFYUI_URL + '/system_stats', { signal: AbortSignal.timeout(3000) });
    if (!ping.ok) throw new Error('status ' + ping.status);
  } catch (e) {
    return sendError(res, 502, 'ComfyUI is not reachable at ' + COMFYUI_URL + ' (' + e.message + '). Is the server running?');
  }

  try {
    log('run-workflow: uploading files to ComfyUI...');
    const [bodyComfyName, tattooComfyName] = await Promise.all([
      uploadToComfyUI(bodyPath, payload.body_filename),
      uploadToComfyUI(tattooPath, payload.tattoo_filename),
    ]);
    log('run-workflow: uploaded as', bodyComfyName, '/', tattooComfyName);

    const patchedPayload = Object.assign({}, payload, { body_filename: bodyComfyName, tattoo_filename: tattooComfyName });

    log('run-workflow: patching workflow...');
    const workflow = await runPatchScript(patchedPayload);

    // Save a versioned snapshot of the fully-patched workflow (all sentinels
    // replaced with real values) so the user can inspect or replay it.
    // Named: <workflow-base>_1.json, _2.json, … (never overwrites the template).
    let snapshotName = null;
    try {
      const wfBase = path.basename(WORKFLOW_FILE, '.json'); // merged-tattoo-rotator-v6
      snapshotName = nextFilename(ROOT, wfBase, '.json');
      fs.writeFileSync(path.join(ROOT, snapshotName), JSON.stringify(workflow, null, 2));
      log('run-workflow: saved patched snapshot ->', snapshotName);
    } catch (snapErr) {
      log('run-workflow: warning – could not save snapshot:', snapErr.message);
      // Non-fatal: snapshot failure must never abort the render.
    }

    log('run-workflow: queuing prompt...');
    const promptId = await queuePrompt(workflow);
    log('run-workflow: prompt_id =', promptId);

    log('run-workflow: polling for result...');
    const result = await pollForResult(promptId, RENDER_TIMEOUT_MS);
    const image = result.image;
    const outputUrl = '/api/output?filename=' + encodeURIComponent(image.filename) +
      '&subfolder=' + encodeURIComponent(image.subfolder || '') +
      '&type=' + encodeURIComponent(image.type || 'output');
    const elapsed = Date.now() - t0;
    log('run-workflow: done in', elapsed, 'ms ->', image.filename);
    sendJson(res, 200, {
      status: 'done',
      prompt_id: promptId,
      output_filename: image.filename,
      output_subfolder: image.subfolder || '',
      output_type: image.type || 'output',
      output_url: outputUrl,
      elapsed_ms: elapsed,
      comfyui_url: COMFYUI_URL,
      snapshot_file: snapshotName,   // versioned patched-workflow copy, or null on save failure
    });
  } catch (err) {
    log('run-workflow: error:', err.message);
    if (err.stack) log(err.stack);
    const extra = { step: 'render' };
    if (err.comfyuiStatus) extra.comfyuiStatus = err.comfyuiStatus;
    if (err.comfyuiNodeErrors) extra.comfyuiNodeErrors = err.comfyuiNodeErrors;
    if (err.comfyuiResponse) extra.comfyuiResponse = err.comfyuiResponse;
    sendError(res, 500, err.message, extra);
  }
}

async function handleOutput(req, res, urlObj) {
  const filename = urlObj.searchParams.get('filename');
  const subfolder = urlObj.searchParams.get('subfolder') || '';
  const type = urlObj.searchParams.get('type') || 'output';
  if (!filename) return sendError(res, 400, 'filename required');
  const remote = COMFYUI_URL + '/view?filename=' + encodeURIComponent(filename) +
    '&subfolder=' + encodeURIComponent(subfolder) +
    '&type=' + encodeURIComponent(type);
  try {
    const resp = await fetch(remote);
    if (!resp.ok) return sendError(res, resp.status, 'ComfyUI /view returned ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get('content-type') || 'image/png';
    const wantsDownload = urlObj.searchParams.get('download') === '1';
    const headers = {
      'Content-Type': ct,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    };
    if (wantsDownload) {
      const safeName = filename.replace(/[\r\n"\\]/g, '_');
      headers['Content-Disposition'] = 'attachment; filename="' + safeName + '"';
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch (e) {
    sendError(res, 502, 'Failed to fetch from ComfyUI: ' + e.message);
  }
}

function handleUploads(req, res, urlPath) {
  const fname = urlPath.replace(/^\/uploads\//, '');
  if (!fname || fname.includes('..') || fname.includes('/')) {
    res.writeHead(400); return res.end('Bad path');
  }
  const full = path.join(ROOT, fname);
  if (!full.startsWith(ROOT) || !fs.existsSync(full)) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://' + req.headers.host);
  const urlPath = urlObj.pathname;

  try {
    if (req.method === 'GET' && urlPath === '/healthz') {
      return sendJson(res, 200, { ok: true, comfyui: COMFYUI_URL });
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
    if (req.method === 'POST' && urlPath === '/api/steal-tattoo') {
      return handleStealTattoo(req, res);
    }
    if (req.method === 'POST' && urlPath === '/api/run-workflow') {
      return handleRunWorkflow(req, res);
    }
    if (req.method === 'GET' && urlPath.indexOf('/api/output') === 0) {
      return handleOutput(req, res, urlObj);
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
  log('ComfyUI target   -> ' + COMFYUI_URL);
  log('Workflow template -> ' + WORKFLOW_FILE + (fs.existsSync(WORKFLOW_FILE) ? ' [found]' : ' [MISSING]'));
  log('Patch script     -> ' + PATCH_SCRIPT);
});
