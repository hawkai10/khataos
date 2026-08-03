'use strict';

// ============================================================================
// API composition root. Route handlers live in domain routers under src/api/
// (cash, invoices, payments, gst, tally, admin); shared request validation
// lives in src/api/validators.js; repeated SQL lives in src/services/*. This
// file only mounts the domains and re-exports the shared primitives.
// ============================================================================

const { Router, ok } = require('./router');
const cash = require('./api/cash');
const invoices = require('./api/invoices');
const payments = require('./api/payments');
const gst = require('./api/gst');
const tally = require('./api/tally');
const admin = require('./api/admin');

function createRouter() {
  const r = new Router();
  const deps = { ok };
  cash.register(r, deps);
  invoices.register(r, deps);
  payments.register(r, deps);
  gst.register(r, deps);
  tally.register(r, deps);
  admin.register(r, deps);
  return r;
}

module.exports = { createRouter, ok, Router };
