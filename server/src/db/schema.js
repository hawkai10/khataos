'use strict';

// ============================================================================
// Explicit Drizzle schema. Both dialects (SQLite + PostgreSQL) are generated
// from ONE declarative descriptor so they can never drift from each other;
// the descriptor mirrors server/src/db.js's SCHEMA string (the authoritative
// source until the cutover completes). Column keys use the exact database
// column names, so query results keep their current shapes byte-for-byte.
//
// Types: 'text' -> TEXT, 'money' -> INTEGER (SQLite) / BIGINT (PG) paise,
// 'real' -> REAL (SQLite) / DOUBLE PRECISION (PG) for rates/quantities,
// 'integer' -> INTEGER. Flags are INTEGER (never native booleans) so the
// existing `= 1` checks keep working identically on every engine.
// ============================================================================

const { sqliteTable, text: sqliteText, integer: sqliteInteger, real: sqliteReal, index: sqliteIndex, uniqueIndex: sqliteUniqueIndex, unique: sqliteUnique, primaryKey: sqlitePrimaryKey, check: sqliteCheck } = require('drizzle-orm/sqlite-core');
const { pgTable, text: pgText, integer: pgInteger, bigint: pgBigint, doublePrecision, index: pgIndex, uniqueIndex: pgUniqueIndex, unique: pgUnique, primaryKey: pgPrimaryKey, check: pgCheck } = require('drizzle-orm/pg-core');
const { sql } = require('drizzle-orm');

