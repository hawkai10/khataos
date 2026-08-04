'use strict';

// Shared plumbing for domain plugins: company scoping and query-string parsing.

const { Money } = require('../money');

function companyOf(user) { return user.company_id; }

function parseUrl(req) { return new URL(req.url, 'http://x'); }

function queryParam(u, name, fallback = '') {
  const v = u.searchParams.get(name);
  return v == null ? fallback : v;
}

function queryInt(u, name, fallback) {
  const raw = u.searchParams.get(name);
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Every column that stores money (integer paise). Keep in sync with db.js
// MONEY_COLUMNS and src/db/schema.js 'money' fields.
const MONEY_FIELDS = {
  bank_transactions: ['amount', 'balance_after'],
  cash_daily: ['closing_balance'],
  invoices: ['gross_amount', 'taxable_amount', 'cgst', 'sgst', 'igst', 'cess', 'tds_amount', 'net_payable'],
  invoice_lines: ['rate', 'taxable', 'cgst', 'sgst', 'igst', 'cess'],
  payments: ['amount', 'tds_amount', 'net_amount'],
  gstr2b_snapshots: ['total_itc', 'itc_cgst', 'itc_sgst', 'itc_igst'],
  gst_mismatches: ['platform_amount', 'gstr2b_amount', 'variance'],
  tally_ledgers: ['opening_balance'],
  tally_vouchers: ['amount'],
};

// Exact paise (number | bigint | Money) -> rupee decimal string ("100.99").
function rupees(value) {
  if (value == null) return null;
  return (value instanceof Money ? value : Money.fromPaise(value)).toRupees();
}

// Convert a raw DB row's money columns to rupee strings for API responses.
function publicize(row, table) {
  if (!row) return row;
  for (const f of MONEY_FIELDS[table] || []) {
    if (row[f] != null) row[f] = rupees(row[f]);
  }
  return row;
}

function publicizeRows(rows, table) {
  for (const r of rows || []) publicize(r, table);
  return rows;
}

module.exports = { companyOf, parseUrl, queryParam, queryInt, rupees, publicize, publicizeRows, MONEY_FIELDS };
