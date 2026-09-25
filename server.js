'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scanAll } = require('./lib/scan');
const { writeMerge } = require('./lib/merge');

const PORT = 7788;
const HOME = os.homedir();
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let scanCache = null;
let entryIndex = new Map(); // id -> entry

function indexEntries(scan) {
  entryIndex = new Map();
  let n = 0;
  const walk = (entries) => {
    for (const e of entries) {
      e.id = 'e' + (++n);
      entryIndex.set(e.id, e);
    }
  };
  for (const list of Object.values(scan.user)) walk(list);
  for (const p of scan.projects) for (const list of Object.values(p.sources)) walk(list);
}

function getScan(force) {
  if (force || !scanCache) {
    scanCache = scanAll();
    indexEntries(scanCache);
  }
  return scanCache;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function safeResolve(p) {
  const resolved = path.resolve(p);
  return resolved.startsWith(HOME) ? resolved : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 10 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  let content;
  try { content = fs.readFileSync(file); } catch { res.writeHead(404); res.end('Not Found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/scan' && req.method === 'GET') {
      const scan = getScan(url.searchParams.get('force') === '1');
      return sendJson(res, 200, scan);
    }
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const target = safeResolve(url.searchParams.get('path') || '');
      if (!target) return sendJson(res, 400, { error: '非法路径' });
      let content;
      try { content = fs.readFileSync(target, 'utf8'); } catch { return sendJson(res, 404, { error: '文件不存在' }); }
      return sendJson(res, 200, { content });
    }
    if (url.pathname === '/api/merge' && req.method === 'POST') {
      const body = await readBody(req);
      const projectDir = safeResolve(body.projectDir || '');
      if (!projectDir || !fs.existsSync(projectDir)) return sendJson(res, 400, { error: '项目目录无效' });
      const entries = (body.entries || []).map(id => entryIndex.get(id)).filter(Boolean);
      if (!entries.length) return sendJson(res, 400, { error: '未选择任何记忆条目' });
      const results = writeMerge(projectDir, entries, body.pointers || {});
      getScan(true);
      return sendJson(res, 200, { ok: true, results, scan: scanCache });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: '未知接口' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    return sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`记忆中枢已启动: http://127.0.0.1:${PORT}`);
});
