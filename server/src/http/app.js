'use strict';

// ============================================================================
// Fastify application builder. Replaces the hand-rolled http.createServer +
// Router stack while preserving the exact HTTP contract:
//   - same JSON envelope { ok: true, data } / { ok: false, error: {...} }
//   - same auth model (cookie/Bearer session + PUBLIC_API allowlist + 401s)
//   - same rate limits, structured request log, 4MB body limit, static/SPA
//     serving and test-hook routes
// Domain modules are registered as Fastify plugins; modules not yet converted
// are bridged from the legacy Router via registerLegacy() so the server can
// run fully during the incremental migration.
// ============================================================================

const fastifyFactory = require('fastify');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ApiError, currentUser } = require('../auth');
const { Router, ok } = require('../router');

const WEB_ROOT = path.join(__dirname, '..', '..', '..', 'web');
const FRONTEND_DIST = path.join(__dirname, '..', '..', '..', 'webapp', 'dist');
const DOCS_ROOT = path.join(__dirname, '..', '..', '..', 'docs');
const HAS_FRONTEND = fs.existsSync(path.join(FRONTEND_DIST, 'index.html'));

const PUBLIC_API = new Set([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/integrations/decentro/status',
  'POST /api/decentro/webhook',
  'GET /api/gstn/config',
  'GET /api/assistant/prompts',
]);

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = new Map();

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

function clientKey(request) {
  return (request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
}

function rateLimited(request, bucket, limit) {
  const key = bucket + ':' + clientKey(request);
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

function readFile(file) {
  return new Promise((resolve) => fs.readFile(file, (err, buf) => resolve(err ? null : buf)));
}

async function serveStatic(reply, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel.includes('..')) { reply.code(403).send('forbidden'); return; }
  const root = rel.startsWith('/docs/') ? DOCS_ROOT : (HAS_FRONTEND ? FRONTEND_DIST : WEB_ROOT);
  const file = path.join(root, rel.replace(/^\/docs\//, ''));
  if (!file.startsWith(root)) { reply.code(403).send('forbidden'); return; }
  const buf = await readFile(file);
  if (!buf) {
    if (HAS_FRONTEND && !pathname.startsWith('/api/')) {
      const index = await readFile(path.join(FRONTEND_DIST, 'index.html'));
      if (!index) { reply.code(404).type('text/plain').send('Not found'); return; }
      reply.code(200).type('text/html; charset=utf-8').send(index);
      return;
    }
    reply.code(404).type('text/plain').send('Not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  reply.code(200).type(MIME[ext] || 'application/octet-stream').send(buf);
}

// Shim a legacy (req, res, params, user) handler onto Fastify's reply.
function createResShim(reply) {
  const shim = {
    ended: false,
    headersSent: false,
    writeHead(code, headers) { shim.code = code; shim.headers = headers || {}; },
    setHeader(k, v) { shim.headers = shim.headers || {}; shim.headers[k] = v; },
    end(body) {
      shim.ended = true;
      reply.code(shim.code || 200);
      if (shim.headers && Object.keys(shim.headers).length) reply.headers(shim.headers);
      if (body == null) return reply.send();
      if (typeof body === 'string') {
        const t = body.trim();
        if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
          try { return reply.send(JSON.parse(body)); } catch { /* raw */ }
        }
        return reply.send(body);
      }
      return reply.send(body);
    },
  };
  return shim;
}

// Mount every route still registered on the legacy Router as a Fastify route.
function registerLegacy(fastify, router) {
  for (const route of router.routes) {
    fastify.route({
      method: route.method,
      url: route.pattern,
      handler: async (request, reply) => {
        const shim = createResShim(reply);
        const result = await route.handler(request, shim, request.params || {}, request.user);
        if (!shim.ended) reply.ok(result);
      },
    });
  }
}

async function buildApp() {
  const fastify = fastifyFactory({
    bodyLimit: 4 * 1024 * 1024,
    logger: false, // structured request log is emitted by the onResponse hook
  });

  fastify.decorateReply('ok', function okReply(data) { this.send({ ok: true, data }); });

  // Preserve the exact body behavior of the old server: ANY body is parsed as
  // JSON (empty -> {}, invalid -> 400 with the same message), and requests
  // without a content-type still get a parsed body. Fastify's built-in
  // application/json parser rejects empty bodies, so we override it too.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body)); } catch { done(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
  });
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body)); } catch { done(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
  });

  // Authentication + rate limiting + request id, exactly as before.
  fastify.addHook('onRequest', async (request, reply) => {
    request.rid = crypto.randomBytes(4).toString('hex');
    request.startedAt = Date.now();
    if (!request.url.startsWith('/api/')) return;
    if (request.url === '/api/auth/login' && rateLimited(request, 'login', 10)) throw new ApiError(429, 'Too many login attempts — try again later');
    if (request.url.startsWith('/api/gstn/otp/') && rateLimited(request, 'otp', 5)) throw new ApiError(429, 'Too many OTP requests — try again later');
    const user = await currentUser(request);
    request.user = user;
    if (!user && !PUBLIC_API.has(`${request.method} ${request.url.split('?')[0]}`)) {
      throw new ApiError(401, 'Authentication required');
    }
  });

  fastify.addHook('onResponse', async (request, reply) => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), rid: request.rid, method: request.method,
      path: new URL(request.url, 'http://x').pathname, status: reply.statusCode,
      ms: Date.now() - request.startedAt, user: (request.user && request.user.email) || null,
    }));
  });

  fastify.setErrorHandler((err, request, reply) => {
    if (reply.sent) return;
    let status = err instanceof ApiError ? err.status : (Number.isInteger(err.status) ? err.status : 500);
    let message = err.message || 'Internal error';
    if (err && err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') { status = 413; message = 'payload too large'; }
    if (status === 500) console.error('[error]', err);
    reply.code(status).send({ ok: false, error: { message, status } });
  });

  fastify.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, 'http://x').pathname;
    if (pathname.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, error: { message: `No route for ${request.method} ${pathname}`, status: 404 } });
    }
    await serveStatic(reply, pathname);
  });

  // Converted domain modules register themselves here (Fastify plugins).
  const { registerDomains } = require('../api');
  await registerDomains(fastify);

  // Any module not yet converted rides the legacy router through the bridge.
  const { createRouter } = require('../api');
  const { CONVERTED } = require('../api');
  const legacy = createRouter({ exclude: CONVERTED });
  if (process.env.KHATAOS_TEST_HOOKS === '1') {
    const { installTestHooks } = require('../test-hooks');
    installTestHooks(legacy);
  }
  registerLegacy(fastify, legacy);

  return fastify;
}

module.exports = { buildApp, serveStatic, createResShim, ok, Router };
