'use strict';

require('./env').loadEnv(); // load .env before any config is read

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRouter, ok } = require('./api');
const { ApiError } = require('./auth');
const { seedIfEmpty } = require('./seed');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEB_ROOT = path.join(__dirname, '..', '..', 'web');
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'webapp', 'dist');
const DOCS_ROOT = path.join(__dirname, '..', '..', 'docs');
// Prefer the React + shadcn-style build (webapp/dist) when present; fall back
// to the legacy zero-dependency SPA (web/) so the repo always runs.
const HAS_FRONTEND = fs.existsSync(path.join(FRONTEND_DIST, 'index.html'));

const router = createRouter();

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
  const root = rel.startsWith('/docs/') ? DOCS_ROOT : (HAS_FRONTEND ? FRONTEND_DIST : WEB_ROOT);
  const file = path.join(root, rel.replace(/^\/docs\//, ''));
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback: unknown non-API paths serve the React app's index.html
      // so client-side navigation/refresh keeps working.
      if (HAS_FRONTEND && !pathname.startsWith('/api/')) {
        return fs.readFile(path.join(FRONTEND_DIST, 'index.html'), (err2, buf2) => {
          if (err2) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(buf2);
        });
      }
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
      const user = await require('./auth').currentUser(req);
      // Only a small allowlist of routes works without a session (login,
      // logout, integration status/config, provider webhooks). Everything
      // else must 401 cleanly instead of crashing in companyOf(null).
      const PUBLIC_API = new Set([
        'POST /api/auth/login',
        'POST /api/auth/logout',
        'GET /api/integrations/decentro/status',
        'POST /api/decentro/webhook',
        'GET /api/gstn/config',
        'GET /api/assistant/prompts',
      ]);
      if (!user && !PUBLIC_API.has(`${req.method} ${url.pathname}`)) {
        throw new ApiError(401, 'Authentication required');
      }
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

(async () => {
  await seedIfEmpty();
  server.listen(PORT, () => {
    console.log(`KhataOS MVP running: http://localhost:${PORT}`);
    console.log('Demo logins: cfo@acme.in / manager@acme.in / exec@acme.in (password: demo1234)');
  });
})();
