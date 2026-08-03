'use strict';

// Three-way reconciliation verification.
//
// Data of different types is pushed through all three real channels and the
// reconciliation outputs are asserted end-to-end:
//   1. TALLY  — XML import of purchases, payments, receipts, debit notes,
//               credit notes and a cancelled purchase (real import pipeline).
//   2. BANK   — statement-shaped transactions: outflows, inflows, refunds,
//               near-miss and unmatched entries.
//   3. GST    — GSTR-2B snapshot fetched through the real fetch -> map ->
//               store -> scan pipeline (raw payload supplied by the test,
//               since no GSP credentials exist).
// Assertions cover: bank <=> Tally matching (both directions), cancelled
// exclusion, GSTR-2B b2b + CDNR comparison (match / missing / amount-diff /
// cancelled), payables aging netting, and one full three-way thread (the same
// purchase appears in Tally, is paid in the bank, and reconciles in GSTR-2B).

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'recon-three-way-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, all, get } = require('../server/src/db');
const { seedIfEmpty } = require('../server/src/seed');
const { uid, nowIso, todayStr, daysAgo } = require('../server/src/util');
const TallyImport = require('../server/src/tally-import');
const recon = require('../server/src/recon');
const { GstDataProvider } = require('../server/src/adapters');
const Gstn = require('../server/src/gstn');
const Aging = require('../server/src/services/aging');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

const co = 'threeway-' + Date.now();
const today = todayStr();
const period = today.slice(0, 7);
const d = (offset) => daysAgo(offset).replace(/-/g, '');
const iso = (offset) => daysAgo(offset);

const GSTIN = {
  alpha: '29AABCA1111K1Z5',
  beta: '29AABCA2222K1Z6',
  gamma: '29AABCA3333K1Z7',
};

function entry(ledger, amount, opts = {}) {
  const pos = opts.positive != null ? `<ISDEEMEDPOSITIVE>${opts.positive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` : '';
  const refs = opts.ref ? `<BILLALLOCATIONS.LIST><NAME>${opts.ref}</NAME></BILLALLOCATIONS.LIST>` : '';
  return `<LEDGERENTRIES.LIST>${pos}<LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT>${refs}</LEDGERENTRIES.LIST>`;
}

function voucher({ vchtype, number, type, date, party, amount, entries, guid, cancelled, ref }) {
  return `<TALLYMESSAGE><VOUCHER VCHTYPE="${vchtype}" ACTION="Create">${guid ? `<GUID>${guid}</GUID><ALTERID>1</ALTERID>` : ''}` +
    `<DATE>${date}</DATE><VOUCHERNUMBER>${number}</VOUCHERNUMBER><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>` +
    `${party ? `<PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>` : ''}<AMOUNT>${amount}</AMOUNT>` +
    `${cancelled ? '<ISCANCELLED>Yes</ISCANCELLED>' : ''}${entries}${ref ? `<BILLALLOCATIONS.LIST><NAME>${ref}</NAME></BILLALLOCATIONS.LIST>` : ''}</VOUCHER></TALLYMESSAGE>`;
}

