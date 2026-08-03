-- Production schema start (PostgreSQL). Mirrors the SQLite dev model; the
-- migration path is mechanical because the dev build already uses the same
-- relational model and SQL dialect subset.

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT,
  pan TEXT,
  city TEXT,
  plan TEXT DEFAULT 'standard',
  trial_ends_at TIMESTAMPTZ,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cfo','finance_manager','finance_executive')),
  department TEXT,
  active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  bank_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  type TEXT DEFAULT 'current',
  ifsc TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  source TEXT NOT NULL CHECK (source IN ('aa','direct_api')),
  consent_id TEXT,
  last_synced_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_company ON bank_accounts(company_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  external_id TEXT NOT NULL,
  txn_date DATE NOT NULL,
  value_date DATE,
  amount NUMERIC(16,2) NOT NULL,
  balance_after NUMERIC(16,2),
  description TEXT,
  mode TEXT,
  ref_no TEXT,
  status TEXT DEFAULT 'posted',
  matched BOOLEAN DEFAULT FALSE,
  matched_id TEXT,
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_txn_company_date ON bank_transactions(company_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_unmatched ON bank_transactions(company_id, status, matched) WHERE matched = FALSE;

-- invoices / invoice_lines / approvals / payments / recon_matches /
-- gstr2b_snapshots / gst_mismatches / tally_sync_logs / tally_health /
-- onboarding_steps / email_inbox / jobs / audit_logs follow the same shape
-- as the dev schema (server/src/db.js). Amounts are NUMERIC(16,2), timestamps
-- TIMESTAMPTZ, JSON payloads JSONB, and every table is tenant-scoped by
-- company_id with a matching index.
