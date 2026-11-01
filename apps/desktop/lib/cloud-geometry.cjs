'use strict';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function cloudLayout(pet, area, { size = { width: 440, height: 260 }, head = { x: .5, y: .12 }, previousSide } = {}) {
  let width = Math.min(size.width, area.width); const height = Math.min(size.height, area.height);
  const point = { x: pet.x + pet.width * head.x, y: pet.y + pet.height * head.y }, gap = Math.max(80, pet.width * .32);
  const candidates = { above: { x: point.x - width / 2, y: point.y - height - 6 }, right: { x: point.x + gap, y: point.y - 56 }, left: { x: point.x - gap - width, y: point.y - 56 } };
  let side = 'above';
  const aboveRoom = candidates.above.y - area.y;
  if (aboveRoom < 0 || (previousSide === 'left' || previousSide === 'right') && aboveRoom < 28) {
    const rightSpace = area.x + area.width - point.x, leftSpace = point.x - area.x;
    side = previousSide === 'left' || previousSide === 'right' ? previousSide : rightSpace >= leftSpace ? 'right' : 'left';
    const space = s => s === 'right' ? rightSpace : leftSpace;
    if (space(side) < width + gap && space(side === 'right' ? 'left' : 'right') > space(side) + 48) side = side === 'right' ? 'left' : 'right';
  }
  if (side !== 'above') { const space = side === 'right' ? area.x + area.width - point.x : point.x - area.x, available = Math.floor(space - gap - 8); if (available >= 240 && available < width) { width = available; candidates.left.x = point.x - gap - width; } }
  const body = { x: Math.min(32, width * .12), y: Math.min(22, height * .10), width: Math.max(1, width - Math.min(64, width * .24)), height: Math.max(1, height - Math.min(60, height * .24)) };
  const px = Math.min(24, body.width * .10), py = Math.min(34, body.height * .22);
  const content = { x: body.x + px, y: body.y + py, width: body.width - 2 * px, height: body.height - 2 * py };
  const c = candidates[side], bounds = { x: Math.round(clamp(c.x, area.x, area.x + area.width - width)), y: Math.round(clamp(c.y, area.y, area.y + area.height - height)), width, height };
  const target = { x: point.x - bounds.x, y: point.y - bounds.y }, center = { x: body.x + body.width / 2, y: body.y + body.height / 2 }, dx = target.x - center.x, dy = target.y - center.y;
  const distance = Math.hypot(dx, dy) || 1, factor = Math.min((body.width / 2) / Math.max(1, Math.abs(dx)), (body.height / 2) / Math.max(1, Math.abs(dy)));
  const edge = { x: center.x + dx * factor, y: center.y + dy * factor };
  const dots = [18, 34].map((offset, i) => ({ x: edge.x + dx / distance * offset, y: edge.y + dy / distance * offset, radius: i ? 4 : 7 }));
  const safe = dots.every(d => d.x - d.radius >= 3 && d.y - d.radius >= 3 && d.x + d.radius <= width - 3 && d.y + d.radius <= height - 3) && distance > Math.hypot(edge.x - center.x, edge.y - center.y) + 36;
  return { bounds, body, content, dots: safe ? dots : [], head: point, side };
}
function cloudBounds(pet, area, size) { return cloudLayout(pet, area, { size }).bounds; }
module.exports = { cloudBounds, cloudLayout };
