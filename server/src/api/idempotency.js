'use strict';

// ============================================================================
// Idempotency-Key enforcement for mutating financial endpoints.
//
// A client sending money (or an approval that dispatches money) must attach an
// `Idempotency-Key` header. The key is persisted per company with a UNIQUE
// constraint, so a repeated request with the same key:
//   - replays the stored response byte-for-byte when the first request
//     finished (the network-retry case), or
//   - gets a 409 when the first request is still in flight (the
//     double-submit-in-parallel case).
// The conditional-update guards on the routes themselves remain the backstop
// for clients that generate a fresh key per attempt (e.g. a browser
// double-click) — the two layers are independent.
//
// Scope: payment create/approve/execute/batch and invoice approve/reject —
// every endpoint where a duplicate has real financial consequence. Provider
// webhooks (POST /api/decentro/webhook) are deliberately excluded: the sender
// is an external system we do not control, and the payload is not a payment
// dispatch.
// ============================================================================

const { getDrizzle, T } = require('../db');
const { and, eq } = require('drizzle-orm');
const { uid, nowIso } = require('../util');
const { ApiError } = require('../auth');

// Route patterns (Fastify route options) that must carry an Idempotency-Key.
const FINANCIAL_ROUTES = new Set([
  'POST /api/payments',
  'POST /api/payments/batch',
  'POST /api/payments/:id/approve',
  'POST /api/payments/:id/execute',
  'POST /api/invoices/:id/approve',
  'POST /api/invoices/:id/reject',
]);

// A 'processing' row older than this is presumed to belong to a crashed
// request; a retry with the same key may reclaim it (lease/TTL, so a server
// crash mid-request can never permanently 409-lock an Idempotency-Key).
const STALE_MS = 5 * 60 * 1000;

// Responses >= 500 are persisted as 'failed' instead of 'completed': a server
// fault (unconfigured gateway, unexpected error) should be retried with the
// same key, while 2xx/4xx outcomes are replayed byte-for-byte.
const RETRYABLE_STATUS = (code) => code >= 500;

