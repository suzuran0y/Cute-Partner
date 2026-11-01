'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
// Copy validation is explicit; never migrate or replace a running authority in place.
function validateCopy({ sourceFile, targetDirectory }) {
  if (!path.isAbsolute(sourceFile) || !path.isAbsolute(targetDirectory)) throw Error('请提供绝对副本路径');
  if (fs.existsSync(targetDirectory)) throw Error('副本目录必须是新目录'); fs.mkdirSync(targetDirectory, { recursive: true });
  const { DatabaseSync } = require('node:sqlite'), { MemoryService } = require('./memory-service.cjs'); const before = new DatabaseSync(sourceFile, { readOnly: true });
  const schemaBefore = before.prepare('PRAGMA user_version').get().user_version, targetFile = path.join(targetDirectory, 'memory.sqlite');
  try { before.prepare('VACUUM INTO ?').run(targetFile); } finally { before.close(); }
  const copy = new MemoryService({ root: targetDirectory }); let report;
  try { if (copy.state().error) throw Error(copy.state().error); report = { id: randomUUID(), parentId: null, at: Date.now(), oldHost: null, newHost: require('./product.cjs').version, schemaBefore, schemaAfter: 1, policyBefore: 0, policyAfter: 1, reason: '验证副本中的首版schema和兼容性，不应用到源库', sourceFile, candidate: targetFile, backup: sourceFile, rollback: '关闭候选；保留源库及新数据。代码与数据成对回退，不用旧代码覆盖新库。', tests: { copyOpened: true, atomicSchema: true }, unverified: ['未来schema升级需另写迁移与完整回归'], maintenanceCost: '本地SQLite复制与验证，模型调用0', authorization: '显式请求的隔离副本检查，非生产安装授权', applied: false, nextReading: ['README.md#sec53', 'README.md#sec45'] }; }
  finally { copy.close(); }
  fs.writeFileSync(path.join(targetDirectory, 'framework-upgrade.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); return report;
}
module.exports = { validateCopy };
