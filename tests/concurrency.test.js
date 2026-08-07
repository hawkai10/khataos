'use strict';

// Concurrency tests for the payment dispatch guard — the exact duplicate-
// outbound-payment scenario from the TOCTOU report:
//   - 10 parallel execute calls (fresh Idempotency-Key each) -> exactly one
//     request wins the conditional UPDATE (status approved -> executing), the
//     other nine get 409, and EXACTLY ONE gateway.execute job is enqueued.
//   - the Idempotency-Key layer: same key twice replays the stored response;
//     same key fired in parallel yields exactly one dispatch; a key reused
//     across different endpoints is refused.
//   - the payment state machine records exactly one approved -> executing
//     transition and the gateway drives the payment to completed afterwards.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'concurrency-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
process.env.PAYMENT_GATEWAY = 'test'; // CI gateway double: createBatch enqueues a real job
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, all, get } = require('../server/src/db');
const { hashPassword, nowIso, todayStr } = require('../server/src/util');
const { makeApp, createSession } = require('./helpers');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => crypto.randomUUID();

async function seedPayment(co, opts = {}) {
  const id = opts.id || 'pay-' + crypto.randomBytes(4).toString('hex');
  await insert('payments', {
    id, company_id: co, vendor_id: 'v-conc', invoice_ids: JSON.stringify(opts.invoiceIds || []),
    amount: opts.amount || 59000, mode: 'NEFT', type: opts.type || 'instant', status: opts.status || 'approved',
    reference: opts.reference || 'NEFT-CONC', gateway: 'razorpayx', tds_amount: 0,
    net_amount: opts.amount || 59000, initiated_by: 'u-cfo', initiated_at: nowIso(), created_at: nowIso(),
  });
  return id;
}

