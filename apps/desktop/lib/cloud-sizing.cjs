'use strict';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function cloudSize(value, area, measured, previous) {
  const kind = value.kind, length = (value.text || '').length;
  const maxWidth = Math.max(1, Math.min(680, area.width - Math.min(20, area.width * .05))), maxHeight = Math.max(1, Math.min(820, area.height * .82));
  const preferred = kind === 'question' ? 590 : kind === 'input' ? 470 : length < 40 ? 350 : length < 160 ? 470 : 570;
  const width = Math.round(Math.min(maxWidth, preferred));
  const contentWidth = Math.max(1, width - 112);
  const estimate = kind === 'question' ? 320 : kind === 'input' ? 150 : 30 + Math.max(1, Math.ceil(length * 13 / Math.max(1, contentWidth - 16))) * 23;
  const naturalHeight = measured ? clamp(measured.naturalHeight, 20, 20000) : estimate;
  let height = Math.round(clamp(naturalHeight + 128, Math.min(190, maxHeight), maxHeight));
  if (value.streaming && previous?.width === width) height = Math.max(height, previous.height);
  return { width, height: Math.min(Math.round(maxHeight), height), maxWidth, maxHeight: Math.round(maxHeight) };
}
module.exports = { cloudSize };