const TABLES = [
  {
    name: 'companies',
    columns: {
      id: { type: 'text', pk: true },
      name: { type: 'text', notNull: true },
      gstin: { type: 'text' },
      pan: { type: 'text' },
      city: { type: 'text' },
      plan: { type: 'text', default: 'standard' },
      trial_ends_at: { type: 'text' },
      settings: { type: 'text', default: '{}' },
      created_at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'users',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true, ref: ['companies', 'id'] },
      name: { type: 'text', notNull: true },
      email: { type: 'text', notNull: true },
      password: { type: 'text', notNull: true },
      role: { type: 'text', notNull: true },
      department: { type: 'text' },
      active: { type: 'integer', default: 1 },
      last_login_at: { type: 'text' },
      created_at: { type: 'text', notNull: true },
    },
    checks: [{ name: 'users_role_check', expr: (t) => sql`${t.role} IN ('cfo','finance_manager','finance_executive')` }],
  },
  {
    name: 'sessions',
    columns: {
      token: { type: 'text', pk: true },
      user_id: { type: 'text', notNull: true, ref: ['users', 'id'] },
      created_at: { type: 'text', notNull: true },
      expires_at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'audit_logs',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      user_id: { type: 'text' },
      user_name: { type: 'text' },
      action: { type: 'text', notNull: true },
      entity: { type: 'text' },
      entity_id: { type: 'text' },
      details: { type: 'text' },
      at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'banks',
    columns: {
      code: { type: 'text', pk: true },
      name: { type: 'text', notNull: true },
      kind: { type: 'text', notNull: true, default: 'aa' },
      aa_supported: { type: 'integer', default: 1 },
    },
  },
  {
    name: 'bank_accounts',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true, ref: ['companies', 'id'] },
      bank_code: { type: 'text', notNull: true, ref: ['banks', 'code'] },
      account_name: { type: 'text', notNull: true },
      account_number: { type: 'text', notNull: true },
      type: { type: 'text', notNull: true, default: 'current' },
      ifsc: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'active' },
      source: { type: 'text', notNull: true },
      consent_id: { type: 'text' },
      last_synced_at: { type: 'text' },
      opened_at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'bank_transactions',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      account_id: { type: 'text', notNull: true, ref: ['bank_accounts', 'id'] },
      external_id: { type: 'text' },
      txn_date: { type: 'text', notNull: true },
      value_date: { type: 'text' },
      amount: { type: 'money', notNull: true },
      balance_after: { type: 'money' },
      description: { type: 'text' },
      mode: { type: 'text' },
      ref_no: { type: 'text' },
      status: { type: 'text', notNull: true, default: 'posted' },
      matched: { type: 'integer', default: 0 },
      matched_id: { type: 'text' },
      raw_json: { type: 'text' },
      created_at: { type: 'text', notNull: true },
    },
    uniques: [{ name: 'bank_transactions_account_external', cols: ['account_id', 'external_id'] }],
  },
  {
    name: 'cash_daily',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      account_id: { type: 'text', notNull: true },
      date: { type: 'text', notNull: true },
      closing_balance: { type: 'money', notNull: true },
      source: { type: 'text', default: 'aa' },
    },
    uniques: [{ name: 'cash_daily_account_date', cols: ['account_id', 'date'] }],
  },
  {
    name: 'vendors',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true, ref: ['companies', 'id'] },
      name: { type: 'text', notNull: true },
      gstin: { type: 'text' },
      pan: { type: 'text' },
      bank_account: { type: 'text' },
      ifsc: { type: 'text' },
      upi_id: { type: 'text' },
      email: { type: 'text' },
      ledger_name: { type: 'text', notNull: true },
      tds_section: { type: 'text' },
      tds_rate: { type: 'real', default: 0 },
      tds_on_gross: { type: 'integer', default: 0 },
      tds_cert_rate: { type: 'real' },
      credit_days: { type: 'integer', default: 30 },
      category: { type: 'text' },
      active: { type: 'integer', default: 1 },
    },
  },
  {
    name: 'invoices',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true, ref: ['companies', 'id'] },
      invoice_no: { type: 'text', notNull: true },
      vendor_id: { type: 'text', ref: ['vendors', 'id'] },
      invoice_date: { type: 'text', notNull: true },
      due_date: { type: 'text' },
      source: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      gross_amount: { type: 'money', notNull: true, default: 0 },
      taxable_amount: { type: 'money', notNull: true, default: 0 },
      cgst: { type: 'money', default: 0 },
      sgst: { type: 'money', default: 0 },
      igst: { type: 'money', default: 0 },
      cess: { type: 'money', default: 0 },
      tds_amount: { type: 'money', default: 0 },
      net_payable: { type: 'money', default: 0 },
      gstin_vendor: { type: 'text' },
      hsns: { type: 'text', default: '[]' },
      purchase_order_no: { type: 'text' },
      receipt_note_no: { type: 'text' },
      three_way_match: { type: 'text' },
      ocr_json: { type: 'text' },
      notes: { type: 'text' },
      currency: { type: 'text', default: 'INR' },
      created_by: { type: 'text' },
      approved_by: { type: 'text' },
      approved_at: { type: 'text' },
      paid_at: { type: 'text' },
      created_at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'invoice_lines',
    columns: {
      id: { type: 'text', pk: true },
      invoice_id: { type: 'text', notNull: true, ref: ['invoices', 'id'] },
      hsn: { type: 'text' },
      description: { type: 'text' },
      qty: { type: 'real', default: 1 },
      rate: { type: 'money', default: 0 },
      taxable: { type: 'money', default: 0 },
      cgst: { type: 'money', default: 0 },
      sgst: { type: 'money', default: 0 },
      igst: { type: 'money', default: 0 },
      cess: { type: 'money', default: 0 },
    },
  },
  {
    name: 'approvals',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      invoice_id: { type: 'text', notNull: true, ref: ['invoices', 'id'] },
      level: { type: 'integer', notNull: true, default: 1 },
      required_role: { type: 'text' },
      threshold_note: { type: 'text' },
      status: { type: 'text', notNull: true, default: 'pending' },
      approver_id: { type: 'text' },
      approver_name: { type: 'text' },
      comment: { type: 'text' },
      decided_at: { type: 'text' },
    },
  },
  {
    name: 'payments',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true, ref: ['companies', 'id'] },
      vendor_id: { type: 'text', ref: ['vendors', 'id'] },
      invoice_ids: { type: 'text', default: '[]' },
      amount: { type: 'money', notNull: true },
      mode: { type: 'text', notNull: true },
      type: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      scheduled_date: { type: 'text' },
      bank_account_id: { type: 'text' },
      reference: { type: 'text' },
      gateway: { type: 'text' },
      gateway_txn_id: { type: 'text' },
      gst_ledger: { type: 'text' },
      tds_section: { type: 'text' },
      tds_amount: { type: 'money', default: 0 },
      net_amount: { type: 'money', notNull: true },
      initiated_by: { type: 'text' },
      approved_by: { type: 'text' },
      failure_reason: { type: 'text' },
      initiated_at: { type: 'text' },
      processed_at: { type: 'text' },
      created_at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'payment_state_transitions',
    columns: {
      id: { type: 'text', pk: true },
      payment_id: { type: 'text', notNull: true, ref: ['payments', 'id'] },
      company_id: { type: 'text', notNull: true },
      from_status: { type: 'text' },
      to_status: { type: 'text', notNull: true },
      action: { type: 'text' },
      changed_by: { type: 'text' },
      at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'idempotency_keys',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      key: { type: 'text', notNull: true },
      method: { type: 'text', notNull: true },
      route: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'processing' },
      response_status: { type: 'integer' },
      response_body: { type: 'text' },
      created_at: { type: 'text', notNull: true },
      completed_at: { type: 'text' },
    },
    uniques: [{ name: 'idempotency_keys_company_key', cols: ['company_id', 'key'] }],
  },
  {
    name: 'recon_matches',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      bank_txn_id: { type: 'text', notNull: true, ref: ['bank_transactions', 'id'] },
      payment_id: { type: 'text' },
      tally_voucher_no: { type: 'text' },
      match_type: { type: 'text', notNull: true },
      confidence: { type: 'real' },
      status: { type: 'text', notNull: true, default: 'matched' },
      matched_by: { type: 'text' },
      matched_at: { type: 'text' },
      notes: { type: 'text' },
    },
  },
  {
    name: 'gstr2b_snapshots',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      period: { type: 'text', notNull: true },
      gstin: { type: 'text' },
      total_itc: { type: 'money', default: 0 },
      itc_cgst: { type: 'money', default: 0 },
      itc_sgst: { type: 'money', default: 0 },
      itc_igst: { type: 'money', default: 0 },
      data_json: { type: 'text', default: '[]' },
      cdnr_json: { type: 'text', default: '[]' },
      source: { type: 'text', default: 'gstr2b' },
      fetched_at: { type: 'text', notNull: true },
    },
  },
  {
    name: 'gst_mismatches',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      period: { type: 'text', notNull: true },
      invoice_no: { type: 'text' },
      vendor_gstin: { type: 'text' },
      vendor_name: { type: 'text' },
      platform_amount: { type: 'money', default: 0 },
      gstr2b_amount: { type: 'money', default: 0 },
      variance: { type: 'money', default: 0 },
      status: { type: 'text', default: 'open' },
      note: { type: 'text' },
    },
  },
  {
    name: 'tally_sync_logs',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      entity: { type: 'text', notNull: true },
      entity_id: { type: 'text' },
      action: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      error: { type: 'text' },
      queued_at: { type: 'text' },
      synced_at: { type: 'text' },
    },
  },
  {
    name: 'tally_health',
    columns: {
      company_id: { type: 'text', pk: true },
      last_sync_at: { type: 'text' },
      last_success_at: { type: 'text' },
      status: { type: 'text', notNull: true, default: 'unavailable' },
      queue_depth: { type: 'integer', default: 0 },
      version: { type: 'text', default: 'TallyPrime 4.2' },
      mode: { type: 'text' },
      uptime_30d: { type: 'real' },
      last_error: { type: 'text' },
    },
  },
  {
    name: 'onboarding_steps',
    columns: {
      company_id: { type: 'text', notNull: true },
      step: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'pending' },
      detail: { type: 'text' },
      at: { type: 'text' },
    },
    primaryKey: ['company_id', 'step'],
  },
  {
    name: 'email_inbox',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      from_email: { type: 'text' },
      subject: { type: 'text' },
      body: { type: 'text' },
      attachments: { type: 'text', default: '[]' },
      received_at: { type: 'text', notNull: true },
      processed: { type: 'integer', default: 0 },
      invoice_id: { type: 'text' },
    },
  },
  {
    name: 'jobs',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      type: { type: 'text', notNull: true },
      payload: { type: 'text', default: '{}' },
      status: { type: 'text', notNull: true, default: 'queued' },
      attempts: { type: 'integer', default: 0 },
      run_at: { type: 'text' },
      last_error: { type: 'text' },
      created_at: { type: 'text', notNull: true },
      finished_at: { type: 'text' },
    },
  },
  {
    name: 'usage_daily',
    columns: {
      company_id: { type: 'text', notNull: true },
      date: { type: 'text', notNull: true },
      dau: { type: 'integer', default: 0 },
      mau: { type: 'integer', default: 0 },
    },
    primaryKey: ['company_id', 'date'],
  },
  {
    name: 'decentro_links',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true, ref: ['companies', 'id'] },
      account_number: { type: 'text', notNull: true },
      mobile: { type: 'text' },
      customer_id: { type: 'text' },
      bank_code: { type: 'text' },
      status: { type: 'text', notNull: true, default: 'pending' },
      decentro_txn_id: { type: 'text' },
      redirect_url: { type: 'text' },
      last_error: { type: 'text' },
      created_at: { type: 'text', notNull: true },
      linked_at: { type: 'text' },
    },
  },
  {
    name: 'tally_groups',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      name: { type: 'text', notNull: true },
      parent: { type: 'text' },
      tally_guid: { type: 'text' },
      tally_alterid: { type: 'integer', default: 0 },
    },
    uniques: [{ name: 'tally_groups_company_name', cols: ['company_id', 'name'] }],
  },
  {
    name: 'tally_ledgers',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      name: { type: 'text', notNull: true },
      group_name: { type: 'text' },
      opening_balance: { type: 'money', default: 0 },
      gstin: { type: 'text' },
      tally_guid: { type: 'text' },
      tally_alterid: { type: 'integer', default: 0 },
    },
    uniques: [{ name: 'tally_ledgers_company_name', cols: ['company_id', 'name'] }],
  },
  {
    name: 'tally_vouchers',
    columns: {
      id: { type: 'text', pk: true },
      company_id: { type: 'text', notNull: true },
      voucher_number: { type: 'text' },
      voucher_type: { type: 'text' },
      date: { type: 'text' },
      amount: { type: 'money', default: 0 },
      party_name: { type: 'text' },
      entry_json: { type: 'text', default: '[]' },
      tally_guid: { type: 'text' },
      tally_alterid: { type: 'integer', default: 0 },
      cancelled: { type: 'integer', notNull: true, default: 0 },
      imported_at: { type: 'text', notNull: true },
    },
  },
];