(async () => {
  const co = 'conc-' + Date.now();
  const today = todayStr();
  await insert('companies', { id: co, name: 'Concurrency Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('users', {
    id: 'u-cfo', company_id: co, name: 'CFO', email: 'cfo@conc.in',
    password: hashPassword('pw'), role: 'cfo', department: 'Finance', active: 1, created_at: nowIso(),
  });
  await insert('vendors', { id: 'v-conc', company_id: co, name: 'Vendor', gstin: '29ABCDE1234F1Z5', ledger_name: 'Vendor', tds_rate: 0, credit_days: 30, active: 1 });
  const invoice = (id, no) => insert('invoices', {
    id, company_id: co, invoice_no: no, vendor_id: 'v-conc', invoice_date: today, due_date: today,
    source: 'manual', status: 'approved', gross_amount: 59000, taxable_amount: 50000, cgst: 4500, sgst: 4500, igst: 0,
    cess: 0, tds_amount: 0, net_payable: 59000, gstin_vendor: '29ABCDE1234F1Z5', hsns: '[]', created_at: nowIso(),
  });
  await invoice('inv-exec', 'INV-CONC-1');
  await invoice('inv-approve', 'INV-CONC-2');

  const auth = await createSession('u-cfo');
  const app = await makeApp();

  const gatewayJobs = async (paymentId) =>
    (await all(`SELECT COUNT(*) AS c FROM jobs WHERE type = 'gateway.execute' AND payload LIKE ?`, [`%${paymentId}%`]))[0].c;
  const transitions = async (paymentId, from, to) =>
    (await all(`SELECT COUNT(*) AS c FROM payment_state_transitions WHERE payment_id = ? AND from_status = ? AND to_status = ?`, [paymentId, from, to]))[0].c;

  // ------------------------------------------------------------------
  // 1. 10 parallel executes with DIFFERENT keys -> exactly one dispatch
  // ------------------------------------------------------------------
  const execPay = await seedPayment(co, { id: 'pay-exec', invoiceIds: ['inv-exec'] });
  await check('execute: 10 parallel calls -> exactly one 200, nine 409, exactly one dispatch', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      app.inject({ method: 'POST', url: `/api/payments/${execPay}/execute`, headers: { ...auth, 'idempotency-key': key() }, payload: '{}' })));
    const statuses = results.map((r) => r.statusCode).sort((a, b) => a - b);
    assert.deepStrictEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409, 409, 409],
      'expected one 200 and nine 409s, got ' + statuses.join(','));
    assert.strictEqual(await gatewayJobs(execPay), 1, 'more than one gateway job was enqueued');
    assert.strictEqual(await transitions(execPay, 'approved', 'executing'), 1, 'state machine recorded more than one approved->executing move');
    const pay = await get('SELECT status FROM payments WHERE id = ?', [execPay]);
    assert.notStrictEqual(pay.status, 'approved');
  });

  // The single dispatched job drives the payment through the state machine to
  // completion and pays the invoice (validates the gateway path end-to-end).
  await check('execute: the one dispatched job completes the payment and pays its invoice', async () => {
    let status = null;
    for (let i = 0; i < 20 && status !== 'completed'; i++) {
      await sleep(300);
      status = (await get('SELECT status FROM payments WHERE id = ?', [execPay])).status;
    }
    assert.strictEqual(status, 'completed', 'payment did not reach completed: ' + status);
    assert.strictEqual(await transitions(execPay, 'executing', 'processing'), 1);
    assert.strictEqual(await transitions(execPay, 'processing', 'completed'), 1);
    assert.strictEqual((await get('SELECT status FROM invoices WHERE id = ?', ['inv-exec'])).status, 'paid');
  });

  // ------------------------------------------------------------------
  // 2. Same key, sequential -> replay of the stored response, no re-dispatch
  // ------------------------------------------------------------------
  const replayPay = await seedPayment(co, { id: 'pay-replay' });
  await check('idempotency: same key twice replays the stored response and never re-dispatches', async () => {
    const h = { ...auth, 'idempotency-key': 'replay-key-1' };
    const r1 = await app.inject({ method: 'POST', url: `/api/payments/${replayPay}/execute`, headers: h, payload: '{}' });
    const r2 = await app.inject({ method: 'POST', url: `/api/payments/${replayPay}/execute`, headers: h, payload: '{}' });
    assert.strictEqual(r1.statusCode, 200, r1.body.slice(0, 120));
    assert.strictEqual(r2.statusCode, 200, r2.body.slice(0, 120));
    assert.strictEqual(r2.body, r1.body, 'replay must be byte-identical to the original response');
    assert.strictEqual(r2.headers['x-idempotency-replayed'], 'true');
    assert.strictEqual(await gatewayJobs(replayPay), 1);
    assert.strictEqual(await transitions(replayPay, 'approved', 'executing'), 1);
  });

  // ------------------------------------------------------------------
  // 3. Same key, parallel -> exactly one dispatch
  // ------------------------------------------------------------------
  const parallelKeyPay = await seedPayment(co, { id: 'pay-para' });
  await check('idempotency: same key fired 10x in parallel -> exactly one dispatch', async () => {
    const h = { ...auth, 'idempotency-key': 'parallel-key-1' };
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      app.inject({ method: 'POST', url: `/api/payments/${parallelKeyPay}/execute`, headers: h, payload: '{}' })));
    for (const r of results) assert.ok([200, 409].includes(r.statusCode), 'unexpected status ' + r.statusCode + ' ' + r.body.slice(0, 100));
    assert.ok(results.some((r) => r.statusCode === 200), 'no request won the execute');
    assert.strictEqual(await gatewayJobs(parallelKeyPay), 1, 'parallel same-key requests produced multiple dispatches');
    assert.strictEqual(await transitions(parallelKeyPay, 'approved', 'executing'), 1);
  });

  // ------------------------------------------------------------------
  // 4. Missing / cross-endpoint keys
  // ------------------------------------------------------------------
  await check('idempotency: missing Idempotency-Key on a financial endpoint -> 400', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/payments/${replayPay}/execute`, headers: auth, payload: '{}' });
    assert.strictEqual(res.statusCode, 400, res.body.slice(0, 120));
  });

  await check('idempotency: a key reused on a different endpoint -> 409', async () => {
    const k = key();
    const xPay = await seedPayment(co, { id: 'pay-xroute' });
    const r1 = await app.inject({ method: 'POST', url: `/api/payments/${xPay}/execute`, headers: { ...auth, 'idempotency-key': k }, payload: '{}' });
    assert.strictEqual(r1.statusCode, 200, r1.body.slice(0, 120));
    const approvePay = await seedPayment(co, { id: 'pay-xroute2', status: 'pending_approval', type: 'batch' });
    const r2 = await app.inject({ method: 'POST', url: `/api/payments/${approvePay}/approve`, headers: { ...auth, 'idempotency-key': k }, payload: '{}' });
    assert.strictEqual(r2.statusCode, 409, 'expected 409 for cross-endpoint key reuse, got ' + r2.statusCode + ' ' + r2.body.slice(0, 120));
  });

  // ------------------------------------------------------------------
  // 5. Approve race: 10 parallel approves -> exactly one dispatch
  // ------------------------------------------------------------------
  const approvePay = await seedPayment(co, { id: 'pay-approve', status: 'pending_approval', type: 'batch', invoiceIds: ['inv-approve'] });
  await check('approve: 10 parallel calls -> exactly one 200, nine 409, exactly one dispatch', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      app.inject({ method: 'POST', url: `/api/payments/${approvePay}/approve`, headers: { ...auth, 'idempotency-key': key() }, payload: '{}' })));
    const statuses = results.map((r) => r.statusCode).sort((a, b) => a - b);
    assert.deepStrictEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409, 409, 409],
      'expected one 200 and nine 409s, got ' + statuses.join(','));
    assert.strictEqual(await gatewayJobs(approvePay), 1, 'more than one gateway job was enqueued');
    assert.strictEqual(await transitions(approvePay, 'pending_approval', 'approved'), 1);
    assert.strictEqual((await get('SELECT status FROM payments WHERE id = ?', [approvePay])).status, 'approved');
  });

  // ------------------------------------------------------------------
  // 6. Approve-then-execute would enqueue two gateway jobs; the enqueue
  //    guard and the state machine must collapse them into one dispatch.
  // ------------------------------------------------------------------
  await invoice('inv-ae', 'INV-CONC-3');
  const aePay = await seedPayment(co, { id: 'pay-ae', status: 'pending_approval', type: 'batch', invoiceIds: ['inv-ae'] });
  await check('approve then execute: two dispatch attempts collapse into exactly one gateway job + one completion', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/payments/${aePay}/approve`, headers: { ...auth, 'idempotency-key': key() }, payload: '{}' });
    assert.strictEqual(r1.statusCode, 200, r1.body.slice(0, 120));
    const r2 = await app.inject({ method: 'POST', url: `/api/payments/${aePay}/execute`, headers: { ...auth, 'idempotency-key': key() }, payload: '{}' });
    assert.strictEqual(r2.statusCode, 200, r2.body.slice(0, 120));
    assert.strictEqual(await gatewayJobs(aePay), 1, 'expected exactly one gateway.execute job despite two dispatch attempts');
    assert.strictEqual(await transitions(aePay, 'approved', 'executing'), 1);
    let status = null;
    for (let i = 0; i < 30 && status !== 'completed'; i++) {
      await sleep(300);
      status = (await get('SELECT status FROM payments WHERE id = ?', [aePay])).status;
    }
    assert.strictEqual(status, 'completed', 'payment did not complete: ' + status);
    assert.strictEqual(await transitions(aePay, 'executing', 'processing'), 1, 'gateway claimed the payment more than once');
    assert.strictEqual(await transitions(aePay, 'processing', 'completed'), 1, 'payment completed more than once');
    assert.strictEqual((await get('SELECT status FROM invoices WHERE id = ?', ['inv-ae'])).status, 'paid');
  });

  // ------------------------------------------------------------------
  // 7. Same key on a different resource must 409, never replay.
  // ------------------------------------------------------------------
  await check('idempotency: same key on a different payment -> 409 (never replays another resource)', async () => {
    const k = key();
    const payA = await seedPayment(co, { id: 'pay-samekey-a' });
    const payB = await seedPayment(co, { id: 'pay-samekey-b' });
    const r1 = await app.inject({ method: 'POST', url: `/api/payments/${payA}/execute`, headers: { ...auth, 'idempotency-key': k }, payload: '{}' });
    assert.strictEqual(r1.statusCode, 200, r1.body.slice(0, 120));
    const r2 = await app.inject({ method: 'POST', url: `/api/payments/${payB}/execute`, headers: { ...auth, 'idempotency-key': k }, payload: '{}' });
    assert.strictEqual(r2.statusCode, 409, 'expected 409 for same key on a different payment, got ' + r2.statusCode + ' ' + r2.body.slice(0, 120));
    assert.strictEqual(await gatewayJobs(payB), 0, 'the second payment must never dispatch');
  });

  // ------------------------------------------------------------------
  // 8. A crashed request leaves a 'processing' row; after the lease it is
  //    reclaimed so a retry with the same key can proceed.
  // ------------------------------------------------------------------
  await check('idempotency: a stale processing row (crashed request) is reclaimed after the lease', async () => {
    const stalePay = await seedPayment(co, { id: 'pay-stale' });
    const oldCreatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await insert('idempotency_keys', {
      id: 'idem-stale', company_id: co, key: 'stale-key', method: 'POST', route: `/api/payments/${stalePay}/execute`,
      status: 'processing', created_at: oldCreatedAt,
    });
    const r = await app.inject({ method: 'POST', url: `/api/payments/${stalePay}/execute`, headers: { ...auth, 'idempotency-key': 'stale-key' }, payload: '{}' });
    assert.strictEqual(r.statusCode, 200, r.body.slice(0, 120));
    assert.strictEqual(await gatewayJobs(stalePay), 1, 'the reclaimed request must dispatch');
    const row = await get('SELECT status FROM idempotency_keys WHERE key = ?', ['stale-key']);
    assert.strictEqual(row.status, 'completed');
    // The crashed request's late onResponse (pinned to the OLD created_at) must
    // not clobber the reclaimed row that replaced it.
    const { run } = require('../server/src/db');
    const late = await run("UPDATE idempotency_keys SET status = 'failed', response_body = 'STALE-LATE-WRITE' WHERE id = 'idem-stale' AND created_at = ?", [oldCreatedAt]);
    const changed = late.changes !== undefined ? late.changes : (late.rowCount || 0);
    assert.strictEqual(changed, 0, 'the reclaimed row must be immune to the predecessor request\'s late write');
    assert.strictEqual((await get('SELECT status FROM idempotency_keys WHERE key = ?', ['stale-key'])).status, 'completed');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  // Natural exit (process.exitCode) — process.exit() truncates buffered stdout
  // on Windows, hiding the check results while still reporting the exit code.
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FATAL:', e); process.exitCode = 1; });
