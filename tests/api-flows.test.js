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
const { createRouter } = require('../server/src/api');
const { hashPassword, nowIso, todayStr } = require('../server/src/util');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

function invoke(router, method, routePath, req) {
  return new Promise((resolve, reject) => {
    const found = router.find(method, routePath);
    if (!found) return reject(new Error('no route ' + method + ' ' + routePath));
    const res = {
      writeHead() {},
      end(body) { resolve(body ? JSON.parse(body) : null); },
    };
    found.handler({ url: routePath, headers: req.headers || {}, body: req.body || {} }, res, found.params, req.user || null).catch(reject);
  });
}

async function expectStatus(router, method, routePath, req, status) {
  try {
    await invoke(router, method, routePath, req);
    assert.fail(`expected HTTP ${status} for ${method} ${routePath}`);
  } catch (e) {
    assert.strictEqual(e.status, status, `${method} ${routePath}: expected ${status}, got ${e.status} (${e.message})`);
  }
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

  const router = createRouter();
  const cfo = { id: 'u-cfo', company_id: co, role: 'cfo', name: 'CFO' };
  const exec = { id: 'u-exec', company_id: co, role: 'finance_executive', name: 'Exec' };

  await check('payments: create rejects missing vendor/invoices with 400', () =>
    expectStatus(router, 'POST', '/api/payments', { user: exec, body: {} }, 400));
  await check('payments: create rejects an invalid mode with 400', () =>
    expectStatus(router, 'POST', '/api/payments', { user: exec, body: { vendor_id: 'v-1', invoice_ids: ['inv-1'], mode: 'CASH' } }, 400));
  await check('payments: create rejects an unknown vendor with 404', () =>
    expectStatus(router, 'POST', '/api/payments', { user: exec, body: { vendor_id: 'v-ghost', invoice_ids: ['inv-1'] } }, 404));
  await check('payments: create rejects zero valid invoices with 400', () =>
    expectStatus(router, 'POST', '/api/payments', { user: exec, body: { vendor_id: 'v-1', invoice_ids: ['inv-ghost'] } }, 400));
  await check('payments: approve rejects an unknown payment with 404', () =>
    expectStatus(router, 'POST', '/api/payments/pay-ghost/approve', { user: cfo, body: {} }, 404));
  await check('payments: approve rejects an already-approved payment with 409', () =>
    expectStatus(router, 'POST', '/api/payments/pay-1/approve', { user: cfo, body: {} }, 409));

  await check('recon: run requires cfo/manager (executive blocked)', () =>
    expectStatus(router, 'POST', '/api/recon/run', { user: exec, body: {} }, 403));
  await check('recon: manual-match rejects an unknown transaction with 404', () =>
    expectStatus(router, 'POST', '/api/recon/manual-match', { user: cfo, body: { bank_txn_id: 'btx-ghost' } }, 404));
  await check('recon: manual-match requires cfo/manager (executive blocked)', () =>
    expectStatus(router, 'POST', '/api/recon/manual-match', { user: exec, body: { bank_txn_id: 'btx-1' } }, 403));

  await check('settings: update requires cfo (executive blocked)', () =>
    expectStatus(router, 'PUT', '/api/settings', { user: exec, body: { foo: 'bar' } }, 403));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
