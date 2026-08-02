'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRouter, ok } = require('./api');
const { ApiError } = require('./auth');
const { seedIfEmpty } = require('./seed');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEB_ROOT = path.join(__dirname, '..', '..', 'web');

const router = createRouter();
seedIfEmpty();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { reject(new ApiError(413, 'payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new ApiError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel.includes('..')) { res.writeHead(403); res.end('forbidden'); return; }
  const file = path.join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const route = router.find(req.method, url.pathname);
      if (!route) throw new ApiError(404, `No route for ${req.method} ${url.pathname}`);
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) req.body = await readBody(req);
      const user = require('./auth').currentUser(req);
      const data = await route.handler(req, res, route.params, user);
      if (!res.headersSent) ok(res, data);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    if (status === 500) console.error('[error]', err);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { message: err.message || 'Internal error', status } }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`KhataOS MVP running: http://localhost:${PORT}`);
  console.log('Demo logins: cfo@acme.in / manager@acme.in / exec@acme.in (password: demo1234)');
});
