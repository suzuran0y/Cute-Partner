'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const root = path.resolve(__dirname, '../../../characters/default');
const entry = 'model/character.model3.json';
const drivers = new Set(['driver.js', 'state-driver.js', 'secondary-dynamics.js', 'interaction-driver.js', 'action-library.js']);
async function resolveResource(relative) {
  if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const model = JSON.parse(await fs.readFile(path.join(root, entry), 'utf8'));
  const refs = model.FileReferences;
  const modelFiles = new Set([entry, ...[refs.Moc, ...refs.Textures, refs.DisplayInfo, ...refs.Expressions.map(item => item.File), ...Object.values(refs.Motions).flat().map(item => item.File)].filter(Boolean).map(file => 'model/' + file)]);
  const allowed = modelFiles.has(relative) || ['parameter-contract.json', 'actions.json'].includes(relative) ||
    relative.startsWith('web/') && drivers.has(relative.slice(4)) ||
    /^web\/sdk\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.js$/.test(relative) ||
    /^web\/Framework\/Shaders\/WebGL\/[a-zA-Z0-9_-]+\.(vert|frag)$/.test(relative);
  if (!allowed) return null;
  const target = await fs.realpath(path.resolve(root, relative));
  if (!target.startsWith(await fs.realpath(root) + path.sep)) return null;
  return target;
}
module.exports = { resolveResource };
