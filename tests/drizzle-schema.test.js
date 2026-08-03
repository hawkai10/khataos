'use strict';

// Tests for the Drizzle migration layer:
//   1. the explicit Drizzle schema matches db.js's SCHEMA string exactly
//      (every table, every column, and the recent fix columns intact)
//   2. the same Drizzle queries produce byte-identical results on SQLite and
//      pglite (dates as TEXT, flags as INTEGER, GUID/ALTERID/cancelled)

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'drizzle-schema-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { TABLES, INDEXES, sqlite } = require('../server/src/db/schema');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

function parseSchemaText() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'db.js'), 'utf8');
  const m = src.match(/const SCHEMA = `([\s\S]*?)`;/);
  assert.ok(m, 'SCHEMA template not found');
  const tables = {};
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g;
  let mm;
  while ((mm = re.exec(m[1]))) {
    const cols = [];
    for (const line of mm[2].split('\n')) {
      const cm = line.match(/^\s*(\w+)\s+(TEXT|REAL|INTEGER)/i);
      if (cm) cols.push(cm[1]);
    }
    tables[mm[1]] = cols;
  }
  return tables;
}

(async () => {
  const authoritative = parseSchemaText();

  await check('drizzle schema: every db.js table exists with the same columns', () => {
    const schemaTables = Object.fromEntries(TABLES.map((t) => [t.name, Object.keys(t.columns)]));
    assert.deepStrictEqual(Object.keys(schemaTables).sort(), Object.keys(authoritative).sort());
    for (const [name, cols] of Object.entries(authoritative)) {
      assert.deepStrictEqual(schemaTables[name].sort(), cols.sort(), `columns differ for ${name}`);
    }
  });

  await check('drizzle schema: recent fix columns are present (tally_guid, tally_alterid, cancelled, cdnr_json)', () => {
    assert.ok('tally_guid' in sqlite.tally_vouchers);
    assert.ok('tally_alterid' in sqlite.tally_vouchers);
    assert.ok('cancelled' in sqlite.tally_vouchers);
    assert.ok('cdnr_json' in sqlite.gstr2b_snapshots);
  });

  await check('drizzle schema: every index in the descriptor exists in db.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'db.js'), 'utf8');
    for (const ix of INDEXES) {
      assert.ok(src.includes(ix.name), `index ${ix.name} missing from db.js`);
    }
  });

  await check('drizzle: identical query results on SQLite and pglite', () => {
    const script = `
      const path = require('path');
      const os = require('os');
      const fs = require('fs');
      const dbFile = path.join(os.tmpdir(), 'khataos-data', 'drizzle-parity-' + process.pid + '.db');
      process.env.KHATAOS_DB = dbFile;
      for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
      const db = require('./src/db');
      const schema = require('./src/db/schema');
      (async () => {
        const T = process.env.KHATAOS_DB_ENGINE === 'pglite' ? schema.pg : schema.sqlite;
        const d = await db.getDrizzle();
        await d.insert(T.tally_groups).values({ id: 'g1', company_id: 'c1', name: 'Sundry Creditors', parent: 'Current Liabilities', tally_guid: 'guid-g1', tally_alterid: 1 });
        await d.insert(T.tally_ledgers).values({ id: 'l1', company_id: 'c1', name: 'Vendor A', group_name: 'Sundry Creditors', opening_balance: 92040.5, gstin: '29AABCA1111K1Z5', tally_guid: 'guid-l1', tally_alterid: 3 });
        await d.insert(T.tally_vouchers).values({ id: 'v1', company_id: 'c1', voucher_number: 'PU-1', voucher_type: 'Purchase', date: '2026-07-30', amount: 118000, party_name: 'Vendor A', entry_json: '[]', tally_guid: 'guid-v1', tally_alterid: 7, cancelled: 1, imported_at: '2026-08-03T00:00:00.000Z' });
        await d.insert(T.gstr2b_snapshots).values({ id: 'g2b1', company_id: 'c1', period: '2026-07', gstin: '29AABCA1111K1Z5', total_itc: 18000, itc_cgst: 9000, itc_sgst: 9000, itc_igst: 0, data_json: '[]', cdnr_json: '[{"docno":"CN-1"}]', source: 'gstn-live', fetched_at: '2026-08-03T00:00:00.000Z' });
        const out = {
          groups: await d.select().from(T.tally_groups),
          vouchers: await d.select({ no: T.tally_vouchers.voucher_number, guid: T.tally_vouchers.tally_guid, alt: T.tally_vouchers.tally_alterid, cancelled: T.tally_vouchers.cancelled, amount: T.tally_vouchers.amount }).from(T.tally_vouchers),
          snap: await d.select({ cdnr: T.gstr2b_snapshots.cdnr_json }).from(T.gstr2b_snapshots),
        };
        console.log(JSON.stringify({ vouchers: out.vouchers, snap: out.snap, groups: out.groups }));
        process.exit(0);
      })().catch((e) => { console.error('ERR', e); process.exit(1); });
    `;
    const run = (engine) => {
      const r = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..', 'server'),
        env: { ...process.env, KHATAOS_DB_ENGINE: engine, KHATAOS_PGLITE_DIR: '' },
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 0, `${engine} child failed: ${r.stderr}`);
      return r.stdout.split('\n').filter((l) => l.startsWith('{')).join('\n');
    };
    const sqliteOut = run('sqlite');
    const pgliteOut = run('pglite');
    assert.strictEqual(pgliteOut, sqliteOut, 'pglite output differs from sqlite');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