function buildXml() {
  const g = (name, parent) => `<TALLYMESSAGE><GROUP><NAME>${name}</NAME>${parent ? `<PARENT>${parent}</PARENT>` : ''}</GROUP></TALLYMESSAGE>`;
  const l = (name, parent, gstin) => `<TALLYMESSAGE><LEDGER><NAME>${name}</NAME><PARENT>${parent}</PARENT>${gstin ? `<GSTIN>${gstin}</GSTIN>` : ''}</LEDGER></TALLYMESSAGE>`;
  const ledger = (name, amount, ref) => entry(name, amount, { positive: false, ref });

  const purchase = (num, date, party, gstin, taxable, cgst, sgst, gross, ref, extra = {}) =>
    voucher({
      vchtype: 'Purchase', number: num, type: 'Purchase', date, party, amount: gross, ref,
      entries: entry('Purchase Account', -taxable, { positive: true }) + entry('Input CGST', -cgst, { positive: true }) + entry('Input SGST', -sgst, { positive: true }) + ledger(party, gross, ref),
      ...extra,
    });

  return [
    '<ENVELOPE><BODY><DATA>',
    g('Current Liabilities'), g('Sundry Creditors', 'Current Liabilities'),
    g('Current Assets'), g('Sundry Debtors', 'Current Assets'), g('Bank Accounts', 'Current Assets'),
    l('Vendor Alpha Traders', 'Sundry Creditors', GSTIN.alpha),
    l('Vendor Beta Supplies', 'Sundry Creditors', GSTIN.beta),
    l('Customer Gamma Retail', 'Sundry Debtors', GSTIN.gamma),
    l('HDFC Bank - Current A/c', 'Bank Accounts'),
    l('Purchase Account', 'Current Assets'), l('Sales Account', 'Current Assets'),
    l('Input CGST', 'Current Assets'), l('Input SGST', 'Current Assets'),
    l('Output CGST', 'Current Assets'), l('Output SGST', 'Current Assets'),
    l('Purchase Return', 'Current Assets'), l('Sales Return', 'Current Assets'),
    l('Rent Expenses', 'Current Assets'),
    // ---- Channel 1: Tally vouchers of different types ----
    purchase('PU-1001', d(1), 'Vendor Alpha Traders', GSTIN.alpha, 100000, 9000, 9000, 118000, 'INV-ALPHA-1001'),
    purchase('PU-1002', d(5), 'Vendor Beta Supplies', GSTIN.beta, 50000, 4500, 4500, 59000, 'INV-BETA-2002'),
    purchase('PU-DIFF', d(6), 'Vendor Beta Supplies', GSTIN.beta, 50000, 5000, 5000, 60000, 'INV-BETA-DIFF'),
    purchase('PU-MISSING', d(7), 'Vendor Beta Supplies', GSTIN.beta, 50000, 0, 0, 50000, 'INV-BETA-NOPE'),
    purchase('PU-CANC', d(0), 'Vendor Alpha Traders', GSTIN.alpha, 99999, 0, 0, 99999, 'INV-CANCEL', { cancelled: true }),
    voucher({ vchtype: 'Payment', number: 'PY-2001', type: 'Payment', date: d(0), party: 'Vendor Alpha Traders', amount: 50000, entries: entry('Rent Expenses', -50000, { positive: true }) + entry('Vendor Alpha Traders', 50000, { positive: false }) }),
    voucher({ vchtype: 'Receipt', number: 'RC-3001', type: 'Receipt', date: d(0), party: 'Customer Gamma Retail', amount: 30000, entries: entry('HDFC Bank - Current A/c', -30000, { positive: true }) + entry('Customer Gamma Retail', 30000, { positive: false }) }),
    voucher({ vchtype: 'Debit Note', number: 'DN-4001', type: 'Debit Note', date: d(2), party: 'Vendor Alpha Traders', amount: 20000, ref: 'DN-GST-1', entries: entry('Vendor Alpha Traders', -20000, { positive: true }) + entry('Purchase Return', 20000, { positive: false, ref: 'DN-GST-1' }) }),
    voucher({ vchtype: 'Debit Note', number: 'DN-MISSING', type: 'Debit Note', date: d(3), party: 'Vendor Alpha Traders', amount: 10000, ref: 'DN-GST-NOPE', entries: entry('Vendor Alpha Traders', -10000, { positive: true }) + entry('Purchase Return', 10000, { positive: false, ref: 'DN-GST-NOPE' }) }),
    voucher({ vchtype: 'Credit Note', number: 'CN-5001', type: 'Credit Note', date: d(2), party: 'Customer Gamma Retail', amount: 15000, ref: 'CN-GST-1', entries: entry('Sales Return', -15000, { positive: true }) + entry('Customer Gamma Retail', 15000, { positive: false, ref: 'CN-GST-1' }) }),
    voucher({ vchtype: 'Credit Note', number: 'CN-DIFF', type: 'Credit Note', date: d(4), party: 'Customer Gamma Retail', amount: 12000, ref: 'CN-GST-2', entries: entry('Sales Return', -12000, { positive: true }) + entry('Customer Gamma Retail', 12000, { positive: false, ref: 'CN-GST-2' }) }),
    '</DATA></BODY></ENVELOPE>',
  ].join('');
}

