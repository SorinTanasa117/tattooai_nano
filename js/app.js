/**
 * InkFrame main UI controller.
 * Wires uploads, canvas, sliders, and the AI render pipeline.
 */

import { PlacementCanvas } from './canvas.js';
import { buildPayload, validatePayload } from './payload.js';

// IndexedDB History Database helper functions
const DB_NAME = 'InkFrameHistoryDB';
const STORE_NAME = 'tattoos';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function addTattooToHistory(blob, filename) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const item = {
      blob: blob,
      filename: filename,
      timestamp: Date.now()
    };
    const request = store.add(item);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function getTattooHistory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function deleteTattooFromHistory(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

async function clearTattooHistory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

const state = {
  bodyFile: null,
  bodyUrl: null,
  bodyNaturalDims: null,
  tattooFile: null,
  tattooUrl: null,
  tattooOriginalFile: null,   // the raw File the user picked (pre-opacity)
  tattooUploadedOpacity: 1,   // opacity that was baked into the last tattooFile upload
  opacity: 1,                 // current slider opacity (0..1)
  renderStatus: 'idle',
  slidersBaseEnabled: false,  // whether placement sliders are unlocked by app state (tattoo placed, etc.)
  fineTuneActive: false,      // mobile-only: whether the user has switched on the finetune toggle
  historyItems: [],
  currentResultId: null,
  activeResultObjectUrl: null,
};

const mobileMediaQuery = window.matchMedia('(max-width: 767px)');
function isMobileView() { return mobileMediaQuery.matches; }

/**
 * Pre-multiply a File's alpha channel by `opacity` (0..1) and return a new
 * PNG File. This bakes the opacity value into the tattoo image before upload
 * so the AI render receives the correct transparency level.
 */
async function applyOpacityToFile(file, opacity) {
  if (opacity >= 0.999) return file; // no-op at full opacity
  const imgUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Failed to load image for opacity'));
      i.src = imgUrl;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, c.width, c.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      // RGB stays the same; only alpha is multiplied by the slider value.
      data[i + 3] = Math.round(data[i + 3] * opacity);
    }
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      c.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
    });
    // Preserve original filename + extension.
    const name = file.name.replace(/\.(jpe?g|png|webp)$/i, '') + '.png';
    return new File([blob], name, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(imgUrl);
  }
}


function $(id) { return document.getElementById(id); }

const els = {
  canvas: null,
  bodyInput: $('bodyInput'),
  tattooInput: $('tattooInput'),
  stealInput: $('stealInput'),
  stealCameraInput: $('stealCameraInput'),
  stealBtn: $('stealBtn'),
  stealCameraBtn: $('stealCameraBtn'),
  bodyCameraBtn: $('bodyCameraBtn'),
  bodyCameraInput: $('bodyCameraInput'),
  stealHint: $('stealHint'),
  stealProgress: $('stealProgress'),
  stealProgressText: $('stealProgressText'),
  bodyHint: $('bodyHint'),
  tattooHint: $('tattooHint'),
  fitBtn: $('fitBtn'),
  xSlider: $('xSlider'),
  ySlider: $('ySlider'),
  widthSlider: $('widthSlider'),
  heightSlider: $('heightSlider'),
  heightOut: $('heightOut'),
  opacitySlider: $('opacitySlider'),
  opacityOut: $('opacityOut'),
  rotationSlider: $('rotationSlider'),
  rotationOut: $('rotationOut'),
  finetuneToggle: $('finetuneToggle'),
  finetuneToggleStatus: $('finetuneToggleStatus'),
  xOut: $('xOut'),
  yOut: $('yOut'),
  widthOut: $('widthOut'),
  renderBtn: $('renderBtn'),
  renderProgress: $('renderProgress'),
  progressText: $('progressText'),
  renderError: $('renderError'),
  resultPanel: $('resultPanel'),
  resultImage: $('resultImage'),
  downloadBtn: $('downloadBtn'),
  rerenderBtn: $('rerenderBtn'),
  resultMeta: $('resultMeta'),
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  statusDot: $('statusDot'),
  canvasOverlay: $('canvasOverlay'),
  canvasHost: $('canvasHost'),
  canvasResult: $('canvasResult'),
  canvasResultImage: $('canvasResultImage'),
  canvasResultBack: $('canvasResultBack'),
  canvasResultPrev: $('canvasResultPrev'),
  canvasResultNext: $('canvasResultNext'),
  toast: $('toast'),
  bulkDownloadBtn: $('bulkDownloadBtn'),
  clearHistoryBtn: $('clearHistoryBtn'),
  historyGrid: $('historyGrid'),
  historyEmpty: $('historyEmpty'),
  historyGridContainer: $('historyGridContainer'),
  historyPrev: $('historyPrev'),
  historyNext: $('historyNext'),
  useTemplateBtn: $('useTemplateBtn'),
  templateModal: $('templateModal'),
  templateModalBackdrop: $('templateModalBackdrop'),
  templateModalClose: $('templateModalClose'),
  templateReel: $('templateReel'),
};