// Indexes currently created by db.js SCHEMA + the versioned migrations
// (v1 invoice uniqueness, v2 composite indexes, and the Tally GUID indexes).
const INDEXES = [
  { name: 'idx_tally_vouchers_guid', unique: true, table: 'tally_vouchers', cols: ['company_id', 'tally_guid'] },
  { name: 'idx_tally_ledgers_guid', unique: true, table: 'tally_ledgers', cols: ['company_id', 'tally_guid'] },
  { name: 'idx_tally_groups_guid', unique: true, table: 'tally_groups', cols: ['company_id', 'tally_guid'] },
  { name: 'idx_invoices_company_no', unique: true, table: 'invoices', cols: ['company_id', 'invoice_no'] },
  { name: 'idx_invoices_company_status', table: 'invoices', cols: ['company_id', 'status'] },
  { name: 'idx_invoices_company_date', table: 'invoices', cols: ['company_id', 'invoice_date'] },
  { name: 'idx_btx_company_matched', table: 'bank_transactions', cols: ['company_id', 'matched', 'status', 'txn_date'] },
  { name: 'idx_btx_company_txndate', table: 'bank_transactions', cols: ['company_id', 'txn_date'] },
  { name: 'idx_gst_mm_company_status', table: 'gst_mismatches', cols: ['company_id', 'status'] },
  { name: 'idx_tv_company_type', table: 'tally_vouchers', cols: ['company_id', 'voucher_type', 'cancelled'] },
  { name: 'idx_tv_company_date', table: 'tally_vouchers', cols: ['company_id', 'date'] },
  { name: 'idx_g2b_company_period', table: 'gstr2b_snapshots', cols: ['company_id', 'period'] },
  { name: 'idx_cd_account_date', table: 'cash_daily', cols: ['account_id', 'date'] },
  { name: 'idx_payments_company_status', table: 'payments', cols: ['company_id', 'status'] },
  { name: 'idx_pst_payment_at', table: 'payment_state_transitions', cols: ['payment_id', 'at'] },
  { name: 'idx_audit_company_at', table: 'audit_logs', cols: ['company_id', 'at'] },
  { name: 'idx_vendors_company_active', table: 'vendors', cols: ['company_id', 'active'] },
];

