'use strict';

// ============================================================================
// India tax compliance worked examples (tests/tax-compliance.test.js).
//
// TDS (CBDT Circular 23/2017 + section thresholds + Section 197 certificates):
//   - TDS is deducted on the amount EXCLUDING GST when GST is separately
//     indicated — the old gross-basis computation over-deducted by
//     rate × GST% (at 18% GST + 2% TDS under 194C: 0.36% of taxable).
//   - 194C: no TDS below ₹30k single AND ₹1L FY aggregate.
//   - 194J: no TDS below ₹30k single.
//   - vendor.tds_on_gross = the rarer case where GST is NOT separated -> TDS
//     on the gross.
//   - vendor.tds_cert_rate (Section 197) overrides the rate and the threshold
//     exemption.
//
// GST:
//   - the rate is always explicit (gst_rate or per-line gst_rate); the split
//     is derived from the company + supplier GSTIN state codes (same state ->
//     CGST+SGST, different -> IGST); cess is explicit.
//   - 400 whenever the split cannot be derived — never a guessed 18%.
//
// Worked examples run against the pure service AND the capture endpoint.
// ============================================================================

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'tax-compliance-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, get, all } = require('../server/src/db');
const { hashPassword, nowIso, todayStr } = require('../server/src/util');
const { makeApp, createSession } = require('./helpers');
const Tax = require('../server/src/services/tax');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

const RUPEES = (r) => Number((r * 100).toFixed(0)); // rupees -> paise

