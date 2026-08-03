'use strict';

// Tests for the GSTR-2B mismatch scan edge cases:
//   - vouchers with multiple BILLALLOCATIONS refs compare every ref
//   - duplicate invoice numbers from different suppliers are matched by
//     GSTIN + ref, never cross-contaminated
//   - a duplicated ref within one voucher is flagged once

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'gst-scan-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert } = require('../server/src/db');
const { GstDataProvider } = require('../server/src/adapters');
const { nowIso } = require('../server/src/util');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

(async () => {
  const co = 'gst-scan-' + Date.now();
  const period = '2024-05';
  const G_A = '29AABCA1111K1Z5';
  const G_B = '29AABCA2222K1Z6';
  await insert('companies', { id: co, name: 'GST Scan Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('gstr2b_snapshots', {
    id: 'g2b-scan', company_id: co, period, gstin: '29ABCDE1234F1Z5',
    total_itc: 0, itc_cgst: 0, itc_sgst: 0, itc_igst: 0,
    data_json: JSON.stringify([
      { invoice_no: 'INV-9', gstin: G_A, taxable: 10000, cgst: 900, sgst: 900, igst: 0 },
      { invoice_no: 'INV-9', gstin: G_B, taxable: 20000, cgst: 1800, sgst: 1800, igst: 0 },
      { invoice_no: 'INV-MULTI-2', gstin: G_A, taxable: 5000, cgst: 450, sgst: 450, igst: 0 },
    ]),
    cdnr_json: '[]', source: 'gstn-live', fetched_at: nowIso(),
  });
  await insert('tally_ledgers', { id: 'tl-a', company_id: co, name: 'Vendor A', group_name: 'Sundry Creditors', opening_balance: 0, gstin: G_A });
  await insert('tally_ledgers', { id: 'tl-b', company_id: co, name: 'Vendor B', group_name: 'Sundry Creditors', opening_balance: 0, gstin: G_B });
  const voucher = (id, party, amount, refs) => insert('tally_vouchers', {
    id, company_id: co, voucher_number: id, voucher_type: 'Purchase', date: '2024-05-10',
    amount, party_name: party, entry_json: JSON.stringify([{ ledger: party, amount, positive: false, bill_refs: refs }]),
    tally_guid: 'g-' + id, tally_alterid: 1, imported_at: nowIso(),
  });

  await voucher('tv-multi', 'Vendor A', 11800, ['INV-MULTI-1', 'INV-MULTI-2', 'INV-MULTI-2']);
  await voucher('tv-dupe-a', 'Vendor A', 11800, ['INV-9']);
  await voucher('tv-dupe-b', 'Vendor B', 23600, ['INV-9']);

  await check('gst: every ref on a multi-ref voucher is compared, duplicates once', async () => {
    const mm = await GstDataProvider.scanMismatches(co, period);
    const byRef = Object.fromEntries(mm.map((m) => [m.invoice_no, m]));
    assert.ok(byRef['INV-MULTI-1'] && byRef['INV-MULTI-1'].note.includes('not yet reflected'), JSON.stringify(mm));
    assert.ok(!byRef['INV-MULTI-2'], 'INV-MULTI-2 exists in 2B and must be clean');
    assert.strictEqual(mm.filter((m) => m.invoice_no === 'INV-MULTI-2').length, 0);
    assert.strictEqual(mm.filter((m) => m.invoice_no === 'INV-MULTI-1').length, 1);
  });

  await check('gst: same invoice number from two suppliers matches by GSTIN, no cross-contamination', async () => {
    // Vendor A's INV-9 (11800) matches its own 2B row (10000+900+900); Vendor
    // B's INV-9 (23600) matches its own row (20000+1800+1800). Neither should
    // be flagged, and neither should match the other supplier's row.
    const mm = await GstDataProvider.scanMismatches(co, period);
    const a = mm.find((m) => m.invoice_no === 'INV-9' && m.vendor_gstin === G_A);
    const b = mm.find((m) => m.invoice_no === 'INV-9' && m.vendor_gstin === G_B);
    assert.strictEqual(a, undefined, 'Vendor A INV-9 must be clean: ' + JSON.stringify(mm));
    assert.strictEqual(b, undefined, 'Vendor B INV-9 must be clean: ' + JSON.stringify(mm));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
