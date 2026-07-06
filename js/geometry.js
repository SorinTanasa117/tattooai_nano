/**
 * Geometry helpers: fit-to-body, pseudo-3D.
 *
 * Note: rotation is now FREE (0-359, any integer) since the RotateImage
 * node accepts any value. The legacy 90-step snapping has been removed.
 */

export function fitContours(body) {
  const targetSide = Math.round(Math.min(body.width, body.height) * 0.5);
  return {
    x: Math.round(body.width / 2),
    y: Math.round(body.height / 2),
    width: targetSide,
    height: targetSide,
    scale: 1,
  };
}

export function applyPseudo3D(shearPct, nodeY, canvasH) {
  if (canvasH <= 0) return 0;
  const t = (nodeY / canvasH) - 0.5;
  return Math.round(t * (shearPct / 30) * 40);
}
