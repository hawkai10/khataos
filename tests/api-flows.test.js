'use strict';

// API-level negative-path and RBAC tests for the payments/recon/settings
// flows. Route handlers are invoked directly (like tests/aging.test.js) with
// controlled fixture data; every assertion targets a 4xx, never a crash.

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'api-flows-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
process.env.PAYMENT_GATEWAY = 'test';
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert } = require('../server/src/db');
const { hashPassword, nowIso, todayStr } = require('../server/src/util');
const { makeApp, createSession } = require('./helpers');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

async function expectStatus(app, method, routePath, headers, payload, status) {
  const res = await app.inject({ method, url: routePath, headers, payload: payload === undefined ? undefined : JSON.stringify(payload) });
  assert.strictEqual(res.statusCode, status, `${method} ${routePath}: expected ${status}, got ${res.statusCode} (${res.body.slice(0, 120)})`);
}

(async () => {
  const co = 'flows-' + Date.now();
  const today = todayStr();
  await insert('companies', { id: co, name: 'Flows Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('users', {
    id: 'u-cfo', company_id: co, name: 'CFO', email: 'cfo@flows.in',
    password: hashPassword('pw'), role: 'cfo', department: 'Finance', active: 1, created_at: nowIso(),
  });
  await insert('users', {
    id: 'u-exec', company_id: co, name: 'Exec', email: 'exec@flows.in',
    password: hashPassword('pw'), role: 'finance_executive', department: 'Finance', active: 1, created_at: nowIso(),
  });
  await insert('vendors', { id: 'v-1', company_id: co, name: 'Vendor One', gstin: '29ABCDE1234F1Z5', ledger_name: 'Vendor One', tds_section: '194C', tds_rate: 0, credit_days: 30, active: 1 });
  await insert('invoices', {
    id: 'inv-1', company_id: co, invoice_no: 'INV-1', vendor_id: 'v-1', invoice_date: today, due_date: today,
    source: 'manual', status: 'approved', gross_amount: 59000, taxable_amount: 50000, cgst: 4500, sgst: 4500, igst: 0,
    cess: 0, tds_amount: 0, net_payable: 59000, gstin_vendor: '29ABCDE1234F1Z5', hsns: '[]', created_at: nowIso(),
  });
  await insert('payments', {
    id: 'pay-1', company_id: co, vendor_id: 'v-1', invoice_ids: '["inv-1"]', amount: 59000, mode: 'NEFT', type: 'batch',
    status: 'approved', reference: 'NEFT-1', gateway: 'razorpayx', tds_amount: 0, net_amount: 59000,
    initiated_by: 'u-cfo', initiated_at: nowIso(), created_at: nowIso(),
  });

  const cfoAuth = await createSession('u-cfo');
  const execAuth = await createSession('u-exec');
  const app = await makeApp();

  await check('payments: create rejects missing vendor/invoices with 400', () =>
    expectStatus(app, 'POST', '/api/payments', execAuth, {}, 400));
  await check('payments: create rejects an invalid mode with 400', () =>
    expectStatus(app, 'POST', '/api/payments', execAuth, { vendor_id: 'v-1', invoice_ids: ['inv-1'], mode: 'CASH' }, 400));
  await check('payments: create rejects an unknown vendor with 404', () =>
    expectStatus(app, 'POST', '/api/payments', execAuth, { vendor_id: 'v-ghost', invoice_ids: ['inv-1'] }, 404));
  await check('payments: create rejects zero valid invoices with 400', () =>
    expectStatus(app, 'POST', '/api/payments', execAuth, { vendor_id: 'v-1', invoice_ids: ['inv-ghost'] }, 400));
  await check('payments: approve rejects an unknown payment with 404', () =>
    expectStatus(app, 'POST', '/api/payments/pay-ghost/approve', cfoAuth, {}, 404));
  await check('payments: approve rejects an already-approved payment with 409', () =>
    expectStatus(app, 'POST', '/api/payments/pay-1/approve', cfoAuth, {}, 409));

  await check('recon: run requires cfo/manager (executive blocked)', () =>
    expectStatus(app, 'POST', '/api/recon/run', execAuth, {}, 403));
  await check('recon: manual-match rejects an unknown transaction with 404', () =>
    expectStatus(app, 'POST', '/api/recon/manual-match', cfoAuth, { bank_txn_id: 'btx-ghost' }, 404));
  await check('recon: manual-match requires cfo/manager (executive blocked)', () =>
    expectStatus(app, 'POST', '/api/recon/manual-match', execAuth, { bank_txn_id: 'btx-1' }, 403));

  await check('settings: update requires cfo (executive blocked)', () =>
    expectStatus(app, 'PUT', '/api/settings', execAuth, { foo: 'bar' }, 403));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