// ---- dialect builders ----

function buildSqlite() {
  const tables = {};
  for (const def of TABLES) {
    const cols = {};
    for (const [key, c] of Object.entries(def.columns)) {
      const t = c.type === 'text' ? sqliteText(key) : c.type === 'real' ? sqliteReal(key) : c.type === 'money' ? sqliteInteger(key) : sqliteInteger(key);
      let col = t;
      if (c.notNull) col = col.notNull();
      if (c.default !== undefined) col = col.default(c.default);
      if (c.pk) col = col.primaryKey();
      if (c.ref) col = col.references(() => tables[c.ref[0]][c.ref[1]]);
      cols[key] = col;
    }
    const extras = (t) => {
      const arr = [];
      if (def.primaryKey) arr.push(sqlitePrimaryKey({ columns: def.primaryKey.map((k) => t[k]) }));
      for (const u of def.uniques || []) arr.push(sqliteUnique(u.name).on(...u.cols.map((k) => t[k])));
      for (const c of def.checks || []) arr.push(sqliteCheck(c.name, c.expr(t)));
      for (const ix of INDEXES.filter((i) => i.table === def.name)) {
        const b = ix.unique ? sqliteUniqueIndex(ix.name) : sqliteIndex(ix.name);
        arr.push(b.on(...ix.cols.map((k) => t[k])));
      }
      return arr;
    };
    tables[def.name] = sqliteTable(def.name, cols, (t) => extras(t));
  }
  return tables;
}

