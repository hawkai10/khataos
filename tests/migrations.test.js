'use strict';

// Tests for the versioned migration runner and the invoice uniqueness guard:
//   - a legacy DB with duplicate invoices (plus dependent rows) is deduped on
//     boot, keeps the earliest row, and gets the unique index
//   - schema_migrations records each applied version exactly once
//   - the capture route rejects a duplicate invoice number with 409

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'migrations-unit-' + process.pid + '.db');
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

// Build a "legacy" DB containing only the invoice tables with duplicates,
// as it would exist before the versioned runner was introduced. The tables
// carry the columns the invoice dedupe / index migrations need AND the columns
// the Drizzle baseline indexes reference, so the Drizzle migration layer can
// also apply cleanly on top (the capture route below runs on Drizzle).
const { DatabaseSync } = require('node:sqlite');
const legacy = new DatabaseSync(TEST_DB);
legacy.exec('CREATE TABLE invoices (id TEXT PRIMARY KEY, company_id TEXT, invoice_no TEXT, invoice_date TEXT, status TEXT, created_at TEXT)');
legacy.exec('CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT)');
legacy.exec('CREATE TABLE approvals (id TEXT PRIMARY KEY, invoice_id TEXT)');
// Legacy money: REAL rupees column, as every pre-paise database stored it.
legacy.exec('CREATE TABLE bank_transactions (id TEXT PRIMARY KEY, account_id TEXT, external_id TEXT, company_id TEXT, matched INTEGER, status TEXT, txn_date TEXT, amount REAL)');
legacy.exec("INSERT INTO bank_transactions (id, amount) VALUES ('btx-legacy', -25000.50)");
legacy.exec("INSERT INTO invoices VALUES ('inv-old', 'co1', 'INV-1', '2026-01-01', 'approved', '2026-01-01T00:00:00.000Z')");
legacy.exec("INSERT INTO invoices VALUES ('inv-new', 'co1', 'INV-1', '2026-01-02', 'approved', '2026-01-02T00:00:00.000Z')");
legacy.exec("INSERT INTO invoice_lines VALUES ('line-dupe', 'inv-new')");
legacy.exec("INSERT INTO approvals VALUES ('appr-dupe', 'inv-new')");
legacy.close();

process.env.KHATAOS_DB = TEST_DB;

const assert = require('assert');
const { all, get, run, insert } = require('../server/src/db');
const { hashPassword, nowIso } = require('../server/src/util');
const { makeApp, createSession } = require('./helpers');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

(async () => {
  await insert('companies', { id: 'co1', name: 'Legacy Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('users', {
    id: 'u1', company_id: 'co1', name: 'Exec', email: 'exec@mig.test',
    password: hashPassword('pw'), role: 'finance_executive', department: 'Finance', active: 1, created_at: nowIso(),
  });
  const auth = await createSession('u1');
  const app = await makeApp();

  await check('migration: duplicate invoices are deduped, keeping the earliest', async () => {
    const rows = await all('SELECT id FROM invoices WHERE company_id = ?', ['co1']);
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    assert.strictEqual(rows[0].id, 'inv-old');
  });

  await check('migration: dependent rows of deduped invoices are removed', async () => {
    assert.strictEqual((await all('SELECT id FROM invoice_lines WHERE invoice_id = ?', ['inv-new'])).length, 0);
    assert.strictEqual((await all('SELECT id FROM approvals WHERE invoice_id = ?', ['inv-new'])).length, 0);
  });

  await check('migration: schema_migrations records versions 1, 2 and 3 exactly once', async () => {
    const rows = await all('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepStrictEqual(rows.map((r) => r.version), [1, 2, 3]);
  });

  await check('migration: legacy rupee money columns are converted to paise (v3)', async () => {
    const row = await get('SELECT amount FROM bank_transactions WHERE id = ?', ['btx-legacy']);
    assert.strictEqual(row.amount, -2500050, 'rupees -25000.50 must become -2500050 paise');
  });

  await check('migration: the unique index now rejects duplicate invoice numbers', async () => {
    let threw = false;
    try {
      await run("INSERT INTO invoices (id, company_id, invoice_no, created_at) VALUES ('inv-x', 'co1', 'INV-1', '2026-01-03T00:00:00.000Z')");
    } catch (e) { threw = /unique|constraint/i.test(String(e.message)); }
    assert.ok(threw, 'expected a unique-constraint failure');
  });

  await check('api: capture route rejects a duplicate invoice number with 409', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/invoices/capture', headers: auth,
      payload: JSON.stringify({ invoice_no: 'INV-1', taxable_amount: 1000, cgst: 90, sgst: 90, igst: 0, gross_amount: 1180 }),
    });
    assert.strictEqual(res.statusCode, 409, 'expected 409 for duplicate invoice_no: ' + res.body.slice(0, 120));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
