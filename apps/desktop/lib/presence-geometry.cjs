'use strict';
// Native model canvas is 1536 × 2048; the status strip is outside the canvas.
const FOOTER = 26;
function sizeFor(scale) { const width = Math.round(360 * scale); return { width, height: Math.round(width * 2048 / 1536) + FOOTER }; }
function clampBounds(bounds, area) {
  return { ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)))) };
}
function scaledBounds(old, scale, anchor = { x: .5, y: .9 }) {
  const next = sizeFor(scale);
  return { ...next, x: Math.round(old.x + (old.width - next.width) * anchor.x), y: Math.round(old.y + (old.height - FOOTER) * anchor.y - (next.height - FOOTER) * anchor.y) };
}
function readSettings(value) {
  return { scale: Number.isFinite(value?.scale) && value.scale >= .65 && value.scale <= 1.3 ? value.scale : 1,
    alwaysOnTop: typeof value?.alwaysOnTop === 'boolean' ? value.alwaysOnTop : true,
    position: Number.isFinite(value?.position?.x) && Number.isFinite(value?.position?.y) ? { x: Math.round(value.position.x), y: Math.round(value.position.y) } : null };
}
module.exports = { sizeFor, clampBounds, scaledBounds, readSettings };