function buildPg() {
  const tables = {};
  for (const def of TABLES) {
    const cols = {};
    for (const [key, c] of Object.entries(def.columns)) {
      const t = c.type === 'text' ? pgText(key) : c.type === 'real' ? doublePrecision(key) : c.type === 'money' ? pgBigint(key, { mode: 'number' }) : pgInteger(key);
      let col = t;
      if (c.notNull) col = col.notNull();
      if (c.default !== undefined) col = col.default(c.default);
      if (c.pk) col = col.primaryKey();
      if (c.ref) col = col.references(() => tables[c.ref[0]][c.ref[1]]);
      cols[key] = col;
    }
    const extras = (t) => {
      const arr = [];
      if (def.primaryKey) arr.push(pgPrimaryKey({ columns: def.primaryKey.map((k) => t[k]) }));
      for (const u of def.uniques || []) arr.push(pgUnique(u.name).on(...u.cols.map((k) => t[k])));
      for (const c of def.checks || []) arr.push(pgCheck(c.name, c.expr(t)));
      for (const ix of INDEXES.filter((i) => i.table === def.name)) {
        const b = ix.unique ? pgUniqueIndex(ix.name) : pgIndex(ix.name);
        arr.push(b.on(...ix.cols.map((k) => t[k])));
      }
      return arr;
    };
    tables[def.name] = pgTable(def.name, cols, (t) => extras(t));
  }
  return tables;
}

const sqlite = buildSqlite();
const pg = buildPg();

module.exports = { TABLES, INDEXES, sqlite, pg };