function setStatus(label, kind) {
  if (!kind) kind = 'idle';
  els.statusText.textContent = label;
  els.statusPill.dataset.state = kind;
}

function showToast(msg, kind, duration) {
  if (!kind) kind = 'ok';
  if (!duration) duration = 2400;
  els.toast.textContent = msg;
  els.toast.className = 'toast ' + kind;
  els.toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { els.toast.hidden = true; }, duration);
}

function setProgress(label) { els.progressText.textContent = label; }

function clearError() {
  els.renderError.hidden = true;
  els.renderError.textContent = '';
}

function showError(msg, detail) {
  els.renderError.hidden = false;
  // Clear previous content
  while (els.renderError.firstChild) els.renderError.removeChild(els.renderError.firstChild);

  // Top-line: the human-readable message
  const head = document.createElement('div');
  head.className = 'render-error-head';
  head.textContent = msg;
  els.renderError.appendChild(head);

  // If the server gave us structured detail, render it as a collapsible block
  if (detail) {
    const details = document.createElement('details');
    details.className = 'render-error-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Show raw server response';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.className = 'render-error-raw';
    pre.textContent = JSON.stringify(detail, null, 2);
    details.appendChild(pre);
    els.renderError.appendChild(details);
  }
}

function applySliderInteractivity() {
  // On mobile, the finetune toggle gates the placement sliders (off by
  // default) to avoid accidental drags while scrolling. Desktop always
  // follows the base enabled state — no toggle involved.
  const active = state.slidersBaseEnabled && (!isMobileView() || state.fineTuneActive);
  [els.xSlider, els.ySlider, els.widthSlider, els.heightSlider, els.opacitySlider].forEach((s) => {
    if (!s) return;
    s.disabled = !active;
    document.querySelectorAll('[data-target="' + s.id + '"]').forEach((b) => { b.disabled = !active; });
  });
  if (els.rotationSlider) {
    els.rotationSlider.disabled = !active;
    document.querySelectorAll('[data-target="' + els.rotationSlider.id + '"]').forEach((b) => { b.disabled = !active; });
  }
}

function setFinetuneToggleUI(checked) {
  state.fineTuneActive = checked;
  if (els.finetuneToggle) els.finetuneToggle.checked = checked;
  if (els.finetuneToggleStatus) els.finetuneToggleStatus.textContent = checked ? 'ON' : 'OFF';
}

function setSlidersEnabled(enabled) {
  state.slidersBaseEnabled = enabled;
  if (!enabled) {
    // Reset the mobile finetune toggle so it doesn't appear "on" while the
    // sliders are locked out by app state (e.g. no tattoo placed yet).
    setFinetuneToggleUI(false);
  }
  applySliderInteractivity();
  els.fitBtn.disabled = !enabled;
}

function setRenderEnabled(enabled) { els.renderBtn.disabled = !enabled; }

async function uploadFile(file, kind) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const resp = await fetch('/api/upload/' + kind, { method: 'POST', body: fd });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: 'Upload failed' }));
    throw new Error(err.message || 'Upload failed');
  }
  return resp.json();
}

async function onBodySelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  els.bodyHint.textContent = 'uploading…';
  try {
    const result = await uploadFile(file, 'body');
    state.bodyFile = result.filename;
    state.bodyUrl = result.url;
    els.bodyHint.textContent = result.filename;
    els.bodyHint.classList.add('has-file');
    showToast('Body uploaded', 'ok');

    const dims = await els.canvas.loadBody(state.bodyUrl);
    state.bodyNaturalDims = { width: dims.width, height: dims.height };
    els.canvasOverlay.hidden = true;
    updateReadiness();
  } catch (err) {
    els.bodyHint.textContent = 'failed';
    showToast('Body upload failed: ' + err.message, 'error', 4000);
  }
}

