'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
function prepareWorkspace({ runtime, checkId, localRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local') }) {
  const directory = checkId ? path.join(os.tmpdir(), 'cute-partner-agent-' + checkId, 'workspace') : path.join(localRoot, 'CutePartner', 'workspace');
  const legacy = path.join(runtime, 'agent-workspace'), marker = path.join(runtime, 'workspace-migration-v1.json');
  fs.mkdirSync(directory, { recursive: true }); let notice = '';
  if (!checkId && !fs.existsSync(marker)) {
    const record = { from: legacy, to: directory, at: Date.now(), oldFilesPreserved: true };
    if (fs.existsSync(legacy) && fs.readdirSync(legacy).length) {
      const imported = path.join(directory, 'legacy-workspace-' + Date.now());
      fs.cpSync(legacy, imported, { recursive: true, force: false, errorOnExist: true, filter: source => !fs.lstatSync(source).isSymbolicLink() });
      record.imported = imported; notice = '旧工作区原样保留，并复制到：' + imported;
    }
    fs.mkdirSync(runtime, { recursive: true }); fs.writeFileSync(marker, JSON.stringify(record, null, 2));
  }
  return { directory, legacy, notice };
}
module.exports = { prepareWorkspace };
