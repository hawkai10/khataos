'use strict';

// ============================================================================
// Storage layer — one API, three engines:
//   sqlite   (default)  — zero-setup dev/demo database (node:sqlite)
//   pglite              — in-process PostgreSQL (WASM), for dev/testing
//   postgres            — real PostgreSQL server (KHATAOS_DATABASE_URL)
//
// Every module talks through { all, get, run, insert, update } — async in all
// engines — so switching databases is a configuration change, not a code one.
// ============================================================================

const path = require('path');
const fs = require('fs');
const os = require('os');

const ENGINE = process.env.KHATAOS_DB_ENGINE || 'sqlite';
const DATABASE_URL = process.env.KHATAOS_DATABASE_URL || '';
const DATA_DIR = path.join(__dirname, '..', 'data');
const PRIMARY_DB = process.env.KHATAOS_DB || path.join(DATA_DIR, 'khataos.db');

let DB_PATH = PRIMARY_DB;
let DB_ENGINE = ENGINE === 'sqlite' ? 'sqlite' : ENGINE === 'pglite' ? 'pglite' : ENGINE === 'postgres' || /^postgres(ql)?:\/\//.test(DATABASE_URL) ? 'postgres' : ENGINE;

function probeWritable(dir) {
  try {
    const probe = path.join(dir, `.khataos-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

// ---- shared schema (SQLite flavour) ----
const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT,
  pan TEXT,
  city TEXT,
  plan TEXT DEFAULT 'standard',
  trial_ends_at TEXT,
  settings TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cfo','finance_manager','finance_executive')),
  department TEXT,
  active INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'aa',
  aa_supported INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  bank_code TEXT NOT NULL REFERENCES banks(code),
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'current',
  ifsc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL,
  consent_id TEXT,
  last_synced_at TEXT,
  opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  external_id TEXT,
  txn_date TEXT NOT NULL,
  value_date TEXT,
  amount REAL NOT NULL,
  balance_after REAL,
  description TEXT,
  mode TEXT,
  ref_no TEXT,
  status TEXT NOT NULL DEFAULT 'posted',
  matched INTEGER DEFAULT 0,
  matched_id TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, external_id)
);

CREATE TABLE IF NOT EXISTS cash_daily (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  closing_balance REAL NOT NULL,
  source TEXT DEFAULT 'aa',
  UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  gstin TEXT,
  pan TEXT,
  bank_account TEXT,
  ifsc TEXT,
  upi_id TEXT,
  email TEXT,
  ledger_name TEXT NOT NULL,
  tds_section TEXT,
  tds_rate REAL DEFAULT 0,
  credit_days INTEGER DEFAULT 30,
  category TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  invoice_no TEXT NOT NULL,
  vendor_id TEXT REFERENCES vendors(id),
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  gross_amount REAL NOT NULL DEFAULT 0,
  taxable_amount REAL NOT NULL DEFAULT 0,
  cgst REAL DEFAULT 0,
  sgst REAL DEFAULT 0,
  igst REAL DEFAULT 0,
  cess REAL DEFAULT 0,
  tds_amount REAL DEFAULT 0,
  net_payable REAL DEFAULT 0,
  gstin_vendor TEXT,
  hsns TEXT DEFAULT '[]',
  purchase_order_no TEXT,
  receipt_note_no TEXT,
  three_way_match TEXT,
  ocr_json TEXT,
  notes TEXT,
  currency TEXT DEFAULT 'INR',
  created_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  hsn TEXT,
  description TEXT,
  qty REAL DEFAULT 1,
  rate REAL DEFAULT 0,
  taxable REAL DEFAULT 0,
  cgst REAL DEFAULT 0,
  sgst REAL DEFAULT 0,
  igst REAL DEFAULT 0,
  cess REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  level INTEGER NOT NULL DEFAULT 1,
  required_role TEXT,
  threshold_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approver_id TEXT,
  approver_name TEXT,
  comment TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  vendor_id TEXT REFERENCES vendors(id),
  invoice_ids TEXT DEFAULT '[]',
  amount REAL NOT NULL,
  mode TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_date TEXT,
  bank_account_id TEXT,
  reference TEXT,
  gateway TEXT,
  gateway_txn_id TEXT,
  gst_ledger TEXT,
  tds_section TEXT,
  tds_amount REAL DEFAULT 0,
  net_amount REAL NOT NULL,
  initiated_by TEXT,
  approved_by TEXT,
  failure_reason TEXT,
  initiated_at TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recon_matches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  bank_txn_id TEXT NOT NULL REFERENCES bank_transactions(id),
  payment_id TEXT,
  tally_voucher_no TEXT,
  match_type TEXT NOT NULL,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'matched',
  matched_by TEXT,
  matched_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS gstr2b_snapshots (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  period TEXT NOT NULL,
  gstin TEXT,
  total_itc REAL DEFAULT 0,
  itc_cgst REAL DEFAULT 0,
  itc_sgst REAL DEFAULT 0,
  itc_igst REAL DEFAULT 0,
  data_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'gstr2b',
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gst_mismatches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  period TEXT NOT NULL,
  invoice_no TEXT,
  vendor_gstin TEXT,
  vendor_name TEXT,
  platform_amount REAL DEFAULT 0,
  gstr2b_amount REAL DEFAULT 0,
  variance REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  note TEXT
);

CREATE TABLE IF NOT EXISTS tally_sync_logs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  queued_at TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS tally_health (
  company_id TEXT PRIMARY KEY,
  last_sync_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  queue_depth INTEGER DEFAULT 0,
  version TEXT DEFAULT 'TallyPrime 4.2',
  mode TEXT DEFAULT 'single-user',
  uptime_30d REAL DEFAULT 99.6,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS onboarding_steps (
  company_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  at TEXT,
  PRIMARY KEY (company_id, step)
);

CREATE TABLE IF NOT EXISTS email_inbox (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  from_email TEXT,
  subject TEXT,
  body TEXT,
  attachments TEXT DEFAULT '[]',
  received_at TEXT NOT NULL,
  processed INTEGER DEFAULT 0,
  invoice_id TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER DEFAULT 0,
  run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_daily (
  company_id TEXT NOT NULL,
  date TEXT NOT NULL,
  dau INTEGER DEFAULT 0,
  mau INTEGER DEFAULT 0,
  PRIMARY KEY (company_id, date)
);

CREATE TABLE IF NOT EXISTS decentro_links (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  account_number TEXT NOT NULL,
  mobile TEXT,
  customer_id TEXT,
  bank_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decentro_txn_id TEXT,
  redirect_url TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  linked_at TEXT
);

CREATE TABLE IF NOT EXISTS tally_groups (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent TEXT,
  tally_guid TEXT,
  tally_alterid INTEGER DEFAULT 0,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS tally_ledgers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  group_name TEXT,
  opening_balance REAL DEFAULT 0,
  gstin TEXT,
  tally_guid TEXT,
  tally_alterid INTEGER DEFAULT 0,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS tally_vouchers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  voucher_number TEXT,
  voucher_type TEXT,
  date TEXT,
  amount REAL DEFAULT 0,
  party_name TEXT,
  entry_json TEXT DEFAULT '[]',
  tally_guid TEXT,
  tally_alterid INTEGER DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_vouchers_guid ON tally_vouchers(company_id, tally_guid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_ledgers_guid ON tally_ledgers(company_id, tally_guid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_groups_guid ON tally_groups(company_id, tally_guid);
`;

// Startup migrations for databases created before these columns existed.
// ALTER TABLE ADD COLUMN errors are ignored when the column is already there.
const MIGRATIONS = [
  'ALTER TABLE tally_vouchers ADD COLUMN tally_guid TEXT',
  'ALTER TABLE tally_vouchers ADD COLUMN tally_alterid INTEGER DEFAULT 0',
  'ALTER TABLE tally_vouchers ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE tally_ledgers ADD COLUMN tally_guid TEXT',
  'ALTER TABLE tally_ledgers ADD COLUMN tally_alterid INTEGER DEFAULT 0',
  'ALTER TABLE tally_groups ADD COLUMN tally_guid TEXT',
  'ALTER TABLE tally_groups ADD COLUMN tally_alterid INTEGER DEFAULT 0',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_vouchers_guid ON tally_vouchers(company_id, tally_guid)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_ledgers_guid ON tally_ledgers(company_id, tally_guid)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_groups_guid ON tally_groups(company_id, tally_guid)',
];

function runMigrations(exec) {
  for (const sql of MIGRATIONS) {
    try { exec(sql); } catch { /* column/index already exists */ }
  }
}

async function runMigrationsAsync(exec) {
  for (const sql of MIGRATIONS) {
    try { await exec(sql); } catch { /* column/index already exists */ }
  }
}

// PostgreSQL flavour: amounts as double precision so they return as JS numbers
// (identical to SQLite REAL semantics); flags stay INTEGER so `= 1` checks
// keep working; dates/timestamps stay TEXT for identical formatting.
const PG_SCHEMA = SCHEMA.replace(/\bREAL\b/g, 'DOUBLE PRECISION');

// translate ? placeholders to $1..$n for PostgreSQL
function translate(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ---- engine implementations ----
let impl = null;
let ready;

if (DB_ENGINE === 'sqlite') {
  const { DatabaseSync } = require('node:sqlite');
  let sqliteDb;
  try {
    if (!fs.existsSync(path.dirname(PRIMARY_DB))) fs.mkdirSync(path.dirname(PRIMARY_DB), { recursive: true });
    if (!probeWritable(path.dirname(PRIMARY_DB))) throw new Error('directory not writable');
    sqliteDb = new DatabaseSync(PRIMARY_DB);
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    sqliteDb.exec(SCHEMA);
    runMigrations((sql) => sqliteDb.exec(sql));
  } catch (err) {
    const fallbackDir = path.join(os.tmpdir(), 'khataos-data');
    fs.mkdirSync(fallbackDir, { recursive: true });
    DB_PATH = path.join(fallbackDir, 'khataos.db');
    if (!probeWritable(fallbackDir)) {
      console.error(`[db] Fatal: cannot open ${PRIMARY_DB} (${err.message}) or ${DB_PATH}`);
      process.exit(1);
    }
    sqliteDb = new DatabaseSync(DB_PATH);
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    sqliteDb.exec(SCHEMA);
    runMigrations((sql) => sqliteDb.exec(sql));
    console.warn(`[db] Could not open ${PRIMARY_DB} (${err.message}). Using ${DB_PATH} instead.`);
  }
  impl = {
    all: (sql, params) => sqliteDb.prepare(sql).all(...params),
    get: (sql, params) => sqliteDb.prepare(sql).get(...params) || null,
    run: (sql, params) => sqliteDb.prepare(sql).run(...params),
    exec: (sql) => sqliteDb.exec(sql),
  };
  ready = Promise.resolve();
} else {
  // pglite or postgres — async init
  ready = (async () => {
    let client;
    if (DB_ENGINE === 'postgres') {
      const { Pool } = require('pg');
      client = new Pool({ connectionString: DATABASE_URL, max: 10 });
      await client.query(PG_SCHEMA);
      await runMigrationsAsync((sql) => client.query(sql));
      impl = {
        all: async (sql, params) => (await client.query(translate(sql), params)).rows,
        get: async (sql, params) => (await client.query(translate(sql), params)).rows[0] || null,
        run: async (sql, params) => { const r = await client.query(translate(sql), params); return { lastInsertRowid: null, rowCount: r.rowCount }; },
        exec: async (sql) => { await client.query(sql); },
      };
    } else {
      const { PGlite } = require('@electric-sql/pglite');
      const pgliteDir = process.env.KHATAOS_PGLITE_DIR ? path.resolve(process.env.KHATAOS_PGLITE_DIR) : null;
      client = pgliteDir && probeWritable(path.dirname(pgliteDir) || '.')
        ? new PGlite(pgliteDir)
        : new PGlite();
      DB_PATH = pgliteDir || '(in-memory pglite)';
      await client.exec(PG_SCHEMA);
      await runMigrationsAsync((sql) => client.exec(sql));
      impl = {
        all: async (sql, params) => (await client.query(translate(sql), params)).rows,
        get: async (sql, params) => (await client.query(translate(sql), params)).rows[0] || null,
        run: async (sql, params) => { const r = await client.query(translate(sql), params); return { lastInsertRowid: null, rowCount: r.rowCount }; },
        exec: async (sql) => { await client.exec(sql); },
      };
    }
    if (DB_ENGINE === 'postgres') console.log(`[db] connected to PostgreSQL: ${DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@')}`);
    else console.log(`[db] using in-process PostgreSQL (pglite): ${DB_PATH}`);
  })().catch((err) => {
    console.error(`[db] Fatal: could not initialize ${DB_ENGINE} database: ${err.message}`);
    process.exit(1);
  });
}

// ---- public async helpers (engine-agnostic) ----
async function all(sql, params = []) { await ready; return impl.all(sql, params); }
async function get(sql, params = []) { await ready; return impl.get(sql, params); }
async function run(sql, params = []) { await ready; return impl.run(sql, params); }
async function exec(sql) { await ready; return impl.exec(sql); }

async function insert(table, obj) {
  await ready;
  const keys = Object.keys(obj);
  const cols = keys.join(', ');
  const marks = keys.map((_, i) => (DB_ENGINE === 'sqlite' ? '?' : `$${i + 1}`)).join(', ');
  await impl.run(`INSERT INTO ${table} (${cols}) VALUES (${marks})`, keys.map(k => obj[k]));
  return { lastInsertRowid: null };
}

async function update(table, id, obj) {
  await ready;
  const keys = Object.keys(obj);
  const mark = (i) => (DB_ENGINE === 'sqlite' ? '?' : `$${i}`);
  const sets = keys.map((k, i) => `${k} = ${mark(i + 1)}`).join(', ');
  await impl.run(`UPDATE ${table} SET ${sets} WHERE id = ${mark(keys.length + 1)}`, [...keys.map(k => obj[k]), id]);
}

// ---- introspection (System Health page + tests) ----
async function listTables() {
  await ready;
  if (DB_ENGINE === 'sqlite') return (await impl.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`, [])).map(r => r.name);
  return (await impl.all(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY name`, [])).map(r => r.name);
}

async function countRows(table) {
  await ready;
  if (!/^[a-z0-9_]+$/.test(table)) throw new Error('invalid table name');
  const r = await impl.get(`SELECT COUNT(*) AS c FROM "${table}"`, []);
  return Number(r ? r.c : 0);
}

module.exports = { all, get, run, insert, update, exec, listTables, countRows, DB_PATH, DB_ENGINE, DATABASE_URL };