async function onTattooSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  els.tattooHint.textContent = 'preparing…';
  try {
    // Upload the tattoo at full opacity on initial selection.  Opacity is
    // baked in again (with the current slider value) immediately before each
    // render, so the initial upload always uses opacity=1 to preserve the
    // original file fidelity.
    const fileToUpload = await applyOpacityToFile(file, 1);
    els.tattooHint.textContent = 'uploading…';
    const result = await uploadFile(fileToUpload, 'tattoo');
    state.tattooFile = result.filename;
    state.tattooUrl = result.url;
    state.tattooOriginalFile = file;    // keep original for re-baking at render
    state.tattooUploadedOpacity = 1;   // full-opacity version is now on the server
    els.tattooHint.textContent = result.filename;
    els.tattooHint.classList.add('has-file');
    showToast('Tattoo uploaded', 'ok');

    if (!state.bodyNaturalDims) {
      throw new Error('Upload a body photo first');
    }
    const placementState = await els.canvas.loadTattoo(state.tattooUrl, state.bodyNaturalDims);
    applyStateToUI(placementState);
    setSlidersEnabled(true);
    updateReadiness();
  } catch (err) {
    els.tattooHint.textContent = 'failed';
    showToast('Tattoo upload failed: ' + err.message, 'error', 4000);
  }
}

function setStealProgress(text) {
  if (els.stealProgressText) els.stealProgressText.textContent = text;
}

// ---------------------------------------------------------------------
// Template tattoo picker. Templates live as static image files in the
// /templates folder at the site root, listed in /templates/manifest.json
// (an array of filenames -- see scripts/generate-templates-manifest.js).
// Picking one runs it through the exact same "become the active tattoo"
// pipeline as a manual upload: bake in full opacity, upload as a tattoo
// asset, then load it onto the canvas.
// ---------------------------------------------------------------------
let templatesManifestCache = null;

async function loadTemplatesManifest() {
  if (templatesManifestCache) return templatesManifestCache;
  const resp = await fetch('/templates/manifest.json');
  if (!resp.ok) {
    throw new Error('Could not load template list (templates/manifest.json missing or unreachable)');
  }
  const data = await resp.json();
  templatesManifestCache = Array.isArray(data) ? data : (data.templates || []);
  return templatesManifestCache;
}

function openTemplateModal() {
  if (!els.templateModal) return;
  els.templateModal.hidden = false;
  document.body.style.overflow = 'hidden';
  renderTemplateReel();
}

function closeTemplateModal() {
  if (!els.templateModal) return;
  els.templateModal.hidden = true;
  document.body.style.overflow = '';
}

async function renderTemplateReel() {
  if (!els.templateReel) return;
  els.templateReel.innerHTML = '<div class="template-reel-loading">Loading templates…</div>';
  try {
    const files = await loadTemplatesManifest();
    if (!files.length) {
      els.templateReel.innerHTML = '<div class="template-reel-empty">No templates available yet.</div>';
      return;
    }
    els.templateReel.innerHTML = '';
    files.forEach((filename) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'template-item';
      item.setAttribute('aria-label', 'Use template tattoo: ' + filename);
      const img = document.createElement('img');
      img.src = '/templates/' + filename;
      img.alt = filename;
      img.loading = 'lazy';
      item.appendChild(img);
      item.addEventListener('click', () => onTemplateChosen(filename));
      els.templateReel.appendChild(item);
    });
  } catch (err) {
    els.templateReel.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'template-reel-empty';
    msg.textContent = err.message;
    els.templateReel.appendChild(msg);
  }
}

async function onTemplateChosen(filename) {
  closeTemplateModal();

  if (!state.bodyNaturalDims) {
    showToast('Upload a body photo first', 'error', 3000);
    return;
  }

  els.tattooHint.textContent = 'loading template…';
  setStatus('Loading template…', 'rendering');

  try {
    const imgResp = await fetch('/templates/' + filename);
    if (!imgResp.ok) throw new Error('Failed to load template image');
    const blob = await imgResp.blob();
    const file = new File([blob], filename, { type: blob.type || 'image/png' });

    // Same pipeline as a manual design upload: bake in full opacity,
    // upload as a 'tattoo' asset, then place it on the canvas.
    const fileToUpload = await applyOpacityToFile(file, 1);
    els.tattooHint.textContent = 'uploading…';
    const result = await uploadFile(fileToUpload, 'tattoo');
    state.tattooFile = result.filename;
    state.tattooUrl = result.url;
    state.tattooOriginalFile = file;
    state.tattooUploadedOpacity = 1;
    els.tattooHint.textContent = result.filename;
    els.tattooHint.classList.add('has-file');
    showToast('Template tattoo loaded', 'ok');

    const placementState = await els.canvas.loadTattoo(state.tattooUrl, state.bodyNaturalDims);
    applyStateToUI(placementState);
    setSlidersEnabled(true);
    updateReadiness();
    setStatus('Ready', 'ready');
  } catch (err) {
    els.tattooHint.textContent = 'failed';
    showToast('Template load failed: ' + err.message, 'error', 4000);
    setStatus('Error', 'error');
  }
}

