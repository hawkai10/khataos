'use strict';

// ============================================================================
// API composition root for the Fastify migration. Domain modules start on the
// legacy Router (createRouter) and move into CONVERTED one at a time; each
// converted module exposes a Fastify plugin (`register(fastify)`) mounted by
// registerDomains. During the transition the server runs both: converted
// modules via Fastify, the rest via the legacy bridge in src/http/app.js.
// ============================================================================

const { Router, ok } = require('./router');
const admin = require('./api/admin');
const cash = require('./api/cash');
const gst = require('./api/gst');
const invoices = require('./api/invoices');
const payments = require('./api/payments');
const tally = require('./api/tally');

const ALL_MODULES = { admin, cash, gst, invoices, payments, tally };

// Modules already migrated to Fastify plugins (order matters). The legacy
// bridge excludes these; createRouter() without an explicit exclude still
// returns every module so the in-process unit-test harness keeps working
// during the transition.
const CONVERTED = ['admin'];

function createRouter({ exclude = [] } = {}) {
  const r = new Router();
  const deps = { ok };
  for (const [name, mod] of Object.entries(ALL_MODULES)) {
    if (exclude.includes(name)) continue;
    mod.register(r, deps);
  }
  return r;
}

async function registerDomains(fastify) {
  for (const name of CONVERTED) {
    await ALL_MODULES[name].register(fastify);
  }
}

module.exports = { createRouter, registerDomains, CONVERTED, ok, Router };
