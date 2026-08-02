'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.KHATAOS_DB || path.join(DATA_DIR, 'khataos.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

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
  type TEXT NOT NULL DEFAULT 'current',          -- current | savings | cash_credit
  ifsc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',          -- active | consent_expired | failed
  source TEXT NOT NULL,                          -- 'aa' | 'direct_api'
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
  amount REAL NOT NULL,                          -- signed: credit positive
  balance_after REAL,
  description TEXT,
  mode TEXT,                                     -- NEFT | IMPS | UPI | RTGS | CHQ | DD | CASH
  ref_no TEXT,
  status TEXT NOT NULL DEFAULT 'posted',          -- posted | uncleared
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
  source TEXT NOT NULL,                          -- email | pdf_upload | manual
  status TEXT NOT NULL,                          -- captured | validation_failed | pending_approval | approved | rejected | paid | scheduled
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
  three_way_match TEXT,                          -- none | matched | mismatch
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
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | approved | rejected
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
  mode TEXT NOT NULL,                            -- UPI | IMPS | NEFT | RTGS
  type TEXT NOT NULL,                            -- batch | scheduled | instant
  status TEXT NOT NULL,                          -- draft | pending_approval | approved | pending | processing | completed | failed
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
  match_type TEXT NOT NULL,                      -- exact | fuzzy | combined | manual
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'matched',
  matched_by TEXT,
  matched_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS gstr2b_snapshots (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  period TEXT NOT NULL,                          -- YYYY-MM
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
  entity TEXT NOT NULL,                          -- ledger | voucher | payment | receipt | po | gstr2b
  entity_id TEXT,
  action TEXT NOT NULL,                          -- push | pull | create | update
  status TEXT NOT NULL,                          -- queued | synced | failed | retrying
  error TEXT,
  queued_at TEXT,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS tally_health (
  company_id TEXT PRIMARY KEY,
  last_sync_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'connected',       -- connected | degraded | disconnected
  queue_depth INTEGER DEFAULT 0,
  version TEXT DEFAULT 'TallyPrime 4.2',
  mode TEXT DEFAULT 'single-user',
  uptime_30d REAL DEFAULT 99.6,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS onboarding_steps (
  company_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | done
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
  status TEXT NOT NULL DEFAULT 'queued',          -- queued | running | done | failed
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
`;

db.exec(SCHEMA);

// ---- tiny query helpers ----
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }

// Insert an object into a table. Returns lastInsertRowid.
function insert(table, obj) {
  const keys = Object.keys(obj);
  const cols = keys.join(', ');
  const marks = keys.map(() => '?').join(', ');
  const res = run(`INSERT INTO ${table} (${cols}) VALUES (${marks})`, keys.map(k => obj[k]));
  return res.lastInsertRowid;
}

// Simple update by id
function update(table, id, obj) {
  const keys = Object.keys(obj);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...keys.map(k => obj[k]), id]);
}

module.exports = { db, all, get, run, insert, update, DB_PATH };
