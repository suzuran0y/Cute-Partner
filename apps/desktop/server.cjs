'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TaskService } = require('./lib/task-service.cjs');
const { resolveResource } = require('./lib/runtime-assets.cjs');
const ROOT = __dirname;
const CHARACTER = path.resolve(ROOT, '../../characters/default');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.moc3': 'application/octet-stream', '.vert': 'text/plain; charset=utf-8', '.frag': 'text/plain; charset=utf-8' };
async function createHost(options = {}) {
  const service = new TaskService(options.dataRoot || path.join(ROOT, 'data'), options);
  const token = crypto.randomBytes(32).toString('hex');
  const clients = new Set();
  const equal = value => typeof value === 'string' && value.length === token.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': TYPES['.json'] }); res.end(JSON.stringify(value)); };
  function broadcast(message) {
    for (const c of clients) c.res.write(`data: ${JSON.stringify({ ...message, connection_id: c.id, session_id: service.session })}\n\n`);
  }
  service.on('state', broadcast);
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: '无效宿主' });
      const url = new URL(req.url, origin);
      if (url.pathname === '/bootstrap' && equal(url.searchParams.get('token'))) {
        const view = url.searchParams.get('view');
        res.writeHead(303, { 'Set-Cookie': `host_session=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/presence-panel.html' });
        return res.end();
      }
      const cookie = /(?:^|;\s*)host_session=([^;]*)/.exec(req.headers.cookie || '')?.[1];
      if (!equal(cookie)) return json(res, 401, { error: '请从启动入口连接本地宿主' });
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: '拒绝跨来源请求' });
      if (url.pathname.startsWith('/runtime/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '运行资源仅支持读取' });
        const target = await resolveResource(decodeURIComponent(url.pathname.slice(9)));
        if (!target) return json(res, 403, { error: '资源不在原生角色运行清单内' });
        const data = await fsp.readFile(target);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)], 'Content-Length': data.length });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        const client = { id: crypto.randomUUID(), res };
        clients.add(client);
        res.write(`data: ${JSON.stringify({ type: 'hello', connection_id: client.id, session_id: service.session, snapshot: service.snapshot() })}\n\n`);
        req.on('close', () => clients.delete(client));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(res, 200, { session_id: service.session, snapshot: service.snapshot() });
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return json(res, 200, { characterId: 'default', native_live2d: true, mode: 'local_commands', protocol: '1.0' });
      if (req.method === 'POST' && ['/api/command', '/api/cancel'].includes(url.pathname)) {
        if (req.headers.origin !== origin) return json(res, 403, { error: '命令需要同源来源' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return json(res, 413, { error: '请求过大' }); }
        let input;
        try { input = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: '请求格式错误' }); }
        try {
          const snapshot = url.pathname === '/api/cancel' ? service.cancel() : service.start(input.command, { failure: input.scenario === 'failure' });
          return json(res, 200, { snapshot });
        } catch (error) { return json(res, 409, { error: error.message }); }
      }
      if (req.method !== 'GET') return json(res, 404, { error: '未知入口' });
      let target;
      if (url.pathname === '/character-icon.png') target = path.join(ROOT, 'assets/character-icon.png');
      else if (url.pathname === '/character-preview.png') target = path.join(CHARACTER, 'preview.png');
      else if (url.pathname.startsWith('/assets/')) return json(res, 403, { error: '素材不在发布清单内' });
      else {
        const relative = url.pathname === '/' ? 'presence-panel.html' : decodeURIComponent(url.pathname.slice(1));
        target = path.resolve(ROOT, 'ui', relative);
        if (!target.startsWith(path.join(ROOT, 'ui') + path.sep) || !TYPES[path.extname(target)]) return json(res, 404, { error: '未知页面' });
      }
      const stat = await fsp.stat(target);
      if (!stat.isFile()) return json(res, 404, { error: '文件不存在' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)], 'Content-Length': stat.size });
      fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch (error) { if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : 500, { error: '本地资源不可用' }); else res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const info = { origin, url: `${origin}/bootstrap?token=${token}`, pid: process.pid, session_id: service.session };
  const heartbeat = setInterval(() => broadcast({ type: 'heartbeat', observed_at: new Date().toISOString() }), 1500);
  heartbeat.unref();
  async function close() { clearInterval(heartbeat); await service.stop(); for (const c of clients) c.res.end(); await new Promise(resolve => server.close(resolve)); }
  return { ...info, service, close };
}
if (require.main === module) {
  const checkId = process.argv.find(arg => /^--presence-check=[a-zA-Z0-9-]+$/.test(arg))?.slice('--presence-check='.length);
  createHost(checkId ? { dataRoot: path.join(ROOT, '.runtime/presence-check', checkId, 'data'), delayMs: 60, fileCount: 6 } : {}).then(host => {
    const runtime = checkId ? path.join(ROOT, '.runtime/presence-check', checkId) : path.join(ROOT, '.runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'server.json'), JSON.stringify({ origin: host.origin, url: host.url, pid: process.pid, session_id: host.session_id }));
    console.log(JSON.stringify({ type: 'ready', origin: host.origin, url: host.url }));
    process.parentPort?.postMessage({ type: 'ready', origin: host.origin, url: host.url });
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await host.close(); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    process.parentPort?.on('message', e => { if (e.data === 'shutdown') stop(); });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { createHost };
