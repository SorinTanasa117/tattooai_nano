/**
 * Build, validate, and download the placement payload.
 *
 * Schema v3 (current):
 *   - rotation: free integer 0..359
 *   - opacity:  0..1 (pre-multiplied into the tattoo alpha client-side
 *              before upload -- see app.js applyOpacityToFile)
 *   - composite_x, composite_y: pixel offsets for tattoo placement
 *   - width, height: target render size for the tattoo
 *
 * Removed: shear, counter_clockwise, scale_method (no longer exposed).
 */

export function buildPayload(opts) {
  const bodyFile = opts.bodyFile;
  const tattooFile = opts.tattooFile;
  const s = opts.state;
  if (!bodyFile || !tattooFile) {
    throw new Error('Both body and tattoo must be uploaded first');
  }
  if (!s || !s.ready) {
    throw new Error('Placement not ready -- upload a tattoo design');
  }
  return {
    schema_version: 3,
    body_filename: bodyFile,
    tattoo_filename: tattooFile,
    composite_filename: opts.compositeFile || null,
    composite_x: s.x,
    composite_y: s.y,
    rotation: s.rotation,
    opacity: typeof s.opacity === 'number' ? s.opacity : 1.0,
    width: s.width,
    height: s.height,
    timestamps: { created_at: new Date().toISOString() },
  };
}

export function downloadPayload(payload) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'payload-' + Date.now() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function validatePayload(payload) {
  const required = ['body_filename', 'tattoo_filename', 'composite_x', 'composite_y', 'rotation', 'width', 'height', 'opacity'];
  const missing = required.filter((k) => payload[k] === undefined || payload[k] === null);
  if (missing.length) throw new Error('Missing fields: ' + missing.join(', '));
  if (typeof payload.rotation !== 'number' || payload.rotation < 0 || payload.rotation >= 360) {
    throw new Error('Invalid rotation (must be 0..359)');
  }
  if (typeof payload.opacity !== 'number' || payload.opacity < 0 || payload.opacity > 1) {
    throw new Error('Invalid opacity (must be 0..1)');
  }
  if (typeof payload.width !== 'number' || payload.width <= 0) throw new Error('Invalid width');
  if (typeof payload.height !== 'number' || payload.height <= 0) throw new Error('Invalid height');
  return true;
}
