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

// Per-invocation namespace for the shared parity script. This test file runs
// twice inside one CI job (once in the main suite, once under pg-live.test.js)
// against the same live PostgreSQL, so each invocation must use distinct ids.
const PARITY_NS = 'parity-' + process.pid;

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
    const script = fs.readFileSync(path.join(__dirname, 'fixtures', 'drizzle-parity-script.js'), 'utf8');
    const run = (engine) => {
      const r = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..', 'server'),
        env: { ...process.env, KHATAOS_DB_ENGINE: engine, KHATAOS_PGLITE_DIR: '', PARITY_NS },
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 0, `${engine} child failed: ${r.stderr}`);
      return r.stdout.split('\n').filter((l) => l.startsWith('{')).join('\n');
    };
    const sqliteOut = run('sqlite');
    const pgliteOut = run('pglite');
    assert.strictEqual(pgliteOut, sqliteOut, 'pglite output differs from sqlite');
  });

  await check('drizzle: identical query results on SQLite and live PostgreSQL (PG_LIVE_URL)', () => {
    const url = process.env.PG_LIVE_URL;
    if (!url) return; // only when a real Postgres is wired up
    const script = fs.readFileSync(path.join(__dirname, 'fixtures', 'drizzle-parity-script.js'), 'utf8');
    const run = (env) => {
      const r = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..', 'server'),
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 0, `${env.KHATAOS_DB_ENGINE} child failed: ${r.stderr}`);
      return r.stdout.split('\n').filter((l) => l.startsWith('{')).join('\n');
    };
    const sqliteOut = run({ KHATAOS_DB_ENGINE: 'sqlite', KHATAOS_DATABASE_URL: '', KHATAOS_PGLITE_DIR: '', PARITY_NS });
    const liveOut = run({ KHATAOS_DB_ENGINE: 'postgres', KHATAOS_DATABASE_URL: url, PARITY_NS });
    assert.strictEqual(liveOut, sqliteOut, 'live Postgres output differs from sqlite');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
