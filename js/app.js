/**
 * InkFrame main UI controller.
 * Wires uploads, canvas, sliders, and the ComfyUI render pipeline.
 */

import { PlacementCanvas } from './canvas.js';
import { buildPayload, validatePayload } from './payload.js';

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
};

/**
 * Pre-multiply a File's alpha channel by `opacity` (0..1) and return a new
 * PNG File. This is what makes the Opacity slider actually affect the
 * ComfyUI render -- we send a baked-in faded PNG instead of relying on
 * the (unchanged) workflow graph to interpret an opacity widget that
 * ImageCompositeMasked doesn't have.
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
  stealBtn: $('stealBtn'),
  stealHint: $('stealHint'),
  stealProgress: $('stealProgress'),
  stealProgressText: $('stealProgressText'),
  bodyHint: $('bodyHint'),
  tattooHint: $('tattooHint'),
  fitBtn: $('fitBtn'),
  centerBtn: $('centerBtn'),
  xSlider: $('xSlider'),
  ySlider: $('ySlider'),
  widthSlider: $('widthSlider'),
  heightSlider: $('heightSlider'),
  heightOut: $('heightOut'),
  opacitySlider: $('opacitySlider'),
  opacityOut: $('opacityOut'),
  rotationSlider: $('rotationSlider'),
  rotationOut: $('rotationOut'),
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
  toast: $('toast'),
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

  // If the server gave us structured detail, render it as a pre block
  if (detail) {
    const hasNodes = detail.comfyui_node_errors && Object.keys(detail.comfyui_node_errors).length;
    if (hasNodes) {
      const sub = document.createElement('div');
      sub.className = 'render-error-sub';
      sub.textContent = 'ComfyUI node errors:';
      els.renderError.appendChild(sub);

      const list = document.createElement('ul');
      list.className = 'render-error-nodes';
      for (const nodeId of Object.keys(detail.comfyui_node_errors)) {
        const ne = detail.comfyui_node_errors[nodeId] || {};
        const li = document.createElement('li');
        const cls = ne.class_type ? ' (' + ne.class_type + ')' : '';
        li.textContent = 'node ' + nodeId + cls + ': ' + (ne.message || ne.error || JSON.stringify(ne));
        list.appendChild(li);
      }
      els.renderError.appendChild(list);
    }

    // Always include a collapsible raw JSON dump for power users
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

function setSlidersEnabled(enabled) {
  [els.xSlider, els.ySlider, els.widthSlider, els.heightSlider, els.opacitySlider].forEach((s) => {
    if (!s) return;
    s.disabled = !enabled;
    document.querySelectorAll('[data-target="' + s.id + '"]').forEach((b) => { b.disabled = !enabled; });
  });
  if (els.rotationSlider) els.rotationSlider.disabled = !enabled;
  els.fitBtn.disabled = !enabled;
  els.centerBtn.disabled = !enabled;
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

    // 2. Run the steal pipeline on the server (ComfyUI → stolen image)
    setStealProgress('ComfyUI is generating…');
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
    // Read as float for sliders that aren't whole integers (rotation is fine
    // as int, but opacity is 0..100 -- we'll divide by 100 below).
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
        // Only adjust scaleX — the height slider controls scaleY independently.
        els.canvas.tattooImage.scaleX(v / img.naturalWidth);
      }
    } else if (prop === 'height') {
      const img = els.canvas.tattooImage.image();
      if (img) {
        // Only adjust scaleY — the width slider controls scaleX independently.
        els.canvas.tattooImage.scaleY(v / img.naturalHeight);
      }
    } else if (prop === 'rotation') {
      // Free rotation -- canvas.setRotation updates the Konva node AND
      // fires onChange, so we don't need to redraw or sync sliders here.
      els.canvas.setRotation(v);
      return;
    } else if (prop === 'opacity') {
      // Slider is 0..100; canvas wants 0..1. Same as rotation: setOpacity
      // already fires onChange, so we return early.
      els.canvas.setOpacity(v / 100);
      // Mirror into state so the on-upload alpha pre-multiply uses it.
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
  setProgress('Uploading to ComfyUI…');
  setStatus('Rendering…', 'rendering');
  state.renderStatus = 'rendering';
  setRenderEnabled(false);

  let payload;
  try {
    if (!state.tattooFile) throw new Error('Upload a tattoo design first');

    setProgress('Preparing placement…');

    // Re-bake opacity into the tattoo upload if the slider has changed since
    // the initial upload.  This ensures the ComfyUI render always reflects
    // the current opacity value rather than whatever was baked at upload time.
    const currentOpacity = state.opacity;
    if (
      state.tattooOriginalFile &&
      Math.abs(currentOpacity - state.tattooUploadedOpacity) > 0.005
    ) {
      setProgress('Re-uploading tattoo with new opacity…');
      const rebaked = await applyOpacityToFile(state.tattooOriginalFile, currentOpacity);
      const reResult = await uploadFile(rebaked, 'tattoo');
      state.tattooFile = reResult.filename;
      state.tattooUrl = reResult.url;
      state.tattooUploadedOpacity = currentOpacity;
    }

    // Scale factor: display pixels → ComfyUI 1024-max space
    const F = 1024 / Math.max(els.canvas.bodyImage.width(), els.canvas.bodyImage.height());

    const tattooImg = els.canvas.tattooImage;
    const rect = tattooImg.getClientRect();   // rotated bounding box in display px (for composite position)
    const cs   = els.canvas.getState();       // pre-rotation dimensions + rotation + opacity

    // Pipeline: LoadImage → ImageScale(width, height) → RotateImage(rotation) → ImageCompositeMasked(x, y)
    //
    // ImageScale runs BEFORE RotateImage, so it must receive the PRE-ROTATION
    // tattoo dimensions — i.e. the size the user set via the sliders
    // (naturalWidth * scaleX, naturalHeight * scaleY).  cs.width/cs.height from
    // getState() are exactly those values, in display pixels.
    //
    // After RotateImage the image is padded to its axis-aligned bounding box.
    // composite_x/y must point to the top-left of that bounding box, which
    // getClientRect() gives correctly in display pixels.
    const canvasState = {
      ready:    true,
      x:        Math.round(rect.x * F),        // top-left of rotated bounding box → composite_x
      y:        Math.round(rect.y * F),         // → composite_y
      width:    Math.round(cs.width * F),       // pre-rotation slider width → ImageScale width
      height:   Math.round(cs.height * F),      // pre-rotation slider height → ImageScale height
      rotation: cs.rotation,                    // passed to RotateImage node
      opacity:  cs.opacity,
    };

    payload = buildPayload({
      bodyFile:   state.bodyFile,
      tattooFile: state.tattooFile,
      state:      canvasState,
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
    setProgress('ComfyUI is generating…');
    const resp = await fetch('/api/run-workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    clearInterval(tickerInterval);

    if (!resp.ok || data.status !== 'done') {
      // data may carry comfyui_node_errors / comfyui_response from the server.
      // Roll them into a multi-line message + attach the structured detail
      // to the Error so finishRenderWithError can render it nicely.
      const lines = [data.message || ('Server returned ' + resp.status)];
      if (data.comfyui_node_errors && Object.keys(data.comfyui_node_errors).length) {
        lines.push('');
        lines.push('Per-node errors from ComfyUI:');
        for (const nodeId of Object.keys(data.comfyui_node_errors)) {
          const ne = data.comfyui_node_errors[nodeId] || {};
          const cls = ne.class_type ? ' (' + ne.class_type + ')' : '';
          const msg = ne.message || ne.error || JSON.stringify(ne);
          lines.push('  node ' + nodeId + cls + ': ' + msg);
        }
      }
      const err = new Error(lines.join('\n'));
      err.detail = {
        status: resp.status,
        message: data.message,
        step: data.step,
        comfyui_node_errors: data.comfyui_node_errors || null,
        comfyui_response: data.comfyui_response || null,
      };
      throw err;
    }

    state.renderStatus = 'done';
    state.lastResult = data;
    showResult(data);
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
  // Keep the toast short; the panel shows the full detail.
  const shortMsg = (message || '').split('\n')[0] || 'Render failed';
  showToast(shortMsg, 'error', 5000);
  els.renderProgress.hidden = true;
  updateReadiness();
}

function showResult(data) {
  const cacheBust = '&_t=' + Date.now();
  // Sidebar thumbnail + download link (existing behavior).
  els.resultImage.src = data.output_url + cacheBust;
  els.downloadBtn.href = data.output_url + (data.output_url.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
  els.downloadBtn.setAttribute('download', data.output_filename);
  els.resultMeta.textContent =
    'prompt ' + data.prompt_id.slice(0, 8) + ' · ' + data.output_filename +
    ' · ' + (data.elapsed_ms / 1000).toFixed(1) + 's';
  els.resultPanel.hidden = false;
  // Replace the body+tattoo overlay with the rendered image in the main
  // canvas area so the user sees the final result immediately without
  // scrolling to the sidebar.
  showRenderInCanvas(data.output_url);
}

function showRenderInCanvas(outputUrl) {
  const cacheBust = '&_t=' + Date.now();
  els.canvasResultImage.src = outputUrl + cacheBust;
  els.canvasResultImage.alt = 'Rendered tattoo';
  els.canvasResult.hidden = false;
  // Hide the Konva canvas + overlay so the rendered image is the only
  // thing visible in the canvas-pane.
  els.canvasHost.style.visibility = 'hidden';
  els.canvasOverlay.hidden = true;
}

function hideRenderInCanvas() {
  els.canvasResult.hidden = true;
  els.canvasResultImage.removeAttribute('src');
  els.canvasHost.style.visibility = '';
  // Re-show the overlay only if no uploads have happened yet. After
  // uploads the overlay stays hidden, so mirror that.
  els.canvasOverlay.hidden = !!(state.bodyFile && state.tattooFile);
}

function init() {
  els.canvas = new PlacementCanvas('canvasHost');
  els.canvas.onChange(onCanvasChange);

  els.bodyInput.addEventListener('change', onBodySelected);
  els.tattooInput.addEventListener('change', onTattooSelected);
  if (els.stealBtn) els.stealBtn.addEventListener('click', onStealClicked);
  if (els.stealInput) els.stealInput.addEventListener('change', onStealSourceSelected);

  // Sliders -- all wired through bindSlider(), which knows how to apply
  // each prop to the Konva canvas (see canvas.js).
  bindSlider(els.xSlider,        els.xOut,        'x',        (v) => v);
  bindSlider(els.ySlider,        els.yOut,        'y',        (v) => v);
  bindSlider(els.widthSlider,    els.widthOut,    'width',    (v) => v + ' px');
  if (els.heightSlider && els.heightOut) {
    bindSlider(els.heightSlider, els.heightOut, 'height', (v) => v + ' px');
  }
  // Free-rotation slider (0-359) for the new RotateImage node.
  if (els.rotationSlider && els.rotationOut) {
    bindSlider(els.rotationSlider, els.rotationOut, 'rotation', (v) => Math.round(v) + '°');
  }
  // Opacity slider (0-100%). Drives canvas.setOpacity() AND, when a render
  // is requested, the uploadFile step pre-multiplies the tattoo's alpha by
  // this value so ComfyUI composites it at the chosen strength.
  if (els.opacitySlider && els.opacityOut) {
    bindSlider(els.opacitySlider, els.opacityOut, 'opacity', (v) => Math.round(v) + '%');
    // Initialize opacity to 0.5 (50%) to match the HTML slider default.
    // The canvas will sync to this when a tattoo is loaded.
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
  els.centerBtn.addEventListener('click', () => els.canvas.center());

  els.renderBtn.addEventListener('click', onRender);
  els.rerenderBtn.addEventListener('click', () => {
    hideRenderInCanvas();
    els.resultPanel.hidden = true;
    onRender();
  });
  els.canvasResultBack.addEventListener('click', hideRenderInCanvas);

  fetch('/api/status').then((r) => r.json()).then((s) => {
    if (!s.workflow) {
      setStatus('No workflow file', 'error');
      showToast('merged-tattoo-rotator-v6.json not found in project root', 'error', 5000);
    }
  }).catch(() => {});

  window.els = els;
  window.state = state;

  setStatus('Idle');
}

document.addEventListener('DOMContentLoaded', init);