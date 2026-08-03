'use strict';

// Tests the GST mismatch scan against imported Tally purchase vouchers:
// a voucher ref missing from GSTR-2B and one whose amount differs are both
// flagged; matching records produce no mismatch.

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'gst-tally-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, all } = require('../server/src/db');
const { GstDataProvider } = require('../server/src/adapters');
const { nowIso } = require('../server/src/util');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

(async () => {
  const co = 'gst-tally-' + Date.now();
  const period = '2024-04';
  await insert('companies', { id: co, name: 'GST Tally Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('gstr2b_snapshots', {
    id: 'g2b-1', company_id: co, period, gstin: '29ABCDE1234F1Z5',
    total_itc: 36000, itc_cgst: 18000, itc_sgst: 18000, itc_igst: 0,
    data_json: JSON.stringify([{ invoice_no: 'PB/2024/558', taxable: 200000, cgst: 18000, sgst: 18000, igst: 0 }]),
    cdnr_json: JSON.stringify([
      { invoice_no: 'CN-2024/001', gstin: '29AABCS2345K1Z2', taxable: 20000, cgst: 1800, sgst: 1800, igst: 0, doc_type: 'C' },
      { invoice_no: 'CN-2024/002', gstin: '29AABCS2345K1Z2', taxable: 10000, cgst: 900, sgst: 900, igst: 0, doc_type: 'C' },
    ]),
    source: 'gstr2b', fetched_at: nowIso(),
  });
  await insert('tally_ledgers', {
    id: 'tl-v', company_id: co, name: 'Verma Electronics Wholesale', group_name: 'Sundry Creditors',
    opening_balance: 0, gstin: '29AABCS2345K1Z2',
  });
  await insert('tally_vouchers', {
    id: 'tv-1', company_id: co, voucher_number: 'PU-1', voucher_type: 'Purchase', date: '2024-04-03',
    amount: 246750, party_name: 'Verma Electronics Wholesale',
    entry_json: JSON.stringify([{ ledger: 'Verma Electronics Wholesale', amount: 246750, positive: false, bill_refs: ['PB/2024/558'] }]),
    tally_guid: 'g-pu-1', tally_alterid: 1, imported_at: nowIso(),
  });
  await insert('tally_vouchers', {
    id: 'tv-2', company_id: co, voucher_number: 'PU-2', voucher_type: 'Purchase', date: '2024-04-05',
    amount: 5000, party_name: 'Verma Electronics Wholesale',
    entry_json: JSON.stringify([{ ledger: 'Verma Electronics Wholesale', amount: 5000, positive: false, bill_refs: ['NOPE-1'] }]),
    tally_guid: 'g-pu-2', tally_alterid: 1, imported_at: nowIso(),
  });
  await insert('tally_vouchers', {
    id: 'tv-3', company_id: co, voucher_number: 'PU-C', voucher_type: 'Purchase', date: '2024-04-06',
    amount: 246750, party_name: 'Verma Electronics Wholesale',
    entry_json: JSON.stringify([{ ledger: 'Verma Electronics Wholesale', amount: 246750, positive: false, bill_refs: ['CN-X'] }]),
    tally_guid: 'g-pu-3', tally_alterid: 1, imported_at: nowIso(), cancelled: 1,
  });
  await insert('tally_vouchers', {
    id: 'tv-4', company_id: co, voucher_number: 'CN-1', voucher_type: 'Credit Note', date: '2024-04-07',
    amount: 23600, party_name: 'Verma Electronics Wholesale',
    entry_json: JSON.stringify([{ ledger: 'Verma Electronics Wholesale', amount: -23600, positive: true, bill_refs: ['CN-2024/001'] }]),
    tally_guid: 'g-cn-1', tally_alterid: 1, imported_at: nowIso(),
  });
  await insert('tally_vouchers', {
    id: 'tv-5', company_id: co, voucher_number: 'CN-2', voucher_type: 'Credit Note', date: '2024-04-08',
    amount: 12000, party_name: 'Verma Electronics Wholesale',
    entry_json: JSON.stringify([{ ledger: 'Verma Electronics Wholesale', amount: -12000, positive: true, bill_refs: ['CN-2024/002'] }]),
    tally_guid: 'g-cn-2', tally_alterid: 1, imported_at: nowIso(),
  });
  await insert('tally_vouchers', {
    id: 'tv-6', company_id: co, voucher_number: 'CN-3', voucher_type: 'Credit Note', date: '2024-04-09',
    amount: 5000, party_name: 'Verma Electronics Wholesale',
    entry_json: JSON.stringify([{ ledger: 'Verma Electronics Wholesale', amount: -5000, positive: true, bill_refs: ['CN-MISSING'] }]),
    tally_guid: 'g-cn-3', tally_alterid: 1, imported_at: nowIso(),
  });

  await check('gst: tally purchase vouchers scanned against GSTR-2B', async () => {
    const mm = await GstDataProvider.scanMismatches(co, period);
    const byRef = Object.fromEntries(mm.map((m) => [m.invoice_no, m]));
    assert.ok(byRef['PB/2024/558'], 'expected an amount-diff mismatch, got: ' + JSON.stringify(mm));
    assert.ok(byRef['PB/2024/558'].note.includes('amount differs'), byRef['PB/2024/558'].note);
    assert.ok(byRef['NOPE-1'], 'expected a not-reflected mismatch');
    assert.ok(byRef['NOPE-1'].note.includes('not yet reflected'), byRef['NOPE-1'].note);
    assert.ok(!byRef['CN-X'], 'cancelled purchase voucher must not be scanned');
    assert.strictEqual(byRef['PB/2024/558'].vendor_gstin, '29AABCS2345K1Z2');
    // CDNR comparison: matching note is clean; amount-diff and missing are flagged.
    assert.ok(!byRef['CN-2024/001'], 'matching Credit Note must not be flagged');
    assert.ok(byRef['CN-2024/002'], 'expected an amount-diff CDNR mismatch');
    assert.ok(byRef['CN-2024/002'].note.includes('amount differs'), byRef['CN-2024/002'].note);
    assert.ok(byRef['CN-MISSING'], 'expected a not-reflected CDNR mismatch');
    assert.ok(byRef['CN-MISSING'].note.includes('not yet reflected'), byRef['CN-MISSING'].note);
    const rows = await all('SELECT invoice_no, status FROM gst_mismatches WHERE company_id = ?', [co]);
    assert.strictEqual(rows.length, 4);
    assert.ok(rows.every((r) => r.status === 'open'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
