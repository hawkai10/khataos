'use strict';

// Tests for the security hardening, exercised through the real Fastify app:
//   - passwords are hashed with scrypt; legacy sha256:salt hashes still verify
//   - a successful login upgrades a legacy hash to scrypt
//   - login issues an HttpOnly SameSite=Strict session cookie and logout
//     clears it; currentUser accepts the cookie

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'security-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
// The burst checks below isolate rate-limit buckets via X-Forwarded-For. That
// only works in trusted-proxy mode, so this test process exercises that path;
// the default socket-IP keying is covered by the real-HTTP smoke suite.
process.env.KHATAOS_TRUST_PROXY = '1';
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, get } = require('../server/src/db');
const { hashPassword, verifyPassword, nowIso } = require('../server/src/util');
const { makeApp } = require('./helpers');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

async function login(app, email, password, headers = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: JSON.stringify({ email, password }) });
}

(async () => {
  const co = 'sec-' + Date.now();
  await insert('companies', { id: co, name: 'Security Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('users', {
    id: 'u-sec', company_id: co, name: 'Sec User', email: 'sec@test.in',
    password: hashPassword('s3cret!'), role: 'cfo', department: 'Finance', active: 1, created_at: nowIso(),
  });
  const app = await makeApp();

  await check('passwords: scrypt hash format round-trips', () => {
    const h = hashPassword('s3cret!');
    assert.ok(h.startsWith('scrypt$'), h);
    assert.strictEqual(verifyPassword('s3cret!', h), true);
    assert.strictEqual(verifyPassword('wrong', h), false);
  });

  await check('passwords: legacy sha256:salt hash still verifies', () => {
    const salt = crypto.randomBytes(8).toString('hex');
    const legacy = salt + '$' + crypto.createHash('sha256').update(`${salt}:legacy-pw`).digest('hex');
    assert.strictEqual(verifyPassword('legacy-pw', legacy), true);
    assert.strictEqual(verifyPassword('nope', legacy), false);
  });

  await check('auth: login sets an HttpOnly SameSite=Strict cookie', async () => {
    const res = await login(app, 'sec@test.in', 's3cret!');
    assert.strictEqual(res.statusCode, 200);
    const cookie = res.headers['set-cookie'];
    assert.ok(cookie && cookie.startsWith('khataos_session='), cookie);
    assert.ok(cookie.includes('HttpOnly'), cookie);
    assert.ok(cookie.includes('SameSite=Strict'), cookie);
    assert.ok(cookie.includes('Path=/'), cookie);
  });

  await check('auth: currentUser accepts the session cookie', async () => {
    const res = await login(app, 'sec@test.in', 's3cret!');
    const cookie = res.headers['set-cookie'].split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    assert.strictEqual(me.statusCode, 200);
    assert.strictEqual(me.json().data.email, 'sec@test.in');
  });

  await check('auth: legacy hash is upgraded to scrypt on login', async () => {
    const salt = crypto.randomBytes(8).toString('hex');
    const legacy = salt + '$' + crypto.createHash('sha256').update(`${salt}:oldpw`).digest('hex');
    await insert('users', {
      id: 'u-legacy', company_id: co, name: 'Legacy User', email: 'legacy@test.in',
      password: legacy, role: 'finance_manager', department: 'Finance', active: 1, created_at: nowIso(),
    });
    const res = await login(app, 'legacy@test.in', 'oldpw');
    assert.strictEqual(res.statusCode, 200);
    const row = await get('SELECT password FROM users WHERE id = ?', ['u-legacy']);
    assert.ok(row.password.startsWith('scrypt$'), row.password);
  });

  await check('auth: logout clears the session cookie', async () => {
    const res = await login(app, 'sec@test.in', 's3cret!');
    const cookie = res.headers['set-cookie'].split(';')[0];
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    assert.strictEqual(out.statusCode, 200);
    assert.ok(out.headers['set-cookie'].includes('Max-Age=0'), out.headers['set-cookie']);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    assert.strictEqual(me.statusCode, 401, 'cleared cookie must not authenticate');
  });

  // Concurrent bursts: the rate-limit increment is synchronous inside Fastify's
  // onRequest hook, so parallel requests must be counted exactly — 10 login
  // attempts pass (limit 10) and the 11th+ are blocked; 5 OTP requests pass
  // (limit 5) and the 6th+ are blocked. These assert exact counts, not just
  // "some 429 appeared", so an off-by-one or race fails loudly.
  await check('auth: concurrent login burst counted exactly (10 pass, 11th+ blocked)', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, () => login(app, 'burst@test.in', 'wrong', { 'x-forwarded-for': '203.0.113.55' })));
    const counts = results.reduce((m, r) => { m[r.statusCode] = (m[r.statusCode] || 0) + 1; return m; }, {});
    assert.deepStrictEqual(counts, { 401: 10, 429: 5 });
  });

  await check('auth: concurrent OTP burst counted exactly (5 pass, 6th+ blocked)', async () => {
    const results = await Promise.all(Array.from({ length: 7 }, () => app.inject({
      method: 'POST', url: '/api/gstn/otp/request', headers: { 'x-forwarded-for': '198.51.100.88' }, payload: '{}',
    })));
    const counts = results.reduce((m, r) => { m[r.statusCode] = (m[r.statusCode] || 0) + 1; return m; }, {});
    assert.deepStrictEqual(counts, { 401: 5, 429: 2 });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