async function onStealClicked() {
  // Trigger file picker; processing starts in onStealSourceSelected
  if (els.stealInput) { els.stealInput.value = ''; els.stealInput.click(); }
}

async function onStealSourceSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  els.stealBtn.disabled = true;
  els.stealProgress.hidden = false;
  els.stealHint.textContent = 'uploading…';
  setStealProgress('Uploading source photo…');
  setStatus('Stealing tattoo…', 'rendering');

  try {
    // 1. Upload the source photo to our server
    const uploadResult = await uploadFile(file, 'steal-source');

    // 2. Run the steal pipeline on the server (AI → stolen image)
    setStealProgress('AI is extracting tattoo…');
    els.stealHint.textContent = 'generating…';
    const stealResp = await fetch('/api/steal-tattoo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_filename: uploadResult.filename }),
    });
    const stealData = await stealResp.json();

    if (!stealResp.ok || stealData.status !== 'done') {
      throw new Error(stealData.message || ('Steal pipeline failed (' + stealResp.status + ')'));
    }

    // 3. Fetch the generated tattoo image as a blob and register it as a
    //    tattoo upload so the rest of the placement flow works unchanged.
    setStealProgress('Loading stolen tattoo…');
    const imgResp = await fetch(stealData.output_url);
    if (!imgResp.ok) throw new Error('Failed to fetch stolen tattoo image');
    const blob = await imgResp.blob();
    const stolenFile = new File([blob], 'stolen_tattoo.png', { type: 'image/png' });

    const tattooResult = await uploadFile(stolenFile, 'tattoo');
    state.tattooFile = tattooResult.filename;
    state.tattooUrl = tattooResult.url;
    state.tattooOriginalFile = stolenFile;
    state.tattooUploadedOpacity = 1;

    els.stealHint.textContent = tattooResult.filename;
    els.tattooHint.textContent = tattooResult.filename;
    els.tattooHint.classList.add('has-file');
    showToast('Tattoo stolen! (' + (stealData.elapsed_ms / 1000).toFixed(1) + 's)', 'ok');

    // 4. Load onto canvas exactly like a normal tattoo — user can then place,
    //    resize, rotate, and render as usual.
    if (!state.bodyNaturalDims) throw new Error('Upload a body photo first');
    const placementState = await els.canvas.loadTattoo(state.tattooUrl, state.bodyNaturalDims);
    applyStateToUI(placementState);
    setSlidersEnabled(true);
    updateReadiness();
    setStatus('Ready', 'ready');
  } catch (err) {
    els.stealHint.textContent = 'failed';
    showToast('Steal failed: ' + err.message, 'error', 6000);
    setStatus('Error', 'error');
  } finally {
    els.stealBtn.disabled = false;
    els.stealProgress.hidden = true;
  }
}

function applyStateToUI(s) {
  if (!s || !s.ready) return;
  els.xSlider.value = s.x;
  els.xSlider.max = Math.max(2000, els.canvas.stage.width());
  els.ySlider.value = s.y;
  els.ySlider.max = Math.max(2000, els.canvas.stage.height());
  els.widthSlider.value = s.width;
  els.widthOut.textContent = s.width + ' px';
  if (els.heightSlider) {
    els.heightSlider.value = s.height;
    if (els.heightOut) els.heightOut.textContent = s.height + ' px';
  }
  els.xOut.textContent = s.x;
  els.yOut.textContent = s.y;
  // Sync rotation slider + opacity slider from canvas state.
  if (els.rotationSlider) {
    els.rotationSlider.value = Math.round(s.rotation || 0);
    if (els.rotationOut) els.rotationOut.textContent = els.rotationSlider.value + '°';
  }
  if (els.opacitySlider) {
    els.opacitySlider.value = Math.round((s.opacity != null ? s.opacity : 1) * 100);
    if (els.opacityOut) els.opacityOut.textContent = els.opacitySlider.value + '%';
  }
}

function onCanvasChange(s) { applyStateToUI(s); }

function bindSlider(slider, output, prop, formatter) {
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    if (output && formatter) output.textContent = formatter(v);
    if (!els.canvas || !els.canvas.tattooImage) return;

    if (prop === 'x') {
      els.canvas.tattooImage.x(v);
    } else if (prop === 'y') {
      els.canvas.tattooImage.y(v);
    } else if (prop === 'width') {
      const img = els.canvas.tattooImage.image();
      if (img) {
        els.canvas.tattooImage.scaleX(v / img.naturalWidth);
      }
    } else if (prop === 'height') {
      const img = els.canvas.tattooImage.image();
      if (img) {
        els.canvas.tattooImage.scaleY(v / img.naturalHeight);
      }
    } else if (prop === 'rotation') {
      els.canvas.setRotation(v);
      return;
    } else if (prop === 'opacity') {
      els.canvas.setOpacity(v / 100);
      state.opacity = v / 100;
      return;
    }
    els.canvas.updateHandles();
    els.canvas.fgLayer.batchDraw();
    onCanvasChange(els.canvas.getState());
  });
}

