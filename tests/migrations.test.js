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
// as it would exist before the versioned runner was introduced.
const { DatabaseSync } = require('node:sqlite');
const legacy = new DatabaseSync(TEST_DB);
legacy.exec('CREATE TABLE invoices (id TEXT PRIMARY KEY, company_id TEXT, invoice_no TEXT, created_at TEXT)');
legacy.exec('CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT)');
legacy.exec('CREATE TABLE approvals (id TEXT PRIMARY KEY, invoice_id TEXT)');
legacy.exec("INSERT INTO invoices VALUES ('inv-old', 'co1', 'INV-1', '2026-01-01T00:00:00.000Z')");
legacy.exec("INSERT INTO invoices VALUES ('inv-new', 'co1', 'INV-1', '2026-01-02T00:00:00.000Z')");
legacy.exec("INSERT INTO invoice_lines VALUES ('line-dupe', 'inv-new')");
legacy.exec("INSERT INTO approvals VALUES ('appr-dupe', 'inv-new')");
legacy.close();

process.env.KHATAOS_DB = TEST_DB;

const assert = require('assert');
const { all, get, run } = require('../server/src/db');
const { createRouter } = require('../server/src/api');
const { nowIso } = require('../server/src/util');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

function invoke(handler, params, user) {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(code, headers) { this.code = code; },
      end(body) { try { resolve({ code: this.code, body: JSON.parse(body) }); } catch (e) { reject(e); } },
    };
    handler({ url: '/api/invoices/capture', headers: {}, body: {} }, res, params, user).catch(reject);
  });
}

(async () => {
  await check('migration: duplicate invoices are deduped, keeping the earliest', async () => {
    const rows = await all('SELECT id FROM invoices WHERE company_id = ?', ['co1']);
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    assert.strictEqual(rows[0].id, 'inv-old');
  });

  await check('migration: dependent rows of deduped invoices are removed', async () => {
    assert.strictEqual((await all('SELECT id FROM invoice_lines WHERE invoice_id = ?', ['inv-new'])).length, 0);
    assert.strictEqual((await all('SELECT id FROM approvals WHERE invoice_id = ?', ['inv-new'])).length, 0);
  });

  await check('migration: schema_migrations records versions 1 and 2 exactly once', async () => {
    const rows = await all('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepStrictEqual(rows.map((r) => r.version), [1, 2]);
  });

  await check('migration: the unique index now rejects duplicate invoice numbers', async () => {
    let threw = false;
    try {
      await run("INSERT INTO invoices (id, company_id, invoice_no, created_at) VALUES ('inv-x', 'co1', 'INV-1', '2026-01-03T00:00:00.000Z')");
    } catch (e) { threw = /unique|constraint/i.test(String(e.message)); }
    assert.ok(threw, 'expected a unique-constraint failure');
  });

  await check('api: capture route rejects a duplicate invoice number with 409', async () => {
    const router = createRouter();
    const found = router.find('POST', '/api/invoices/capture');
    const user = { id: 'u1', company_id: 'co1', role: 'finance_executive', name: 'Exec' };
    const req = { url: '/api/invoices/capture', headers: {}, body: { invoice_no: 'INV-1', taxable_amount: 1000, cgst: 90, sgst: 90, igst: 0, gross_amount: 1180 } };
    let status = null;
    try {
      await found.handler(req, { writeHead() {}, end() {} }, found.params, user);
    } catch (e) { status = e.status; }
    assert.strictEqual(status, 409, 'expected 409 for duplicate invoice_no');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