async function register(fastify) {
  // preHandler (not onRequest) so schema-validation failures — which are the
  // client's bug, not a completed operation — never get persisted as a
  // replayed response.
  fastify.addHook('preHandler', async (request, reply) => {
    const routeOptions = request.routeOptions || {};
    const routeKey = `${routeOptions.method} ${routeOptions.url}`;
    if (!FINANCIAL_ROUTES.has(routeKey)) return;
    const coId = request.user ? request.user.company_id : null;
    if (!coId) return; // auth (onRequest) already rejected anonymous callers
    const key = String(request.headers['idempotency-key'] || '').trim();
    if (!key) throw new ApiError(400, 'Idempotency-Key header required for this endpoint');
    if (key.length > 200) throw new ApiError(400, 'Idempotency-Key too long');

    // The key is scoped to the RESOLVED path (not the route pattern): reusing
    // the same key for a different resource (/payments/A/execute vs
    // /payments/B/execute) is a client bug and must 409, never replay.
    const pathname = new URL(request.url, 'http://x').pathname;

    const d = await getDrizzle();
    const id = uid('idem');
    let inserted = false;
    let insertErr = null;
    try {
      const createdAt = nowIso();
      await d.insert(T.idempotency_keys).values({
        id, company_id: coId, key, method: routeOptions.method, route: pathname,
        status: 'processing', created_at: createdAt,
      });
      inserted = true;
      // Pinned so the late onResponse of a reclaimed request can never clobber
      // the row that replaced it (see the onResponse WHERE).
      request.idempotencyCreatedAt = createdAt;
    } catch (err) { insertErr = err; }

    if (!inserted) {
      // Unique (company_id, key) violation — a request with this key exists.
      const existing = (await d.select().from(T.idempotency_keys)
        .where(and(eq(T.idempotency_keys.company_id, coId), eq(T.idempotency_keys.key, key))).limit(1))[0];
      if (!existing) throw insertErr; // not a duplicate-key error — surface it
      if (existing.method !== routeOptions.method || existing.route !== pathname) {
        throw new ApiError(409, 'Idempotency-Key was already used for a different request');
      }
      if (existing.status === 'completed') {
        // Replay the stored response exactly as the first request produced it.
        reply.header('x-idempotency-replayed', 'true');
        return reply.code(existing.response_status || 200).type('application/json').send(existing.response_body || '{}');
      }
      const stale = existing.status === 'processing' && Date.now() - new Date(existing.created_at).getTime() > STALE_MS;
      if (existing.status === 'processing' && !stale) {
        throw new ApiError(409, 'A request with this Idempotency-Key is already in progress');
      }
      // Reclaim a 'failed' row (first attempt never completed) or a stale
      // 'processing' row (first attempt's process died). The WHERE pins
      // status AND created_at, so of two concurrent reclaims exactly one wins;
      // the loser sees the fresh created_at and gets the in-flight 409.
      const reclaimedAt = nowIso();
      const reclaimed = await d.update(T.idempotency_keys).set({
        status: 'processing', method: routeOptions.method, route: pathname,
        created_at: reclaimedAt, completed_at: null, response_status: null, response_body: null,
      }).where(and(
        eq(T.idempotency_keys.id, existing.id),
        eq(T.idempotency_keys.status, existing.status),
        eq(T.idempotency_keys.created_at, existing.created_at),
      )).returning({ id: T.idempotency_keys.id });
      if (!reclaimed.length) {
        throw new ApiError(409, 'A request with this Idempotency-Key is already in progress');
      }
      request.idempotencyRowId = existing.id;
      request.idempotencyCreatedAt = reclaimedAt;
      return;
    }
    request.idempotencyRowId = id;
  });

  // Capture the actual response synchronously so a repeat request can replay
  // it. This hook MUST NOT await or yield anything: an async gap here lets the
  // route's own promise resolution fire wrapThenable's trailing
  // reply.send(undefined) while reply.sent is still false, which would
  // double-send and corrupt the stored response. Callback style keeps the
  // whole send pipeline synchronous; persistence happens in onResponse. The
  // payload !== undefined guard keeps the real body even if a second send
  // sneaks in (error-handler responses are captured too — replaying whatever
  // the first attempt produced is the correct idempotency contract).
  fastify.addHook('onSend', (request, reply, payload, done) => {
    if (request.idempotencyRowId && payload !== undefined) {
      request.idempotencyResponse = {
        status: reply.statusCode,
        body: typeof payload === 'string' ? payload : JSON.stringify(payload == null ? {} : payload),
      };
    }
    done(null, payload);
  });

  fastify.addHook('onResponse', async (request, reply) => {
    if (!request.idempotencyRowId) return;
    const d = await getDrizzle();
    // WHERE pins created_at (the claim token): if this row was reclaimed while
    // the request ran (stale lease), the late write is a no-op and the new
    // request's row stays intact.
    const where = [
      eq(T.idempotency_keys.id, request.idempotencyRowId),
      eq(T.idempotency_keys.created_at, request.idempotencyCreatedAt),
    ];
    if (request.idempotencyResponse && !RETRYABLE_STATUS(request.idempotencyResponse.status)) {
      await d.update(T.idempotency_keys).set({
        status: 'completed',
        response_status: request.idempotencyResponse.status,
        response_body: request.idempotencyResponse.body,
        completed_at: nowIso(),
      }).where(and(...where));
    } else {
      // 5xx outcome, or no payload was ever captured: leave the row retryable
      // ('failed') so a repeat request with the same key re-attempts instead
      // of replaying a server fault forever.
      await d.update(T.idempotency_keys).set({ status: 'failed', completed_at: nowIso() })
        .where(and(...where));
    }
  });
}

module.exports = { register, FINANCIAL_ROUTES };
