'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const shortcutName = require('../../../characters/default/character.json').displayName;

function ensureDesktopShortcut({ shell, desktop, root, runtime, platform = process.platform }) {
  if (platform !== 'win32') return { status: 'unsupported' };
  const recordFile = path.join(runtime, 'desktop-shortcut.json');
  const launcher = path.join(root, 'launch.ps1');
  const options = {
    target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + launcher + '"',
    cwd: root,
    icon: path.join(root, 'assets/character-icon.ico'),
    iconIndex: 0,
    description: shortcutName + ' - Cute-Partner desktop companion',
  };
  const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const matches = (link, desired) => samePath(link.target, desired.target) && link.args === desired.args;
  let previous;
  try { previous = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { /* First successful start. */ }
  // A user who removes the icon should not get a new one on every launch.
  if (previous?.schemaVersion === 1 && previous.windowStyle === 7 && previous.shortcutName === shortcutName && samePath(previous.root, root) && samePath(previous.desktop, desktop) && matches(previous.options || {}, options)) return { status: 'already-created', path: previous.path };
  for (const file of [launcher, options.icon, options.target]) {
    if (!fs.existsSync(file)) throw Error('Desktop shortcut resource is missing: ' + path.basename(file));
  }
  const read = file => { try { return shell.readShortcutLink(file); } catch { return null; } };
  const owned = file => {
    const link = read(file);
    return link && (samePath(link.target, options.target) && (link.args === options.args || link.args.startsWith(options.args + ' -NodePath "')) || previous?.options && samePath(file, previous.path) && matches(link, previous.options));
  };
  let oldPath;
  // Retain ownership across a project move or a change in the character's name.
  if (previous?.schemaVersion === 1 && samePath(path.dirname(previous.path || ''), desktop) && previous.options) {
    const existing = read(previous.path);
    if (existing && matches(existing, previous.options)) oldPath = previous.path;
  }
  // Migrate the former installer entry even when it has no local creation record.
  if (!oldPath) oldPath = fs.readdirSync(desktop).filter(name => /^Cute-Partner(?: \(\d+\))?\.lnk$/i.test(name)).map(name => path.join(desktop, name)).find(owned);
  let shortcutPath;
  for (let number = 1; ; number++) {
    const candidate = path.join(desktop, shortcutName + (number === 1 ? '' : ' (' + number + ')') + '.lnk');
    if (!fs.existsSync(candidate) || owned(candidate)) { shortcutPath = candidate; break; }
  }
  const renamed = oldPath && !samePath(oldPath, shortcutPath);
  if (renamed) fs.renameSync(oldPath, shortcutPath);
  try {
    if (!shell.writeShortcutLink(shortcutPath, 'create', options)) throw Error('Windows could not create the desktop shortcut.');
    const saved = shell.readShortcutLink(shortcutPath);
    if (!matches(saved, options) || !samePath(saved.cwd, options.cwd) || !samePath(saved.icon, options.icon)) throw Error('Desktop shortcut verification failed.');
    // Hide the initial console too, before PowerShell processes -WindowStyle Hidden.
    // Electron's shortcut API does not expose the Windows shortcut's show mode.
    const style = spawnSync(options.target, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut($env:CUTE_PARTNER_SHORTCUT_PATH); $link.WindowStyle = 7; $link.Save(); if ($shell.CreateShortcut($env:CUTE_PARTNER_SHORTCUT_PATH).WindowStyle -ne 7) { throw "Shortcut window style verification failed." }'], {
      env: { ...process.env, CUTE_PARTNER_SHORTCUT_PATH: shortcutPath },
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    if (style.error || style.status !== 0) throw Error('Windows could not configure the hidden desktop launcher.');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(recordFile, JSON.stringify({ schemaVersion: 1, shortcutName, windowStyle: 7, root, desktop, path: shortcutPath, options }, null, 2) + '\n');
  } catch (error) {
    if (renamed && !fs.existsSync(oldPath)) fs.renameSync(shortcutPath, oldPath);
    throw error;
  }
  return { status: 'created', path: shortcutPath };
}

module.exports = { ensureDesktopShortcut };
