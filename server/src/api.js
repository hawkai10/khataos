'use strict';

// ============================================================================
// API composition root (Fastify). Each domain module is a Fastify plugin and
// registers its routes here in a stable order; shared request validation
// lives in src/api/validators.js and repeated SQL in src/services/*.
// ============================================================================

const admin = require('./api/admin');
const cash = require('./api/cash');
const gst = require('./api/gst');
const idempotency = require('./api/idempotency');
const invoices = require('./api/invoices');
const payments = require('./api/payments');
const tally = require('./api/tally');

async function registerDomains(fastify) {
  await idempotency.register(fastify);
  await admin.register(fastify);
  await cash.register(fastify);
  await invoices.register(fastify);
  await payments.register(fastify);
  await gst.register(fastify);
  await tally.register(fastify);
}

module.exports = { registerDomains };