(async () => {
  // ------------------------------------------------------------------
  // TDS — worked examples per section
  // ------------------------------------------------------------------
  await check('TDS 194C (Circular 23/2017): deducted on taxable EXCLUDING GST, not gross', () => {
    // taxable ₹5,00,000 @18% GST -> gross ₹5,90,000; 194C @2%.
    const r = Tax.computeTds({ taxablePaise: RUPEES(500000), grossPaise: RUPEES(590000), ratePct: 0.02, section: '194C', singlePaise: RUPEES(590000), fyAggregatePaise: RUPEES(0) });
    assert.strictEqual(r.tds, RUPEES(10000), `expected TDS on taxable (10000), got ${r.tds}`);
    assert.notStrictEqual(r.tds, RUPEES(11800), 'must NOT deduct 2% of the GST-inclusive gross');
    assert.strictEqual(r.basePaise, RUPEES(500000));
  });

  await check('TDS 194C: single payment below ₹30k AND FY aggregate below ₹1L -> exempt', () => {
    const r = Tax.computeTds({ taxablePaise: RUPEES(25000), grossPaise: RUPEES(29500), ratePct: 0.02, section: '194C', singlePaise: RUPEES(29500), fyAggregatePaise: RUPEES(40000) });
    assert.strictEqual(r.tds, 0);
    assert.strictEqual(r.exempt, true);
  });

  await check('TDS 194C: single above ₹30k -> deduct', () => {
    const r = Tax.computeTds({ taxablePaise: RUPEES(35000), grossPaise: RUPEES(41300), ratePct: 0.02, section: '194C', singlePaise: RUPEES(41300), fyAggregatePaise: RUPEES(0) });
    assert.strictEqual(r.tds, RUPEES(700));
  });

  await check('TDS 194C: FY aggregate crossing ₹1L -> deduct even when single is below ₹30k', () => {
    const r = Tax.computeTds({ taxablePaise: RUPEES(25000), grossPaise: RUPEES(29500), ratePct: 0.02, section: '194C', singlePaise: RUPEES(29500), fyAggregatePaise: RUPEES(95000) });
    assert.strictEqual(r.tds, RUPEES(500), 'aggregate 95000 + 25000 > 1L -> TDS applies');
    const stillExempt = Tax.computeTds({ taxablePaise: RUPEES(4000), grossPaise: RUPEES(4720), ratePct: 0.02, section: '194C', singlePaise: RUPEES(4720), fyAggregatePaise: RUPEES(95000) });
    assert.strictEqual(stillExempt.tds, 0, 'aggregate 95000 + 4000 <= 1L -> still exempt');
  });

  await check('TDS 194C gross-basis flag (vendor.tds_on_gross): GST not separated -> deduct on gross', () => {
    const r = Tax.computeTds({ taxablePaise: RUPEES(500000), grossPaise: RUPEES(590000), tdsOnGross: 1, ratePct: 0.02, section: '194C', singlePaise: RUPEES(590000) });
    assert.strictEqual(r.tds, RUPEES(11800), 'gross-basis vendor deducts on the GST-inclusive amount');
    assert.strictEqual(r.basePaise, RUPEES(590000));
  });

  await check('TDS 194J: below ₹30k exempt, above deducts on taxable', () => {
    const exempt = Tax.computeTds({ taxablePaise: RUPEES(25000), grossPaise: RUPEES(29500), ratePct: 0.02, section: '194J', singlePaise: RUPEES(29500) });
    assert.strictEqual(exempt.tds, 0);
    const deduct = Tax.computeTds({ taxablePaise: RUPEES(35000), grossPaise: RUPEES(41300), ratePct: 0.02, section: '194J', singlePaise: RUPEES(41300) });
    assert.strictEqual(deduct.tds, RUPEES(700));
  });

  await check('TDS Section 197 lower-deduction certificate: certified rate applies regardless of threshold', () => {
    const r = Tax.computeTds({ taxablePaise: RUPEES(20000), grossPaise: RUPEES(23600), certRatePct: 0.01, section: '194C', singlePaise: RUPEES(23600), fyAggregatePaise: RUPEES(0) });
    assert.strictEqual(r.tds, RUPEES(200), 'certificate overrides the 194C threshold exemption');
    assert.strictEqual(r.ratePct, 0.01);
  });

  // ------------------------------------------------------------------
  // GST — worked examples per slab + place of supply
  // ------------------------------------------------------------------
  const co = 'taxco-' + Date.now();
  const today = todayStr();
  await insert('companies', { id: co, name: 'Tax Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  await insert('users', { id: 'u-tax', company_id: co, name: 'CFO', email: 'cfo@tax.in', password: hashPassword('pw'), role: 'cfo', active: 1, created_at: nowIso() });
  await insert('vendors', { id: 'v-tax', company_id: co, name: 'Tax Vendor', gstin: '29ABCDE1234F1Z5', ledger_name: 'Tax Vendor', tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1 });
  await insert('vendors', { id: 'v-tax-other', company_id: co, name: 'Other State Vendor', gstin: '09ABCDE1234F1Z5', ledger_name: 'Other State Vendor', tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1 });
  // Fresh vendor with NO prior FY invoices, so the 194C aggregate is still 0.
  await insert('vendors', { id: 'v-tax-small', company_id: co, name: 'Small Vendor', gstin: '29ABCDE1234F1Z5', ledger_name: 'Small Vendor', tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1 });
  const auth = await createSession('u-tax');
  const app = await makeApp();

  const gst = (opts) => Tax.computeGst({ companyGstin: '29ABCDE1234F1Z5', supplierGstin: '29ABCDE1234F1Z5', ...opts });

  await check('GST 5% slab, intra-state: CGST 2.5% + SGST 2.5%', () => {
    const r = gst({ taxablePaise: RUPEES(100000), gstRatePct: 5 });
    assert.deepStrictEqual(r, { cgst: RUPEES(2500), sgst: RUPEES(2500), igst: 0, cess: 0, lineRows: [] });
  });

  await check('GST 12% slab, inter-state: IGST 12%', () => {
    const r = Tax.computeGst({ companyGstin: '29ABCDE1234F1Z5', supplierGstin: '09ABCDE1234F1Z5', taxablePaise: RUPEES(100000), gstRatePct: 12 });
    assert.deepStrictEqual(r, { cgst: 0, sgst: 0, igst: RUPEES(12000), cess: 0, lineRows: [] });
  });

  await check('GST 18% slab, intra-state: CGST 9% + SGST 9% (the exact Circular 23/2017 pairing)', () => {
    const r = gst({ taxablePaise: RUPEES(500000), gstRatePct: 18 });
    assert.deepStrictEqual(r, { cgst: RUPEES(45000), sgst: RUPEES(45000), igst: 0, cess: 0, lineRows: [] });
  });

  await check('GST 28% + cess: CGST/SGST 14% each + explicit cess', () => {
    const r = gst({ taxablePaise: RUPEES(100000), gstRatePct: 28, explicit: { cess: RUPEES(1000) } });
    assert.deepStrictEqual(r, { cgst: RUPEES(14000), sgst: RUPEES(14000), igst: 0, cess: RUPEES(1000), lineRows: [] });
  });

  await check('GST per-line HSN rates: line sums reconcile with invoice taxable', () => {
    const r = gst({
      taxablePaise: RUPEES(100000),
      gstRatePct: 18,
      lines: [
        { hsn: '7308', description: 'a', taxable: RUPEES(60000), gst_rate: 18, cess: RUPEES(500) },
        { hsn: '8504', description: 'b', taxable: RUPEES(40000), gst_rate: 5 },
      ],
    });
    assert.strictEqual(r.cgst, RUPEES(5400) + RUPEES(1000), 'line1 60000@18% intra + line2 40000@5% intra');
    assert.strictEqual(r.sgst, r.cgst);
    assert.strictEqual(r.igst, 0);
    assert.strictEqual(r.cess, RUPEES(500));
    assert.strictEqual(r.lineRows.length, 2);
  });

  await check('GST exempt invoice: gst_rate 0 -> zero tax (explicit, not guessed)', () => {
    const r = gst({ taxablePaise: RUPEES(50000), gstRatePct: 0 });
    assert.deepStrictEqual(r, { cgst: 0, sgst: 0, igst: 0, cess: 0, lineRows: [] });
  });

  // ---- 400s: never guess ----
  await check('GST 400: rate given but supplier GSTIN missing (place of supply unknown)', () => {
    assert.throws(() => Tax.computeGst({ companyGstin: '29ABCDE1234F1Z5', supplierGstin: null, taxablePaise: RUPEES(100000), gstRatePct: 18 }), (e) => e.status === 400);
  });

  await check('GST 400: no rate, no lines, all-zero/absent explicit split', () => {
    assert.throws(() => gst({ taxablePaise: RUPEES(100000), explicit: { cgst: 0, sgst: 0, igst: 0 } }), (e) => e.status === 400 && /GST split missing/.test(e.message));
  });

  await check('GST 400: intra-state invoice declared with IGST', () => {
    assert.throws(() => gst({ taxablePaise: RUPEES(100000), explicit: { igst: RUPEES(18000) } }), (e) => e.status === 400 && /must use CGST\+SGST/.test(e.message));
  });

  await check('GST 400: inter-state invoice declared with CGST/SGST', () => {
    assert.throws(() => Tax.computeGst({ companyGstin: '29ABCDE1234F1Z5', supplierGstin: '09ABCDE1234F1Z5', taxablePaise: RUPEES(100000), explicit: { cgst: RUPEES(9000) } }), (e) => e.status === 400 && /must use IGST/.test(e.message));
  });

  await check('GST 400: a line with no rate (and no invoice rate, no explicit tax)', () => {
    assert.throws(() => gst({ taxablePaise: RUPEES(100000), lines: [{ hsn: '7308', taxable: RUPEES(100000) }] }), (e) => e.status === 400 && /needs a gst_rate/.test(e.message));
  });

  await check('GST 400: line taxable does not reconcile with invoice taxable', () => {
    assert.throws(() => gst({ taxablePaise: RUPEES(100000), gstRatePct: 18, lines: [{ hsn: '7308', taxable: RUPEES(90000), gst_rate: 18 }] }), (e) => e.status === 400 && /does not reconcile/.test(e.message));
  });

  await check('GST 400: declared split contradicts computed rate', () => {
    assert.throws(() => gst({ taxablePaise: RUPEES(100000), gstRatePct: 18, explicit: { cgst: RUPEES(500) } }), (e) => e.status === 400 && /does not match the computed/.test(e.message));
  });

  await check('GST intra-state: CGST==SGST is a statutory identity — one side declared derives the other', () => {
    const r = gst({ taxablePaise: RUPEES(100000), explicit: { cgst: RUPEES(9000) } });
    assert.deepStrictEqual(r, { cgst: RUPEES(9000), sgst: RUPEES(9000), igst: 0, cess: 0, lineRows: [] });
  });

  await check('GST: invoice-level gst_rate applies as the default to lines without their own rate', () => {
    const r = gst({
      taxablePaise: RUPEES(100000),
      gstRatePct: 18,
      lines: [
        { hsn: '7308', taxable: RUPEES(60000) }, // no per-line rate -> invoice 18%
        { hsn: '8504', taxable: RUPEES(40000), gst_rate: 5 },
      ],
    });
    assert.strictEqual(r.cgst, RUPEES(5400) + RUPEES(1000), '60000@18% + 40000@5%, both intra');
    assert.strictEqual(r.sgst, r.cgst);
  });

  await check('TDS 400: invalid (negative / non-numeric) rate is a 400, never a silent 0 or a 500', () => {
    assert.throws(() => Tax.computeTds({ taxablePaise: RUPEES(500000), grossPaise: RUPEES(590000), certRatePct: -1, section: '194C', singlePaise: RUPEES(590000) }), (e) => e.status === 400);
    assert.throws(() => Tax.computeTds({ taxablePaise: RUPEES(500000), grossPaise: RUPEES(590000), certRatePct: 'abc', section: '194C', singlePaise: RUPEES(590000) }), (e) => e.status === 400);
    assert.throws(() => Tax.computeTds({ taxablePaise: RUPEES(500000), grossPaise: RUPEES(590000), certRatePct: 35, section: '194C', singlePaise: RUPEES(590000) }), (e) => e.status === 400 && /certificate rate/.test(e.message));
  });

  // ------------------------------------------------------------------
  // Endpoint integration: capture computes and persists the compliance numbers
  // ------------------------------------------------------------------
  const capture = (payload) => app.inject({ method: 'POST', url: '/api/invoices/capture', headers: { ...auth, 'idempotency-key': 'tax-' + Math.random().toString(36).slice(2) }, payload: JSON.stringify(payload) });

  await check('capture: intra-state 18% + 194C TDS on taxable (not gross) end-to-end', async () => {
    const res = await capture({ vendor_id: 'v-tax', invoice_no: 'INV-TAX-1', invoice_date: today, taxable_amount: '500000', gst_rate: 18, gstin_vendor: '29ABCDE1234F1Z5' });
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 200));
    const d = res.json().data;
    assert.strictEqual(d.cgst, '45000.00');
    assert.strictEqual(d.sgst, '45000.00');
    assert.strictEqual(d.igst, '0.00');
    assert.strictEqual(d.gross_amount, '590000.00');
    assert.strictEqual(d.tds_amount, '10000.00', '194C @2% on taxable ₹5,00,000 — NOT ₹11,800 on gross');
    assert.strictEqual(d.net_payable, '580000.00');
  });

  await check('capture: inter-state 12% -> IGST, no CGST/SGST', async () => {
    const res = await capture({ vendor_id: 'v-tax-other', invoice_no: 'INV-TAX-2', invoice_date: today, taxable_amount: '100000', gst_rate: 12, gstin_vendor: '09ABCDE1234F1Z5' });
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 200));
    const d = res.json().data;
    assert.strictEqual(d.igst, '12000.00');
    assert.strictEqual(d.cgst, '0.00');
    assert.strictEqual(d.sgst, '0.00');
    assert.strictEqual(d.tds_amount, '2000.00', '194C @2% on taxable ₹1,00,000');
  });

  await check('capture: 194C below-threshold invoice (fresh vendor, aggregate 0) -> TDS exempt', async () => {
    const res = await capture({ vendor_id: 'v-tax-small', invoice_no: 'INV-TAX-3', invoice_date: today, taxable_amount: '25000', gst_rate: 18, gstin_vendor: '29ABCDE1234F1Z5' });
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 200));
    assert.strictEqual(res.json().data.tds_amount, '0.00');
  });

  await check('capture: missing GST rate -> 400, never a guessed 18%', async () => {
    const res = await capture({ vendor_id: 'v-tax', invoice_no: 'INV-TAX-4', invoice_date: today, taxable_amount: '100000', gstin_vendor: '29ABCDE1234F1Z5' });
    assert.strictEqual(res.statusCode, 400, res.body.slice(0, 160));
  });

  await check('capture: exempt invoice via gst_rate 0', async () => {
    const res = await capture({ vendor_id: 'v-tax', invoice_no: 'INV-TAX-5', invoice_date: today, taxable_amount: '100000', gst_rate: 0, gstin_vendor: '29ABCDE1234F1Z5' });
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 160));
    const d = res.json().data;
    assert.strictEqual(d.cgst, '0.00');
    assert.strictEqual(d.gross_amount, '100000.00');
  });

  // ------------------------------------------------------------------
  // OCR (pdf) path regression: totals come from the invoice-level OCR
  // fields; raw lines are stored for reference, never re-derived.
  // ------------------------------------------------------------------
  const pdfText = [
    'Supplier: OCR Steel Traders',
    'GSTIN 29AAACS1234F1Z5',
    'Invoice No INV-OCR-1',
    'Invoice Date 01/08/2026',
    'Taxable Value 50000.00',
    'CGST 4500.00',
    'SGST 4500.00',
    'Grand Total 59000.00',
  ].join('\n');

  await check('capture (pdf/OCR): intra-state totals from OCR fields, raw lines stored non-authoritatively', async () => {
    const res = await capture({ source: 'pdf', text: pdfText });
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 200));
    const d = res.json().data;
    assert.strictEqual(d.taxable_amount, '50000.00');
    assert.strictEqual(d.cgst, '4500.00');
    assert.strictEqual(d.sgst, '4500.00');
    assert.strictEqual(d.igst, '0.00');
    assert.strictEqual(d.gross_amount, '59000.00');
  });

  await check('capture (pdf/OCR): supplier GSTIN matching the company GSTIN -> 400 (cannot derive place of supply)', async () => {
    const bad = pdfText.replace('29AAACS1234F1Z5', '29ABCDE1234F1Z5'); // company's own GSTIN
    const res = await capture({ source: 'pdf', text: bad });
    assert.strictEqual(res.statusCode, 400, res.body.slice(0, 160));
    assert.ok(/supplier GSTIN/.test(res.json().error.message));
  });

  await check('capture: audit trail records the TDS base, rate, and exemption reason', async () => {
    const rows = await all(`SELECT details FROM audit_logs WHERE company_id = ? AND action = 'invoice.captured'`, [co]);
    const row = rows.map((r) => JSON.parse(r.details)).find((d) => d.invoice_no === 'INV-TAX-3');
    assert.ok(row, 'INV-TAX-3 audit row not found');
    assert.strictEqual(row.tds_rate, 0.02);
    assert.strictEqual(row.tds_base, 2500000); // paise: taxable ₹25,000
    assert.strictEqual(row.tds_exempt, true);
    assert.ok(/194C/.test(row.tds_reason));
  });

  // FY aggregate query is used by the endpoint (proves the threshold path works with the DB)
  await check('TDS 194C FY aggregate is read from the DB (prior invoices this FY)', async () => {
    const fy = Tax.fyRange(today);
    const agg = await get('SELECT COALESCE(SUM(gross_amount),0) AS s FROM invoices WHERE company_id = ? AND vendor_id = ? AND invoice_date >= ? AND invoice_date <= ? AND status != ?', [co, 'v-tax', fy.start, fy.end, 'rejected']);
    assert.ok(Number(agg.s) >= RUPEES(500000), 'the two 18% invoices this FY must count toward the 194C aggregate');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FATAL:', e); process.exitCode = 1; });
