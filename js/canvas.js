/**
 * Canvas module: wraps a Konva.Stage with two layers (body background +
 * draggable tattoo foreground), a 4-corner transformer, and a state-getter
 * for the current placement.
 *
 * Skew handles are placed on the edges (top, bottom, left, right) to allow
 * horizontal and vertical skewing.
 *
 * Rotation is FREE (any float in degrees).
 * Opacity (0..1) is reflected immediately on the foreground tattoo image.
 */

import { fitContours } from './geometry.js';

function rotateVector(x, y, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

/**
 * Convert a data URL to a Blob without using fetch().
 * fetch(dataURL) throws "The string did not match the expected pattern."
 * on iOS Safari because WebKit's fetch() rejects the data: scheme.
 */
function dataURLtoBlob(dataURL) {
  const comma = dataURL.indexOf(',');
  const meta  = dataURL.slice(0, comma);         // e.g. "data:image/jpeg;base64"
  const b64   = dataURL.slice(comma + 1);
  const mime  = (meta.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export class PlacementCanvas {
  constructor(hostId) {
    this.host = document.getElementById(hostId);
    this.stage = new Konva.Stage({
      container: hostId,
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    });
    this.bgLayer = new Konva.Layer({ listening: false });
    this.fgLayer = new Konva.Layer();
    this.stage.add(this.bgLayer);
    this.stage.add(this.fgLayer);

    this.bodyImage = null;
    this.tattooImage = null;
    this.transformer = null;
    this.bodyNaturalDims = null;
    this._changeCb = null;
    this._stageSize = { w: this.stage.width(), h: this.stage.height() };

    this.topHandle = null;
    this.bottomHandle = null;
    this.leftHandle = null;
    this.rightHandle = null;
    this.rotateHandle = null;
    this._rotStartAngle = 0;
    this._rotStartRotation = 0;

    window.addEventListener('resize', () => this._resize());
  }

  onChange(cb) { this._changeCb = cb; }

  _resize() {
    // Debounce: coalesce rapid resize bursts (e.g. iOS address-bar
    // show/hide fires many events within a few frames).
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this._applyResize(), 120);
  }

  _applyResize() {
    // If a body image is already loaded the stage size was set exactly in
    // loadBody() to match the fitted image.  Changing it here would move the
    // tattoo's apparent position relative to the body (Konva coordinates are
    // absolute — they don't scale when the stage resizes).  So once a body is
    // present, leave the stage completely alone; the canvas-pane clips or
    // centres it via CSS overflow.
    if (this.bodyImage) return;

    // No body yet — track the empty container so the initial fit is right.
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.stage.width(w);
    this.stage.height(h);
    this._stageSize = { w, h };
    this.stage.batchDraw();
  }

  loadBody(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const maxW = this.host.clientWidth;
        const maxH = this.host.clientHeight;
        const isMobile = window.matchMedia('(max-width: 767px)').matches;

        let scale;
        if (isMobile) {
          // On mobile: always fill the full screen width.
          // Height adapts naturally to the image's aspect ratio.
          scale = maxW / img.naturalWidth;
        } else {
          // On desktop: contain within the canvas pane.
          scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        }

        const dispW = Math.round(img.naturalWidth * scale);
        const dispH = Math.round(img.naturalHeight * scale);

        this.bodyNaturalDims = { width: img.naturalWidth, height: img.naturalHeight };

        this.bodyImage = new Konva.Image({
          image: img,
          x: 0, y: 0,
          width: dispW,
          height: dispH,
          listening: false,
        });
        this.bgLayer.destroyChildren();
        this.bgLayer.add(this.bodyImage);

        this.stage.width(dispW);
        this.stage.height(dispH);
        this._stageSize = { w: dispW, h: dispH };

        // On mobile: resize the canvas-pane element to match the image height
        // so there is no blank space above/below and scrolling is natural.
        if (isMobile) {
          this.host.parentElement.style.height = dispH + 'px';
          this.host.parentElement.style.minHeight = dispH + 'px';
        }

        this.bgLayer.batchDraw();
        resolve({ width: img.naturalWidth, height: img.naturalHeight, dispW: dispW, dispH: dispH });
      };
      img.onerror = () => reject(new Error('Failed to load body image'));
      img.src = url;
    });
  }

  loadTattoo(url, bodyDims) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const fit = fitContours(bodyDims);
        const displayScale = Math.min(
          this._stageSize.w / bodyDims.width,
          this._stageSize.h / bodyDims.height,
        );
        const targetDisplayW = fit.width * displayScale;
        const scale = targetDisplayW / img.naturalWidth;

        this.tattooImage = new Konva.Image({
          image: img,
          x: this._stageSize.w / 2,
          y: this._stageSize.h / 2,
          width: img.naturalWidth,
          height: img.naturalHeight,
          scaleX: scale,
          scaleY: scale,
          offsetX: img.naturalWidth / 2,
          offsetY: img.naturalHeight / 2,
          draggable: true,
          rotation: 0,
          skewX: 0,
          skewY: 0,
          opacity: 0.5,
        });
        this.fgLayer.destroyChildren();
        this.fgLayer.add(this.tattooImage);

        this.transformer = new Konva.Transformer({
          nodes: [this.tattooImage],
          rotateEnabled: false,
          keepRatio: true,
          enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
          anchorSize: 10,
          anchorStroke: '#7c5cff',
          anchorFill: '#ffffff',
          borderStroke: '#7c5cff',
          borderDash: [4, 4],
          rotateAnchorOffset: 30,
        });
        this.fgLayer.add(this.transformer);

        this.createHandles();
        this.updateHandles();

        const fire = () => {
          this.updateHandles();
          this._changeCb && this._changeCb(this.getState());
        };
        this.tattooImage.on('dragmove transform', fire);
        this.tattooImage.on('dragend transformend', fire);

        this.fgLayer.batchDraw();
        resolve(this.getState());
      };
      img.onerror = () => reject(new Error('Failed to load tattoo image'));
      img.src = url;
    });
  }

  createHandles() {
    if (this.topHandle) this.topHandle.destroy();
    if (this.bottomHandle) this.bottomHandle.destroy();
    if (this.leftHandle) this.leftHandle.destroy();
    if (this.rightHandle) this.rightHandle.destroy();
    if (this.rotateHandle) this.rotateHandle.destroy();

    const arrowStyle = {
      radius: 11,
      fill: '#ffffff',
      stroke: '#7c5cff',
      strokeWidth: 2,
      shadowColor: '#000000',
      shadowBlur: 4,
      shadowOffset: { x: 0, y: 2 },
      shadowOpacity: 0.2,
    };

    // Top
    this.topHandle = new Konva.Group({ draggable: true, name: 'scale-handle' });
    this.topHandle.add(new Konva.Circle(arrowStyle));
    this.topHandle.add(new Konva.Path({
      data: 'M 0 -6 L -4 -2 L -1 -2 L -1 2 L -4 2 L 0 6 L 4 2 L 1 2 L 1 -2 L 4 -2 Z',
      fill: '#7c5cff',
    }));

    // Bottom
    this.bottomHandle = new Konva.Group({ draggable: true, name: 'scale-handle' });
    this.bottomHandle.add(new Konva.Circle(arrowStyle));
    this.bottomHandle.add(new Konva.Path({
      data: 'M 0 -6 L -4 -2 L -1 -2 L -1 2 L -4 2 L 0 6 L 4 2 L 1 2 L 1 -2 L 4 -2 Z',
      fill: '#7c5cff',
    }));

    // Left
    this.leftHandle = new Konva.Group({ draggable: true, name: 'scale-handle' });
    this.leftHandle.add(new Konva.Circle(arrowStyle));
    this.leftHandle.add(new Konva.Path({
      data: 'M -6 0 L -2 -4 L -2 -1 L 2 -1 L 2 -4 L 6 0 L 2 4 L 2 1 L -2 1 L -2 4 Z',
      fill: '#7c5cff',
    }));

    // Right
    this.rightHandle = new Konva.Group({ draggable: true, name: 'scale-handle' });
    this.rightHandle.add(new Konva.Circle(arrowStyle));
    this.rightHandle.add(new Konva.Path({
      data: 'M -6 0 L -2 -4 L -2 -1 L 2 -1 L 2 -4 L 6 0 L 2 4 L 2 1 L -2 1 L -2 4 Z',
      fill: '#7c5cff',
    }));

    // Mouse Cursors
    const setCursor = (handle, val) => {
      handle.on('mouseenter', () => { this.stage.container().style.cursor = val; });
      handle.on('mouseleave', () => { this.stage.container().style.cursor = 'default'; });
    };
    setCursor(this.topHandle, 'ns-resize');
    setCursor(this.bottomHandle, 'ns-resize');
    setCursor(this.leftHandle, 'ew-resize');
    setCursor(this.rightHandle, 'ew-resize');

    // Drag events
    this.topHandle.on('dragmove', () => {
      if (!this.tattooImage) return;
      const currentScaleY = this.tattooImage.scaleY();
      const rot = this.tattooImage.rotation();
      const W = this.tattooImage.width();
      const H = this.tattooImage.height();

      const transform = this.tattooImage.getAbsoluteTransform();
      const bottomPt = transform.point({ x: W / 2, y: H });

      const pointerPos = this.stage.getPointerPosition();
      if (pointerPos) {
        const local = transform.copy().invert().point(pointerPos);
        const scaleFactor = (H - local.y) / H;
        const minScaleY = 10 / H;
        const newScaleY = Math.max(minScaleY, currentScaleY * scaleFactor);

        this.tattooImage.scaleY(newScaleY);

        const localVec = { x: 0, y: -H / 2 * newScaleY };
        const rotatedVec = rotateVector(localVec.x, localVec.y, rot);

        this.tattooImage.x(bottomPt.x + rotatedVec.x);
        this.tattooImage.y(bottomPt.y + rotatedVec.y);
      }
      this.updateHandles();
      this._changeCb && this._changeCb(this.getState());
      this.fgLayer.batchDraw();
    });

    this.bottomHandle.on('dragmove', () => {
      if (!this.tattooImage) return;
      const currentScaleY = this.tattooImage.scaleY();
      const rot = this.tattooImage.rotation();
      const W = this.tattooImage.width();
      const H = this.tattooImage.height();

      const transform = this.tattooImage.getAbsoluteTransform();
      const topPt = transform.point({ x: W / 2, y: 0 });

      const pointerPos = this.stage.getPointerPosition();
      if (pointerPos) {
        const local = transform.copy().invert().point(pointerPos);
        const scaleFactor = local.y / H;
        const minScaleY = 10 / H;
        const newScaleY = Math.max(minScaleY, currentScaleY * scaleFactor);

        this.tattooImage.scaleY(newScaleY);

        const localVec = { x: 0, y: H / 2 * newScaleY };
        const rotatedVec = rotateVector(localVec.x, localVec.y, rot);

        this.tattooImage.x(topPt.x + rotatedVec.x);
        this.tattooImage.y(topPt.y + rotatedVec.y);
      }
      this.updateHandles();
      this._changeCb && this._changeCb(this.getState());
      this.fgLayer.batchDraw();
    });

    this.rightHandle.on('dragmove', () => {
      if (!this.tattooImage) return;
      const currentScaleX = this.tattooImage.scaleX();
      const rot = this.tattooImage.rotation();
      const W = this.tattooImage.width();
      const H = this.tattooImage.height();

      const transform = this.tattooImage.getAbsoluteTransform();
      const leftPt = transform.point({ x: 0, y: H / 2 });

      const pointerPos = this.stage.getPointerPosition();
      if (pointerPos) {
        const local = transform.copy().invert().point(pointerPos);
        const scaleFactor = local.x / W;
        const minScaleX = 10 / W;
        const newScaleX = Math.max(minScaleX, currentScaleX * scaleFactor);

        this.tattooImage.scaleX(newScaleX);

        const localVec = { x: W / 2 * newScaleX, y: 0 };
        const rotatedVec = rotateVector(localVec.x, localVec.y, rot);

        this.tattooImage.x(leftPt.x + rotatedVec.x);
        this.tattooImage.y(leftPt.y + rotatedVec.y);
      }
      this.updateHandles();
      this._changeCb && this._changeCb(this.getState());
      this.fgLayer.batchDraw();
    });

    this.leftHandle.on('dragmove', () => {
      if (!this.tattooImage) return;
      const currentScaleX = this.tattooImage.scaleX();
      const rot = this.tattooImage.rotation();
      const W = this.tattooImage.width();
      const H = this.tattooImage.height();

      const transform = this.tattooImage.getAbsoluteTransform();
      const rightPt = transform.point({ x: W, y: H / 2 });

      const pointerPos = this.stage.getPointerPosition();
      if (pointerPos) {
        const local = transform.copy().invert().point(pointerPos);
        const scaleFactor = (W - local.x) / W;
        const minScaleX = 10 / W;
        const newScaleX = Math.max(minScaleX, currentScaleX * scaleFactor);

        this.tattooImage.scaleX(newScaleX);

        const localVec = { x: -W / 2 * newScaleX, y: 0 };
        const rotatedVec = rotateVector(localVec.x, localVec.y, rot);

        this.tattooImage.x(rightPt.x + rotatedVec.x);
        this.tattooImage.y(rightPt.y + rotatedVec.y);
      }
      this.updateHandles();
      this._changeCb && this._changeCb(this.getState());
      this.fgLayer.batchDraw();
    });

    const handleDragEnd = () => {
      this._changeCb && this._changeCb(this.getState());
    };
    this.topHandle.on('dragend', handleDragEnd);
    this.bottomHandle.on('dragend', handleDragEnd);
    this.leftHandle.on('dragend', handleDragEnd);
    this.rightHandle.on('dragend', handleDragEnd);

    // ── Rotation handle ──────────────────────────────────────────────────────
    // Circular arrow knob positioned above the top-centre point.
    // Dragging it orbits around the tattoo centre and updates the rotation,
    // which in turn fires _changeCb → applyStateToUI → rotationSlider sync.
    this.rotateHandle = new Konva.Group({ draggable: true, name: 'rotate-handle' });
    this.rotateHandle.add(new Konva.Circle({
      radius: 11,
      fill: '#ffffff',
      stroke: '#ff5c8a',
      strokeWidth: 2,
      shadowColor: '#000000',
      shadowBlur: 4,
      shadowOffset: { x: 0, y: 2 },
      shadowOpacity: 0.25,
    }));
    // Curved-arrow glyph centred in the knob
    this.rotateHandle.add(new Konva.Text({
      text: '↻',
      fontSize: 14,
      fontStyle: 'bold',
      fill: '#ff5c8a',
      x: -7,
      y: -8,
      listening: false,
    }));

    setCursor(this.rotateHandle, 'grab');
    this.rotateHandle.on('mousedown', () => {
      this.stage.container().style.cursor = 'grabbing';
    });
    this.rotateHandle.on('mouseup', () => {
      this.stage.container().style.cursor = 'grab';
    });

    this.rotateHandle.on('dragstart', () => {
      if (!this.tattooImage) return;
      const ptr = this.stage.getPointerPosition();
      if (!ptr) return;
      const cx = this.tattooImage.x();
      const cy = this.tattooImage.y();
      this._rotStartAngle = Math.atan2(ptr.y - cy, ptr.x - cx) * 180 / Math.PI;
      this._rotStartRotation = this.tattooImage.rotation();
    });

    this.rotateHandle.on('dragmove', () => {
      if (!this.tattooImage) return;
      const ptr = this.stage.getPointerPosition();
      if (!ptr) return;
      const cx = this.tattooImage.x();
      const cy = this.tattooImage.y();
      const currentAngle = Math.atan2(ptr.y - cy, ptr.x - cx) * 180 / Math.PI;
      // Normalize delta to [-180, 180] to avoid wrap-around jumps.
      let delta = currentAngle - this._rotStartAngle;
      delta = ((delta + 180) % 360 + 360) % 360 - 180;
      this.tattooImage.rotation(this._rotStartRotation + delta);
      this.updateHandles();
      this._changeCb && this._changeCb(this.getState());
      this.fgLayer.batchDraw();
    });

    this.rotateHandle.on('dragend', () => {
      this._changeCb && this._changeCb(this.getState());
    });

    this.fgLayer.add(this.topHandle);
    this.fgLayer.add(this.bottomHandle);
    this.fgLayer.add(this.leftHandle);
    this.fgLayer.add(this.rightHandle);
    this.fgLayer.add(this.rotateHandle);
  }

  updateHandles() {
    if (!this.tattooImage || !this.topHandle) return;

    const transform = this.tattooImage.getAbsoluteTransform();
    const W = this.tattooImage.width();
    const H = this.tattooImage.height();

    const topPt    = transform.point({ x: W / 2, y: 0 });
    const bottomPt = transform.point({ x: W / 2, y: H });
    const leftPt   = transform.point({ x: 0,     y: H / 2 });
    const rightPt  = transform.point({ x: W,     y: H / 2 });

    this.topHandle.position(topPt);
    this.bottomHandle.position(bottomPt);
    this.leftHandle.position(leftPt);
    this.rightHandle.position(rightPt);

    const rot = this.tattooImage.rotation();
    this.topHandle.rotation(rot);
    this.bottomHandle.rotation(rot);
    this.leftHandle.rotation(rot);
    this.rightHandle.rotation(rot);

    // Rotation handle: 40 px beyond the top-centre point, away from centre.
    if (this.rotateHandle) {
      const cx = this.tattooImage.x();
      const cy = this.tattooImage.y();
      const dx = topPt.x - cx;
      const dy = topPt.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Fallback to straight up in screen space when degenerate (zero-height scale).
      const ux = dist > 0 ? dx / dist : 0;
      const uy = dist > 0 ? dy / dist : -1;
      this.rotateHandle.position({
        x: topPt.x + ux * 40,
        y: topPt.y + uy * 40,
      });
      this.rotateHandle.rotation(rot);
    }
  }

  refit(bodyDims) {
    if (!this.tattooImage || !this.tattooImage.image()) return;
    const fit = fitContours(bodyDims);
    const displayScale = Math.min(
      this._stageSize.w / bodyDims.width,
      this._stageSize.h / bodyDims.height,
    );
    const targetDisplayW = fit.width * displayScale;
    const scale = targetDisplayW / this.tattooImage.image().naturalWidth;
    this.tattooImage.scaleX(scale);
    this.tattooImage.scaleY(scale);
    this.tattooImage.x(this._stageSize.w / 2);
    this.tattooImage.y(this._stageSize.h / 2);
    this.updateHandles();
    this.fgLayer.batchDraw();
    this._changeCb && this._changeCb(this.getState());
  }

  reset() {
    if (!this.tattooImage || !this.bodyNaturalDims) return;
    this.refit(this.bodyNaturalDims);
    this.tattooImage.rotation(0);
    this.tattooImage.skewX(0);
    this.tattooImage.skewY(0);
    this.tattooImage.opacity(0.5);
    this.updateHandles();
    this.fgLayer.batchDraw();
    this._changeCb && this._changeCb(this.getState());
  }

  setRotation(deg) {
    if (!this.tattooImage) return;
    this.tattooImage.rotation(deg);
    this.updateHandles();
    this.fgLayer.batchDraw();
    this._changeCb && this._changeCb(this.getState());
  }

  setOpacity(o) {
    if (!this.tattooImage) return;
    const clamped = Math.max(0, Math.min(1, o));
    this.tattooImage.opacity(clamped);
    this.fgLayer.batchDraw();
    this._changeCb && this._changeCb(this.getState());
  }

  getState() {
    if (!this.tattooImage || !this.tattooImage.image()) {
      return { ready: false };
    }
    const img = this.tattooImage.image();
    const sx = this.tattooImage.scaleX();
    const sy = this.tattooImage.scaleY();
    const width = Math.round(img.naturalWidth * sx);
    const height = Math.round(img.naturalHeight * sy);
    return {
      ready: true,
      x: Math.round(this.tattooImage.x()),
      y: Math.round(this.tattooImage.y()),
      width: width,
      height: height,
      rotation: this._normalizeAngle(this.tattooImage.rotation()),
      opacity: this.tattooImage.opacity(),
      skewX: this.tattooImage.skewX(),
      skewY: this.tattooImage.skewY(),
    };
  }

  _normalizeAngle(deg) {
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  }

  async getTransformedTattooImage() {
    if (!this.tattooImage || !this.tattooImage.image()) return null;

    const rect = this.tattooImage.getClientRect();

    if (this.bodyImage) this.bodyImage.hide();
    if (this.transformer) this.transformer.hide();
    if (this.topHandle) this.topHandle.hide();
    if (this.bottomHandle) this.bottomHandle.hide();
    if (this.leftHandle) this.leftHandle.hide();
    if (this.rightHandle) this.rightHandle.hide();
    if (this.rotateHandle) this.rotateHandle.hide();

    this.fgLayer.batchDraw();
    this.bgLayer.batchDraw();

    const dataURL = this.stage.toDataURL({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      mimeType: 'image/png'
    });

    if (this.bodyImage) this.bodyImage.show();
    if (this.transformer) this.transformer.show();
    if (this.topHandle) this.topHandle.show();
    if (this.bottomHandle) this.bottomHandle.show();
    if (this.leftHandle) this.leftHandle.show();
    if (this.rightHandle) this.rightHandle.show();
    if (this.rotateHandle) this.rotateHandle.show();

    this.fgLayer.batchDraw();
    this.bgLayer.batchDraw();

    return dataURLtoBlob(dataURL);
  }

  getTransformedTattooRect() {
    if (!this.tattooImage) return { x: 0, y: 0, width: 0, height: 0 };
    return this.tattooImage.getClientRect();
  }

  /**
   * Export the entire stage (body + tattoo) as a JPEG blob.
   * The tattoo is forced to full opacity so the composite clearly shows
   * its exact placement, rotation, and scale for use as an AI reference.
   */
  async getCompositeImage() {
    if (!this.tattooImage || !this.bodyImage) return null;

    const savedOpacity = this.tattooImage.opacity();
    this.tattooImage.opacity(1.0);

    // Hide all UI chrome: transformer, handles
    const toHide = [this.transformer, this.topHandle, this.bottomHandle,
                    this.leftHandle, this.rightHandle, this.rotateHandle];
    toHide.forEach((n) => n && n.hide());

    this.bgLayer.batchDraw();
    this.fgLayer.batchDraw();

    const dataURL = this.stage.toDataURL({ mimeType: 'image/jpeg', quality: 0.92 });

    // Restore
    this.tattooImage.opacity(savedOpacity);
    toHide.forEach((n) => n && n.show());
    this.bgLayer.batchDraw();
    this.fgLayer.batchDraw();

    return dataURLtoBlob(dataURL);
  }

  destroy() {
    this.stage.destroy();
  }
}
