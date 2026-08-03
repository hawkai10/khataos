'use strict';

// API-level tests for payables aging (server/src/api.js): cancelled vouchers
// must be excluded from totals while remaining stored for audit.

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'aging-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert } = require('../server/src/db');
const { hashPassword, uid, nowIso } = require('../server/src/util');
const { makeApp, createSession } = require('./helpers');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

(async () => {
  const co = 'aging-' + Date.now();
  await insert('companies', { id: co, name: 'Aging Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('users', {
    id: 'u-aging', company_id: co, name: 'Aging CFO', email: 'cfo@aging.in',
    password: hashPassword('pw'), role: 'cfo', department: 'Finance', active: 1, created_at: nowIso(),
  });
  const auth = await createSession('u-aging');
  const app = await makeApp();
  await insert('tally_vouchers', {
    id: uid('tv'), company_id: co, voucher_number: 'PU-1', voucher_type: 'Purchase', date: '2026-01-15',
    amount: 100000, party_name: 'Vendor A', entry_json: '[]', tally_guid: 'g-aging-1', tally_alterid: 1,
    cancelled: 0, imported_at: nowIso(),
  });
  await insert('tally_vouchers', {
    id: uid('tv'), company_id: co, voucher_number: 'PU-C', voucher_type: 'Purchase', date: '2026-01-16',
    amount: 90000, party_name: 'Vendor A', entry_json: '[]', tally_guid: 'g-aging-2', tally_alterid: 1,
    cancelled: 1, imported_at: nowIso(),
  });

  await check('payables aging: cancelled purchase vouchers are excluded from totals', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/payables/aging', headers: auth });
    assert.strictEqual(res.statusCode, 200);
    const out = res.json();
    assert.strictEqual(out.data.items.length, 1);
    assert.strictEqual(out.data.items[0].voucher_number, 'PU-1');
    assert.strictEqual(out.data.items[0].amount, 100000);
    assert.strictEqual(out.data.total, 100000);
  });

  await insert('tally_vouchers', {
    id: uid('tv'), company_id: co, voucher_number: 'DN-1', voucher_type: 'Debit Note', date: '2026-02-01',
    amount: 20000, party_name: 'Vendor A', entry_json: '[]', tally_guid: 'g-aging-3', tally_alterid: 1,
    cancelled: 0, imported_at: nowIso(),
  });

  await check('payables aging: Debit Notes net against the same vendor purchase', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/payables/aging', headers: auth });
    assert.strictEqual(res.statusCode, 200);
    const out = res.json();
    assert.strictEqual(out.data.items.length, 1);
    assert.strictEqual(out.data.items[0].amount, 80000);
    assert.strictEqual(out.data.total, 80000); // 100,000 purchase - 20,000 Debit Note
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