(async () => {
  await seedIfEmpty();
  await insert('companies', { id: co, name: 'Three Way Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('bank_accounts', { id: 'acc_tw', company_id: co, bank_code: 'HDFC', account_name: 'HDFC Current', account_number: '99990001', type: 'current', ifsc: 'HDFC0001234', status: 'active', source: 'direct_api', opened_at: today });
  for (const [id, name, gstin] of [['v_alpha', 'Vendor Alpha Traders', GSTIN.alpha], ['v_beta', 'Vendor Beta Supplies', GSTIN.beta], ['v_gamma', 'Customer Gamma Retail', GSTIN.gamma]]) {
    await insert('vendors', { id, company_id: co, name, gstin, ledger_name: name, tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1 });
  }

  // ===================== CHANNEL 1: TALLY =====================
  await check('channel-1 tally: XML with 11 mixed voucher types imports cleanly', async () => {
    const r = await TallyImport.handleImport(co, buildXml());
    assert.strictEqual(r.validation.errors.length, 0, JSON.stringify(r.validation.errors));
    assert.strictEqual(r.validation.warnings.length, 0, JSON.stringify(r.validation.warnings));
    assert.strictEqual(r.imported.vouchers.imported, 11, JSON.stringify(r.imported.vouchers));
    const vs = await all('SELECT voucher_number, voucher_type, cancelled FROM tally_vouchers WHERE company_id = ?', [co]);
    assert.strictEqual(vs.length, 11);
    assert.strictEqual(vs.find((v) => v.voucher_number === 'PU-CANC').cancelled, 1);
  });

  // ===================== CHANNEL 2: BANK =====================
  const txns = [
    ['txnA', -50000, 'NEFT/OUTWARD Vendor Alpha Traders', 'NEFT', 'TXN-A'],
    ['txnB', 30000, 'NEFT/CREDIT Customer Gamma Retail', 'NEFT', 'TXN-B'],
    ['txnC', 20000, 'NEFT/CREDIT Vendor Alpha Traders (refund)', 'NEFT', 'TXN-C'],
    ['txnD', -15000, 'NEFT/OUTWARD Customer Gamma Retail (refund)', 'NEFT', 'TXN-D'],
    ['txnE', -99999, 'NEFT/OUTWARD Vendor Alpha Traders', 'NEFT', 'TXN-E'],
    ['txnF', -25000, 'NEFT OFFICE SUPPLIES', 'NEFT', 'TXN-F'],
    ['txnG', -118000, 'NEFT/OUTWARD Vendor Alpha Traders', 'NEFT', 'TXN-G'],
  ];
  await check('channel-2 bank: statement rows of different types are stored', async () => {
    for (const [id, amount, desc, mode, ref] of txns) {
      await insert('bank_transactions', { id, company_id: co, account_id: 'acc_tw', external_id: 'EXT-' + id, txn_date: today, amount, description: desc, mode, ref_no: ref, status: 'posted', matched: 0, created_at: nowIso() });
    }
    assert.strictEqual((await all('SELECT COUNT(*) AS c FROM bank_transactions WHERE company_id = ?', [co]))[0].c, 7);
  });

  // ===================== CHANNEL 3: GST (GSTR-2B) =====================
  await check('channel-3 gst: GSTR-2B fetched, mapped and stored via the real pipeline', async () => {
    const orig = Gstn.fetchGstr2bRaw;
    Gstn.fetchGstr2bRaw = async () => ({
      gstin: '29ABCDE1234F1Z5', fp: period,
      b2b: [
        { ctin: GSTIN.alpha, docno: 'INV-ALPHA-1001', txval: 100000, cgst: 9000, sgst: 9000, igst: 0 },
        { ctin: GSTIN.beta, docno: 'INV-BETA-2002', txval: 50000, cgst: 4500, sgst: 4500, igst: 0 },
        { ctin: GSTIN.beta, docno: 'INV-BETA-DIFF', txval: 50000, cgst: 4500, sgst: 4500, igst: 0 },
        { ctin: GSTIN.alpha, docno: 'INV-CANCEL', txval: 80000, cgst: 7200, sgst: 7200, igst: 0 },
      ],
      cdnr: [
        { ctin: GSTIN.alpha, docno: 'DN-GST-1', txval: 16949.15, cgst: 1525.42, sgst: 1525.42, igst: 0, typ: 'D' },
        { ctin: GSTIN.gamma, docno: 'CN-GST-1', txval: 12711.86, cgst: 1144.07, sgst: 1144.07, igst: 0, typ: 'C' },
        { ctin: GSTIN.gamma, docno: 'CN-GST-2', txval: 10000, cgst: 900, sgst: 900, igst: 0, typ: 'C' },
      ],
      isda: [], itcAvailed: { itcCgst: 0, itcSgst: 0, itcIgst: 0 }, createdAt: nowIso(),
    });
    try {
      const snap = await GstDataProvider.fetchGstr2b(co, period);
      assert.strictEqual(snap.period, period);
      assert.strictEqual(JSON.parse(snap.data_json).length, 4);
      assert.strictEqual(JSON.parse(snap.cdnr_json).length, 3);
    } finally {
      Gstn.fetchGstr2bRaw = orig;
    }
  });

  // ===================== RUN RECONCILIATION =====================
  await check('recon: matchAll reconciles debits AND credits (5 of 7 txns)', async () => {
    const stats = await recon.matchAll(co);
    assert.strictEqual(stats.auto, 5, JSON.stringify(stats));
  });
  await check('recon: autoVoucherMatch has nothing left once matchAll ran', async () => {
    const matched = await recon.autoVoucherMatch(co, 30);
    assert.strictEqual(matched, 0);
  });

  const expectMatch = async (txnId, voucherNo) => {
    const m = await get(`SELECT * FROM recon_matches WHERE bank_txn_id = ? AND status = 'matched'`, [txnId]);
    assert.ok(m, `${txnId} expected a match`);
    assert.strictEqual(m.tally_voucher_no, voucherNo);
    const t = await get('SELECT matched FROM bank_transactions WHERE id = ?', [txnId]);
    assert.strictEqual(t.matched, 1);
  };
  const expectUnmatched = async (txnId) => {
    const m = await get('SELECT * FROM recon_matches WHERE bank_txn_id = ?', [txnId]);
    assert.strictEqual(m, null, `${txnId} must not match`);
    const t = await get('SELECT matched FROM bank_transactions WHERE id = ?', [txnId]);
    assert.strictEqual(t.matched, 0);
  };

  await check('recon: payment debit matches Tally Payment voucher', () => expectMatch('txnA', 'PY-2001'));
  await check('recon: customer receipt credit matches Tally Receipt voucher', () => expectMatch('txnB', 'RC-3001'));
  await check('recon: refund credit matches Debit Note voucher', () => expectMatch('txnC', 'DN-4001'));
  await check('recon: refund debit matches Credit Note voucher', () => expectMatch('txnD', 'CN-5001'));
  await check('recon: purchase debit matches Tally Purchase voucher (cross-channel)', () => expectMatch('txnG', 'PU-1001'));
  await check('recon: cancelled purchase is never a candidate', () => expectUnmatched('txnE'));
  await check('recon: unmatched expense stays unmatched', () => expectUnmatched('txnF'));

  // ===================== GST COMPARISON =====================
  await check('gst: GSTR-2B scan flags exactly the expected mismatches', async () => {
    const mm = await GstDataProvider.scanMismatches(co, period);
    const byRef = Object.fromEntries(mm.map((m) => [m.invoice_no, m]));
    assert.strictEqual(mm.length, 4, JSON.stringify(mm));
    assert.ok(byRef['INV-BETA-DIFF'] && byRef['INV-BETA-DIFF'].note.includes('amount differs'), JSON.stringify(byRef['INV-BETA-DIFF']));
    assert.ok(byRef['INV-BETA-NOPE'] && byRef['INV-BETA-NOPE'].note.includes('not yet reflected'), JSON.stringify(byRef['INV-BETA-NOPE']));
    assert.ok(byRef['DN-GST-NOPE'] && byRef['DN-GST-NOPE'].note.includes('not yet reflected'), JSON.stringify(byRef['DN-GST-NOPE']));
    assert.ok(byRef['CN-GST-2'] && byRef['CN-GST-2'].note.includes('amount differs'), JSON.stringify(byRef['CN-GST-2']));
    for (const clean of ['INV-ALPHA-1001', 'INV-BETA-2002', 'DN-GST-1', 'CN-GST-1', 'INV-CANCEL']) {
      assert.ok(!byRef[clean], `${clean} must be clean, got ` + JSON.stringify(byRef[clean]));
    }
  });

  // ===================== PAYABLES AGING =====================
  await check('aging: purchases netted by Debit Notes, cancelled excluded', async () => {
    const a = await Aging.payablesAging(co);
    // 118000 - 30000 (Alpha notes) + 59000 + 60000 + 50000 (Beta) = 257000
    assert.strictEqual(a.total, 257000, JSON.stringify(a));
    assert.strictEqual(a.items.length, 4, JSON.stringify(a.items));
    const pu1 = a.items.find((i) => i.voucher_number === 'PU-1001');
    assert.strictEqual(pu1.amount, 88000);
    assert.ok(!a.items.some((i) => i.voucher_number === 'PU-CANC'), 'cancelled purchase must not age');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
