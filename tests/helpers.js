'use strict';

// Shared harness for route-level tests: build the real Fastify app (converted
// modules as plugins, the rest bridged from the legacy router) and create
// real session tokens, so tests exercise the exact server stack.

const crypto = require('crypto');
const { buildApp } = require('../server/src/http/app');
const { insert } = require('../server/src/db');
const { nowIso } = require('../server/src/util');

async function makeApp() {
  const app = await buildApp();
  await app.ready();
  return app;
}

async function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await insert('sessions', {
    token, user_id: userId, created_at: nowIso(),
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  return { authorization: 'Bearer ' + token };
}

module.exports = { makeApp, createSession };