function updateReadiness() {
  const ready = state.bodyFile && state.tattooFile && state.renderStatus !== 'rendering';
  setRenderEnabled(ready);
  if (ready) setStatus('Ready', 'ready');
}

async function onRender() {
  if (state.renderStatus === 'rendering') return;
  clearError();
  els.renderProgress.hidden = false;
  setProgress('Preparing render…');
  setStatus('Rendering…', 'rendering');
  state.renderStatus = 'rendering';
  setRenderEnabled(false);

  let payload;
  try {
    if (!state.tattooFile) throw new Error('Upload a tattoo design first');

    setProgress('Preparing placement…');

    // Always send the full-opacity tattoo design to the AI.
    // Opacity is used for the placement overlay on screen; the AI receives
    // the placement reference as a separate composite image (see below) and
    // must render the tattoo as real ink at full opacity regardless of the
    // slider value. If the current server-side file has baked-in opacity,
    // re-upload the original at full opacity so the AI gets a clean design.
    const currentOpacity = state.opacity;
    if (
      state.tattooOriginalFile &&
      state.tattooUploadedOpacity < 0.999
    ) {
      setProgress('Preparing full-opacity tattoo for AI…');
      const fullOpacityFile = await applyOpacityToFile(state.tattooOriginalFile, 1.0);
      const reResult = await uploadFile(fullOpacityFile, 'tattoo');
      state.tattooFile = reResult.filename;
      state.tattooUrl = reResult.url;
      state.tattooUploadedOpacity = 1.0;
    }

    // Scale factor: display pixels → 1024-max space
    const F = 1024 / Math.max(els.canvas.bodyImage.width(), els.canvas.bodyImage.height());

    const tattooImg = els.canvas.tattooImage;
    const rect = tattooImg.getClientRect();
    const cs   = els.canvas.getState();

    const canvasState = {
      ready:    true,
      x:        Math.round(rect.x * F),
      y:        Math.round(rect.y * F),
      width:    Math.round(cs.width * F),
      height:   Math.round(cs.height * F),
      rotation: cs.rotation,
      opacity:  cs.opacity,
    };

    // Export the canvas as a composite reference image (body + tattoo at full
    // opacity) so the AI can see the exact placement rather than relying
    // solely on pixel coordinates.
    let compositeFilename = null;
    try {
      setProgress('Exporting placement reference…');
      const compositeBlob = await els.canvas.getCompositeImage();
      if (compositeBlob) {
        const compositeFile = new File([compositeBlob], 'composite.jpg', { type: 'image/jpeg' });
        const compositeResult = await uploadFile(compositeFile, 'composite');
        compositeFilename = compositeResult.filename;
      }
    } catch (e) {
      // Non-fatal: proceed without composite reference
      console.warn('Composite export failed:', e);
    }

    payload = buildPayload({
      bodyFile:        state.bodyFile,
      tattooFile:      state.tattooFile,
      compositeFile:   compositeFilename,
      state:           canvasState,
    });
    validatePayload(payload);
  } catch (e) {
    return finishRenderWithError(e.message);
  }

  let tickerInterval = setInterval(() => {
    const t = els.progressText.textContent;
    if (t.endsWith('…')) {
      const dots = (t.match(/\./g) || []).length;
      els.progressText.textContent = t.replace(/\.+/, '.'.repeat((dots % 3) + 1));
    }
  }, 600);

  try {
    setProgress('AI is generating…');
    const resp = await fetch('/api/run-workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    clearInterval(tickerInterval);

    if (!resp.ok || data.status !== 'done') {
      const err = new Error(data.message || ('Server returned ' + resp.status));
      err.detail = { status: resp.status, message: data.message, step: data.step };
      throw err;
    }

    state.renderStatus = 'done';
    state.lastResult = data;
    state.currentResultId = null;
    showResult(data);

    // Save to local IndexedDB history
    try {
      const imgResp = await fetch(data.output_url);
      if (imgResp.ok) {
        const imgBlob = await imgResp.blob();
        const historyId = await addTattooToHistory(imgBlob, data.output_filename);
        await updateHistoryUI();
        state.currentResultId = historyId;
        syncResultNavigation();
      }
    } catch (dbErr) {
      console.warn('Failed to save render to history:', dbErr);
    }

    setStatus('Done in ' + (data.elapsed_ms / 1000).toFixed(1) + 's', 'done');
    showToast('Render complete', 'ok');
  } catch (err) {
    clearInterval(tickerInterval);
    finishRenderWithError(err.message, err.detail);
  } finally {
    els.renderProgress.hidden = true;
    updateReadiness();
  }
}

function finishRenderWithError(message, detail) {
  state.renderStatus = 'error';
  showError(message, detail);
  setStatus('Error', 'error');
  const shortMsg = (message || '').split('\n')[0] || 'Render failed';
  showToast(shortMsg, 'error', 5000);
  els.renderProgress.hidden = true;
  updateReadiness();
  if (els.renderError) {
    els.renderError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function showResult(data, options) {
  options = options || {};
  const isBlob = data.output_url.startsWith('blob:');
  const cacheBust = isBlob ? '' : ((data.output_url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now());
  const finalUrl = data.output_url + cacheBust;
  els.resultImage.src = finalUrl;
  state.currentResultId = options.historyId || state.currentResultId || null;

  els.downloadBtn.href = isBlob ? data.output_url : (data.output_url + (data.output_url.indexOf('?') >= 0 ? '&' : '?') + 'download=1');
  els.downloadBtn.setAttribute('download', data.output_filename);

  els.resultMeta.textContent = data.output_filename + (data.elapsed_ms ? ' · ' + (data.elapsed_ms / 1000).toFixed(1) + 's' : '');
  els.resultPanel.hidden = false;
  showRenderInCanvas(data.output_url);
  syncResultNavigation();
}

function showRenderInCanvas(outputUrl) {
  const isBlob = outputUrl.startsWith('blob:');
  const cacheBust = isBlob ? '' : ((outputUrl.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now());
  els.canvasResultImage.src = outputUrl + cacheBust;
  els.canvasResultImage.alt = 'Rendered tattoo';
  els.canvasResult.hidden = false;
  els.canvasHost.style.visibility = 'hidden';
  els.canvasOverlay.hidden = true;
}

function hideRenderInCanvas() {
  els.canvasResult.hidden = true;
  els.canvasResultImage.removeAttribute('src');
  els.canvasHost.style.visibility = '';
  els.canvasOverlay.hidden = !!(state.bodyFile && state.tattooFile);
}

function getCurrentHistoryIndex() {
  if (state.currentResultId == null) return -1;
  return state.historyItems.findIndex(item => item.id === state.currentResultId);
}

function syncResultNavigation() {
  if (!els.canvasResultPrev || !els.canvasResultNext) return;

  const index = getCurrentHistoryIndex();
  const hasOlder = index >= 0 && index < state.historyItems.length - 1;
  const hasNewer = index > 0;

  els.canvasResultPrev.hidden = !hasOlder;
  els.canvasResultNext.hidden = !hasNewer;
  els.canvasResultPrev.disabled = !hasOlder;
  els.canvasResultNext.disabled = !hasNewer;
}

function showHistoryResultAt(index) {
  const item = state.historyItems[index];
  if (!item) return;

  if (state.activeResultObjectUrl) {
    URL.revokeObjectURL(state.activeResultObjectUrl);
    state.activeResultObjectUrl = null;
  }

  const imgUrl = URL.createObjectURL(item.blob);
  state.activeResultObjectUrl = imgUrl;
  showResult({
    output_url: imgUrl,
    output_filename: item.filename,
    elapsed_ms: 0
  }, { historyId: item.id });
  showToast('Viewing render: ' + item.filename, 'ok');
}

function showAdjacentHistoryResult(direction) {
  const index = getCurrentHistoryIndex();
  if (index < 0) return;
  showHistoryResultAt(index + direction);
}

function bindResultSwipe(target) {
  if (!target) return;

  let startX = 0;
  let startY = 0;
  let tracking = false;

  target.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (getCurrentHistoryIndex() < 0) return;
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
  });

  target.addEventListener('pointerup', (e) => {
    if (!tracking) return;
    tracking = false;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (absX < 44 || absX < absY * 1.25) return;
    showAdjacentHistoryResult(dx < 0 ? 1 : -1);
  });

  target.addEventListener('pointercancel', () => {
    tracking = false;
  });
}

async function updateHistoryUI() {
  const history = await getTattooHistory();
  
  // Clear the grid except the empty state (we'll toggle its visibility)
  const items = els.historyGrid.querySelectorAll('.history-item');
  items.forEach(item => item.remove());
  
  if (history.length === 0) {
    state.historyItems = [];
    state.currentResultId = null;
    syncResultNavigation();
    els.historyEmpty.hidden = false;
    els.bulkDownloadBtn.disabled = true;
    els.clearHistoryBtn.disabled = true;
    return;
  }
  
  els.historyEmpty.hidden = true;
  els.bulkDownloadBtn.disabled = false;
  els.clearHistoryBtn.disabled = false;
  
  // Render history items sorted by timestamp descending
  history.sort((a, b) => b.timestamp - a.timestamp);
  state.historyItems = history;
  if (state.currentResultId != null && getCurrentHistoryIndex() === -1) {
    state.currentResultId = null;
  }
  syncResultNavigation();
  
  history.forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = 'history-item';
    itemEl.title = item.filename + ' - click to view';
    
    const imgUrl = URL.createObjectURL(item.blob);
    const img = document.createElement('img');
    img.src = imgUrl;
    img.alt = item.filename;
    itemEl.appendChild(img);
    
    // Actions overlay
    const actions = document.createElement('div');
    actions.className = 'history-item-actions';
    
    // Download button
    const dlBtn = document.createElement('button');
    dlBtn.className = 'history-btn';
    dlBtn.innerHTML = '↓';
    dlBtn.title = 'Download';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = imgUrl;
      a.download = item.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
    actions.appendChild(dlBtn);
    
    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'history-btn history-btn-delete';
    delBtn.innerHTML = '×';
    delBtn.title = 'Delete from history';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(imgUrl);
      await deleteTattooFromHistory(item.id);
      updateHistoryUI();
      showToast('Deleted from history', 'ok');
    });
    actions.appendChild(delBtn);
    
    itemEl.appendChild(actions);
    
    // Preview on click
    itemEl.addEventListener('click', () => {
      showHistoryResultAt(state.historyItems.findIndex(historyItem => historyItem.id === item.id));
    });
    
    els.historyGrid.appendChild(itemEl);
  });
}

