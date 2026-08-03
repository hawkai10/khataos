'use strict';

require('./env').loadEnv(); // load .env before any config is read

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// ---- structured request log + in-memory rate limiter ----
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = new Map();

function clientKey(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function rateLimited(req, bucket, limit) {
  const key = bucket + ':' + clientKey(req);
  const now = Date.now();
  let entry = RATE_LIMITS.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    RATE_LIMITS.set(key, entry);
  }
  entry.count += 1;
  if (RATE_LIMITS.size > 10000) RATE_LIMITS.clear();
  return entry.count > limit;
}

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
  const startedAt = Date.now();
  const requestId = crypto.randomBytes(4).toString('hex');
  let authEmail = null;
  res.on('finish', () => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), rid: requestId, method: req.method, path: new URL(req.url, 'http://x').pathname,
      status: res.statusCode, ms: Date.now() - startedAt, user: authEmail || null,
    }));
  });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/auth/login' && rateLimited(req, 'login', 10)) throw new ApiError(429, 'Too many login attempts — try again later');
      if (url.pathname.startsWith('/api/gstn/otp/') && rateLimited(req, 'otp', 5)) throw new ApiError(429, 'Too many OTP requests — try again later');
      const route = router.find(req.method, url.pathname);
      if (!route) throw new ApiError(404, `No route for ${req.method} ${url.pathname}`);
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) req.body = await readBody(req);
      const user = await require('./auth').currentUser(req);
      authEmail = user ? user.email : null;
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
    // Respect provider errors that carry an HTTP status (e.g. 503 when an
    // integration is unconfigured, 502 for upstream failures).
    const status = err instanceof ApiError ? err.status : (Number.isInteger(err.status) ? err.status : 500);
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
    console.log('Reference data seeded. No demo tenant is created — data only arrives through the real channels (Tally XML, bank statements, GSTR-2B, forwarded invoices).');
  });
})();
