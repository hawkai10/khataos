'use strict';

// Reference-data seed: the supported Indian bank directory used by the UI and
// IFSC lookups. No demo company, users, accounts, transactions, invoices or
// vouchers are created — the platform starts empty and only holds data that
// arrives through the real channels (Tally XML import, bank statements,
// GSTR-2B, forwarded invoices).

const { insert, get } = require('./db');

// Real IFSC-prefix directory of Indian banks (reference data, not dummy data).
const BANKS = [
  ['ICIC', 'ICICI Bank', 'aa', 1], ['HDFC', 'HDFC Bank', 'aa', 1], ['AXIS', 'Axis Bank', 'aa', 1],
  ['KKBK', 'Kotak Mahindra Bank', 'aa', 1], ['YESB', 'Yes Bank', 'aa', 1], ['SBIN', 'State Bank of India', 'aa', 1],
  ['PUNB', 'Punjab National Bank', 'aa', 1], ['BARB', 'Bank of Baroda', 'aa', 1], ['UBIN', 'Union Bank of India', 'aa', 1],
  ['CNRB', 'Canara Bank', 'aa', 1], ['IDFB', 'IDFC First Bank', 'aa', 1], ['INDB', 'IndusInd Bank', 'aa', 1],
  ['FDRL', 'Federal Bank', 'aa', 1], ['DCBL', 'DCB Bank', 'aa', 1], ['RATN', 'RBL Bank', 'aa', 1],
  ['AUBL', 'AU Small Finance Bank', 'aa', 1], ['DBSS', 'DBS Bank India', 'aa', 1],
];

async function seedIfEmpty() {
  const existing = await get('SELECT COUNT(*) AS c FROM banks');
  if (existing.c > 0) return false;
  for (const [code, name, kind, aa] of BANKS) {
    await insert('banks', { code, name, kind, aa_supported: aa });
  }
  return true;
}

module.exports = { seedIfEmpty };