async function onBulkDownload() {
  const history = await getTattooHistory();
  if (history.length === 0) return;
  
  els.bulkDownloadBtn.disabled = true;
  const originalLabel = els.bulkDownloadBtn.innerHTML;
  els.bulkDownloadBtn.innerHTML = '<span>Creating zip...</span>';
  
  try {
    const zip = new JSZip();
    history.forEach(item => {
      zip.file(item.filename, item.blob);
    });
    
    const content = await zip.generateAsync({ type: 'blob' });
    const zipUrl = URL.createObjectURL(content);
    
    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = 'rendered_tattoos_history.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    URL.revokeObjectURL(zipUrl);
    showToast('Bulk download completed', 'ok');
  } catch (err) {
    console.error('Bulk download failed:', err);
    showToast('Bulk download failed: ' + err.message, 'error');
  } finally {
    els.bulkDownloadBtn.disabled = false;
    els.bulkDownloadBtn.innerHTML = originalLabel;
  }
}

async function onClearHistory() {
  if (confirm('Are you sure you want to clear all past rendered tattoos from history?')) {
    await clearTattooHistory();
    updateHistoryUI();
    showToast('History cleared', 'ok');
  }
}

function init() {
  els.canvas = new PlacementCanvas('canvasHost');
  els.canvas.onChange(onCanvasChange);

  els.bodyInput.addEventListener('change', onBodySelected);
  els.tattooInput.addEventListener('change', onTattooSelected);
  if (els.stealBtn) els.stealBtn.addEventListener('click', onStealClicked);
  if (els.stealInput) els.stealInput.addEventListener('change', onStealSourceSelected);

  // Camera capture buttons (mobile only — hidden via CSS on desktop)
  if (els.bodyCameraBtn) els.bodyCameraBtn.addEventListener('click', () => {
    els.bodyCameraInput.value = ''; els.bodyCameraInput.click();
  });
  if (els.bodyCameraInput) els.bodyCameraInput.addEventListener('change', onBodySelected);

  if (els.stealCameraBtn) els.stealCameraBtn.addEventListener('click', () => {
    els.stealCameraInput.value = ''; els.stealCameraInput.click();
  });
  if (els.stealCameraInput) els.stealCameraInput.addEventListener('change', onStealSourceSelected);

  // Template tattoo picker
  if (els.useTemplateBtn) els.useTemplateBtn.addEventListener('click', openTemplateModal);
  if (els.templateModalClose) els.templateModalClose.addEventListener('click', closeTemplateModal);
  if (els.templateModalBackdrop) els.templateModalBackdrop.addEventListener('click', closeTemplateModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.templateModal && !els.templateModal.hidden) closeTemplateModal();
  });

  // Mobile-only finetune toggle: off by default, gates the placement sliders.
  if (els.finetuneToggle) {
    setFinetuneToggleUI(false);
    els.finetuneToggle.addEventListener('change', () => {
      setFinetuneToggleUI(els.finetuneToggle.checked);
      applySliderInteractivity();
    });
  }
  mobileMediaQuery.addEventListener('change', applySliderInteractivity);

  bindSlider(els.xSlider,        els.xOut,        'x',        (v) => v);
  bindSlider(els.ySlider,        els.yOut,        'y',        (v) => v);
  bindSlider(els.widthSlider,    els.widthOut,    'width',    (v) => v + ' px');
  if (els.heightSlider && els.heightOut) {
    bindSlider(els.heightSlider, els.heightOut, 'height', (v) => v + ' px');
  }
  if (els.rotationSlider && els.rotationOut) {
    bindSlider(els.rotationSlider, els.rotationOut, 'rotation', (v) => Math.round(v) + '°');
  }
  if (els.opacitySlider && els.opacityOut) {
    bindSlider(els.opacitySlider, els.opacityOut, 'opacity', (v) => Math.round(v) + '%');
    state.opacity = 0.5;
  }

  // Step buttons (decrement / increment by slider.step). Long-press auto-repeats at ~3 units/sec.
  document.querySelectorAll('.slider-step').forEach((btn) => {
    let interval = null;
    let pressHandled = false;

    const step = () => {
      const targetId = btn.getAttribute('data-target');
      const dir = parseInt(btn.getAttribute('data-dir'), 10);
      const slider = document.getElementById(targetId);
      if (!slider || slider.disabled) return;
      const stepSize = parseFloat(slider.step || '1') || 1;
      const min = parseFloat(slider.min || '0');
      const max = parseFloat(slider.max || '100');
      const next = Math.max(min, Math.min(max, parseFloat(slider.value) + dir * stepSize));
      slider.value = String(next);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const stop = () => {
      if (interval !== null) { clearInterval(interval); interval = null; }
      setTimeout(() => { pressHandled = false; }, 100);
    };

    btn.addEventListener('pointerdown', (e) => {
      if (btn.disabled) return;
      e.preventDefault();
      pressHandled = true;
      step();
      interval = setInterval(step, 333);
    });
    btn.addEventListener('click', () => {
      if (pressHandled) return;
      step();
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  });

  els.fitBtn.addEventListener('click', () => {
    if (els.canvas && els.canvas.tattooImage) els.canvas.reset();
  });

  els.renderBtn.addEventListener('click', onRender);
  els.rerenderBtn.addEventListener('click', () => {
    hideRenderInCanvas();
    els.resultPanel.hidden = true;
    onRender();
  });
  els.canvasResultBack.addEventListener('click', hideRenderInCanvas);
  if (els.canvasResultPrev) {
    els.canvasResultPrev.addEventListener('click', () => showAdjacentHistoryResult(1));
  }
  if (els.canvasResultNext) {
    els.canvasResultNext.addEventListener('click', () => showAdjacentHistoryResult(-1));
  }
  bindResultSwipe(els.resultImage);
  bindResultSwipe(els.canvasResultImage);

  // History action listeners
  if (els.bulkDownloadBtn) els.bulkDownloadBtn.addEventListener('click', onBulkDownload);
  if (els.clearHistoryBtn) els.clearHistoryBtn.addEventListener('click', onClearHistory);

  // Mobile carousel arrows
  const SCROLL_PX = 158; // item width (140) + gap (10) + a little extra
  if (els.historyPrev) {
    els.historyPrev.addEventListener('click', () => {
      els.historyGridContainer.scrollBy({ left: -SCROLL_PX, behavior: 'smooth' });
    });
  }
  if (els.historyNext) {
    els.historyNext.addEventListener('click', () => {
      els.historyGridContainer.scrollBy({ left: SCROLL_PX, behavior: 'smooth' });
    });
  }

  // Load past history items
  updateHistoryUI();

  // Prevent beforeunload from triggering when clicking download links
  let isDownloading = false;
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('a[download], button[download], .history-btn');
    if (target && (target.hasAttribute('download') || target.title === 'Download' || target.id === 'bulkDownloadBtn')) {
      isDownloading = true;
      setTimeout(() => { isDownloading = false; }, 2000);
    }
  });

  // Clear uploads on page refresh/leave
  window.addEventListener('beforeunload', () => {
    if (!isDownloading) {
      navigator.sendBeacon('/api/clear-uploads');
    }
  });


  // Check AI readiness on load
  fetch('/api/status').then((r) => r.json()).then((s) => {
    if (!s.ai_ready) {
      setStatus('No API key', 'error');
      showToast('AI_PROVIDER_API_KEY not set — add it to .env', 'error', 6000);
    }
  }).catch(() => {});

  window.els = els;
  window.state = state;

  setStatus('Idle');
}

document.addEventListener('DOMContentLoaded', init);
