'use strict';

// Tests for the Drizzle transaction boundary around the mutating use cases.
// Each flow (invoice capture, payment creation, Tally import) must commit
// atomically: a failure halfway through leaves NOTHING behind — no orphan
// invoice without an approval chain, no scheduled invoice without a payment,
// no half-imported Tally export.

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'transactions-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
// Gateway unset so PaymentGateway.createBatch throws (notConfigured) for the
// payment rollback case below; PAYMENT_GATEWAY=test would enqueue instead.
process.env.PAYMENT_GATEWAY = '';
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, all, get, withTransaction, T } = require('../server/src/db');
const { hashPassword, nowIso, todayStr, addDays } = require('../server/src/util');
const TallyImport = require('../server/src/tally-import');
const { makeApp, createSession } = require('./helpers');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

(async () => {
  const app = await makeApp();

  // ---- 1. invoice capture: a mid-capture failure rolls back EVERYTHING ----
  const badCo = 'tx-rollback-' + Date.now();
  await insert('companies', { id: badCo, name: 'Bad Settings Co', gstin: '29ABCDE1234F1Z5', settings: 'not-json', created_at: nowIso() });
  await insert('users', { id: 'u-bad', company_id: badCo, name: 'Exec', email: 'exec@bad.in', password: hashPassword('pw'), role: 'finance_executive', active: 1, created_at: nowIso() });
  const badAuth = await createSession('u-bad');

  await check('capture: createApprovalChain throws (bad settings JSON) -> 500 and nothing persisted', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/invoices/capture', headers: badAuth,
      payload: JSON.stringify({ invoice_no: 'INV-BAD', taxable_amount: '1000.00', cgst: '90.00', sgst: '90.00' }),
    });
    assert.strictEqual(res.statusCode, 500, 'expected 500, got ' + res.statusCode + ' ' + res.body.slice(0, 120));
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM invoices WHERE company_id = ?', [badCo]))[0].c, 0, 'invoice row survived the rollback');
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = ?)', [badCo]))[0].c, 0);
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM approvals WHERE company_id = ?', [badCo]))[0].c, 0, 'approval chain survived the rollback');
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM audit_logs WHERE company_id = ?', [badCo]))[0].c, 0, 'audit row survived the rollback');
  });

  // ---- 2. invoice capture: a healthy capture commits invoice + lines + approvals + audit ----
  const goodCo = 'tx-commit-' + Date.now();
  await insert('companies', { id: goodCo, name: 'Good Co', gstin: '29ABCDE1234F1Z5', settings: JSON.stringify({ cfo_approval_threshold: 1000000 }), created_at: nowIso() });
  await insert('users', { id: 'u-good', company_id: goodCo, name: 'Exec', email: 'exec@good.in', password: hashPassword('pw'), role: 'finance_executive', active: 1, created_at: nowIso() });
  await insert('vendors', { id: 'v-good', company_id: goodCo, name: 'Vendor', ledger_name: 'Vendor', tds_rate: 0, credit_days: 30, active: 1 });
  const goodAuth = await createSession('u-good');

  await check('capture: healthy capture commits invoice + 1 line + 1 approval + audit', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/invoices/capture', headers: goodAuth,
      payload: JSON.stringify({
        vendor_id: 'v-good', invoice_no: 'INV-GOOD', invoice_date: todayStr(),
        taxable_amount: '5000.00', cgst: '450.00', sgst: '450.00',
        hsns: [{ hsn: '7308', description: 'item', qty: 1, rate: 5000, taxable: 5000, cgst: 450, sgst: 450 }],
      }),
    });
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 200));
    const invId = res.json().data.id;
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM invoices WHERE id = ?', [invId]))[0].c, 1);
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM invoice_lines WHERE invoice_id = ?', [invId]))[0].c, 1);
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ?', [invId]))[0].c, 1, 'expected a single finance-manager approval below threshold');
    assert.strictEqual((await all("SELECT COUNT(*) AS c FROM audit_logs WHERE company_id = ? AND action = 'invoice.captured'", [goodCo]))[0].c, 1);
  });

  // ---- 3. payment creation: gateway failure rolls back the payment AND the invoice status ----
  const payCo = 'tx-pay-' + Date.now();
  await insert('companies', { id: payCo, name: 'Pay Co', gstin: '29ABCDE1234F1Z5', settings: JSON.stringify({ payment_approval_threshold: 500000 }), created_at: nowIso() });
  await insert('users', { id: 'u-pay', company_id: payCo, name: 'Exec', email: 'exec@pay.in', password: hashPassword('pw'), role: 'finance_executive', active: 1, created_at: nowIso() });
  await insert('vendors', { id: 'v-pay', company_id: payCo, name: 'Vendor', ledger_name: 'Vendor', tds_rate: 0, credit_days: 30, active: 1 });
  await insert('invoices', {
    id: 'inv-pay', company_id: payCo, invoice_no: 'INV-PAY', vendor_id: 'v-pay', invoice_date: todayStr(), due_date: addDays(todayStr(), 30),
    source: 'manual', status: 'approved', gross_amount: 59000, taxable_amount: 50000, cgst: 4500, sgst: 4500, igst: 0,
    cess: 0, tds_amount: 0, net_payable: 59000, gstin_vendor: '29ABCDE1234F1Z5', hsns: '[]', created_at: nowIso(),
  });
  const payAuth = await createSession('u-pay');

  await check('payment: create rolls back when the gateway submission fails (no payment row, invoice untouched)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/payments', headers: { ...payAuth, 'idempotency-key': 'tx-pay-' + Date.now() },
      payload: JSON.stringify({ vendor_id: 'v-pay', invoice_ids: ['inv-pay'], mode: 'NEFT', scheduled_date: addDays(todayStr(), 5) }),
    });
    assert.strictEqual(res.statusCode, 503, 'expected gateway not-configured 503, got ' + res.statusCode + ' ' + res.body.slice(0, 150));
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM payments WHERE company_id = ?', [payCo]))[0].c, 0, 'payment row survived the rollback');
    // A future scheduled_date would have flipped the invoice to 'scheduled';
    // the rollback must leave it as it was.
    const inv = await get('SELECT status FROM invoices WHERE id = ?', ['inv-pay']);
    assert.strictEqual(inv.status, 'approved', 'invoice status was not rolled back: ' + inv.status);
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM audit_logs WHERE company_id = ? AND action = ?', [payCo, 'payment.created']))[0].c, 0);
  });

  // ---- 4. Tally import: a mid-import failure rolls back the whole sequence ----
  await check('tally import: a throw halfway through the sequence leaves no groups/ledgers/vouchers', async () => {
    const co = 'tx-tally-' + Date.now();
    // entries is a circular array so JSON.stringify(v.entries) inside the
    // voucher upsert throws mid-import — after groups and ledgers were already
    // written in the same transaction. All of it must roll back.
    const circular = [];
    circular.push(circular);
    const data = {
      groups: [{ name: 'Sundry Creditors' }],
      ledgers: [],
      vouchers: [
        { voucher_number: 'V-1', voucher_type: 'Purchase', date: '2026-08-01', amount: 1000, party_name: null, entries: circular },
      ],
    };
    let threw = false;
    try {
      await TallyImport.importExport(co, data, new Set());
    } catch (e) { threw = true; }
    assert.ok(threw, 'expected the circular entries to throw');
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM tally_groups WHERE company_id = ?', [co]))[0].c, 0, 'groups were not rolled back');
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM tally_ledgers WHERE company_id = ?', [co]))[0].c, 0, 'ledgers were not rolled back');
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM tally_vouchers WHERE company_id = ?', [co]))[0].c, 0, 'vouchers were not rolled back');
  });

  // ---- 5. the transaction helper itself is atomic (commit + rollback) ----
  await check('withTransaction: committed writes persist, thrown writes roll back', async () => {
    const co = 'tx-mech-' + Date.now();
    await withTransaction(async (tx) => {
      await tx.insert(T.companies).values({ id: co, name: 'Mech', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
    });
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM companies WHERE id = ?', [co]))[0].c, 1);
    let threw = false;
    try {
      await withTransaction(async (tx) => {
        await tx.insert(T.companies).values({ id: co + '-x', name: 'X', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
        throw new Error('boom');
      });
    } catch { threw = true; }
    assert.ok(threw);
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM companies WHERE id = ?', [co + '-x']))[0].c, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
