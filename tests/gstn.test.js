'use strict';

// Unit tests for the GSP/GSTN adapter (server/src/gstn.js):
//   - GSTR-2B mapping against a real GSP-shaped `b2b` fixture
//   - CDNR (credit/debit note) mapping
//   - e-invoice IRN body generation
//   - unconfigured adapter refuses every live call with 503 (no simulated
//     payloads, no mock OTP — dummy data is not generated anywhere)

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'gstn-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const Gstn = require('../server/src/gstn');
const { todayStr } = require('../server/src/util');

// Fixture: realistic GSP GSTR-2B payload (shape published in GSTN/GSP docs).
const GSTR2B_FIXTURE = {
  gstin: '29AABCA1234F1Z5',
  fp: '122024',
  b2b: [
    {
      cess: 0, cgst: 2362.5, ctin: '24ACRPP7935N1ZO', igst: 0, sgst: 2362.5,
      supfildt: '07-12-2024', docno: 'INV-2024-118', docdt: '02-12-2024',
      txval: 26250, itcAvailed: { itcCgst: 2362.5, itcSgst: 2362.5, itcIgst: 0 },
    },
    {
      cess: 0, cgst: 48600, ctin: '29AAJPA5678K1Z7', igst: 0, sgst: 48600,
      supfildt: '09-12-2024', docno: 'INV-2024-142', docdt: '05-12-2024',
      txval: 540000, itcAvailed: { itcCgst: 48600, itcSgst: 48600, itcIgst: 0 },
    },
  ],
  cdnr: [],
  isda: [],
};

const EINVOICE = {
  invoice_no: 'INV-2026-101',
  invoice_date: '2026-08-03',
  gstin_vendor: '24ACRPP7935N1ZO',
  vendor_name: 'Vendor One',
  taxable_amount: 2625000,
  cgst: 236250,
  sgst: 236250,
  igst: 0,
  gross_amount: 3097500,
};

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

(async () => {
  // ---- mode / config without credentials ----
  await check('config: disabled mode when unconfigured', () => {
    assert.strictEqual(Gstn.mode(), 'disabled');
    const cfg = Gstn.config();
    assert.strictEqual(cfg.provider, 'gstn-via-gsp');
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.mode, 'disabled');
    assert.ok(cfg.missing_env.length >= 5);
    assert.ok(cfg.missing_env.includes('GSTN_GSTIN'));
    assert.ok(cfg.gstr2b_endpoint.includes('{gstin}'));
  });

  // ---- unconfigured guardrails: no simulated OTP / payloads / IRNs ----
  await check('unconfigured: OTP request refused with 503', async () => {
    let status = null;
    try { await Gstn.requestOtp(); } catch (e) { status = e.status; }
    assert.strictEqual(status, 503);
  });

  await check('unconfigured: OTP validate refused with 503', async () => {
    let status = null;
    try { await Gstn.validateOtp('123456'); } catch (e) { status = e.status; }
    assert.strictEqual(status, 503);
  });

  await check('unconfigured: GSTR-2B fetch refused with 503', async () => {
    let status = null;
    try { await Gstn.fetchGstr2bRaw('co', '2024-04', '29AABCA1234F1Z5'); } catch (e) { status = e.status; }
    assert.strictEqual(status, 503);
  });

  await check('unconfigured: IRN generation refused with 503', async () => {
    let status = null;
    try { await Gstn.generateIrn(EINVOICE); } catch (e) { status = e.status; }
    assert.strictEqual(status, 503);
  });

  await check('config: credentials are read lazily, not at require time', () => {
    process.env.GSTN_GSTIN = '29AABCA1234F1Z5';
    process.env.GSTN_USERNAME = 'u';
    process.env.GSTN_APP_KEY = 'k';
    process.env.GSTN_CLIENT_ID = 'c';
    process.env.GSTN_CLIENT_SECRET = 's';
    try {
      assert.strictEqual(Gstn.mode(), 'live');
      assert.strictEqual(Gstn.config().enabled, true);
    } finally {
      delete process.env.GSTN_GSTIN;
      delete process.env.GSTN_USERNAME;
      delete process.env.GSTN_APP_KEY;
      delete process.env.GSTN_CLIENT_ID;
      delete process.env.GSTN_CLIENT_SECRET;
    }
    assert.strictEqual(Gstn.mode(), 'disabled');
  });

  // ---- GSTR-2B mapping against the real fixture ----
  await check('gstr2b: maps b2b rows to snapshot rows', () => {
    const out = Gstn.mapGstr2b(GSTR2B_FIXTURE, { period: '122024', gstin: '29AABCA1234F1Z5' });
    assert.strictEqual(out.period, '122024');
    assert.strictEqual(out.gstin, '29AABCA1234F1Z5');
    assert.strictEqual(out.invoices.length, 2);
    assert.strictEqual(out.invoices[0].invoice_no, 'INV-2024-118');
    assert.strictEqual(out.invoices[0].gstin, '24ACRPP7935N1ZO');
    assert.strictEqual(out.invoices[0].taxable, 2625000); // paise
    assert.strictEqual(out.invoices[1].cgst, 4860000); // paise
    assert.strictEqual(out.source, 'gstn-live');
  });

  await check('gstr2b: ITC totals aggregate across rows', () => {
    const out = Gstn.mapGstr2b(GSTR2B_FIXTURE, { period: '122024' });
    assert.strictEqual(out.itc_cgst, 5096250);
    assert.strictEqual(out.itc_sgst, 5096250);
    assert.strictEqual(out.itc_igst, 0);
    assert.strictEqual(out.total_itc, 10192500);
  });

  await check('gstr2b: comma-formatted string amounts normalize', () => {
    const out = Gstn.mapGstr2b({
      b2b: [{ ctin: '24ACRPP7935N1ZO', docno: 'INV-9', txval: '26,250.00', cgst: '2,362.50', sgst: '2,362.50', igst: '0', cess: '0' }],
    }, { period: '122024' });
    assert.strictEqual(out.invoices[0].taxable, 2625000);
    assert.strictEqual(out.invoices[0].cgst, 236250);
    assert.strictEqual(out.total_itc, 472500);
  });

  await check('gstr2b: empty payload yields zero rows and current period', () => {
    const out = Gstn.mapGstr2b({ b2b: [], cdnr: [] });
    assert.strictEqual(out.invoices.length, 0);
    assert.strictEqual(out.total_itc, 0);
    assert.strictEqual(out.period, todayStr().slice(0, 7));
    assert.strictEqual(out.source, 'gstn-live');
  });

  await check('gstr2b: maps cdnr credit/debit note rows', () => {
    const out = Gstn.mapGstr2b({
      ...GSTR2B_FIXTURE,
      cdnr: [
        { ctin: '24ACRPP7935N1ZO', docno: 'CN-2024-1', docdt: '04-12-2024', txval: 20000, cgst: 1800, sgst: 1800, igst: 0, typ: 'C' },
        { ctin: '24ACRPP7935N1ZO', docno: 'DN-2024-2', docdt: '06-12-2024', txval: '10,000.00', cgst: '900.00', sgst: '900.00', igst: '0', typ: 'D' },
      ],
    }, { period: '122024' });
    assert.strictEqual(out.cdnr.length, 2);
    assert.strictEqual(out.credit_notes, 2);
    assert.strictEqual(out.cdnr[0].invoice_no, 'CN-2024-1');
    assert.strictEqual(out.cdnr[0].gstin, '24ACRPP7935N1ZO');
    assert.strictEqual(out.cdnr[0].taxable, 2000000);
    assert.strictEqual(out.cdnr[0].doc_type, 'C');
    assert.strictEqual(out.cdnr[1].taxable, 1000000); // comma-formatted normalized
    assert.strictEqual(out.cdnr[1].doc_type, 'D');
    assert.strictEqual(out.total_itc, 10192500); // CDNR rows do not inflate ITC totals
  });

  // ---- e-invoice (IRP) contract stub ----
  await check('einvoice: IRN body is valid B2B v1.03', () => {
    const body = Gstn.buildEinvoiceBody(EINVOICE, {
      seller: { gstin: '29AABCA1234F1Z5', name: 'Acme Industries Pvt Ltd', addr: 'Bengaluru 560001' },
      buyer: { gstin: '24ACRPP7935N1ZO', name: 'Vendor One', addr: 'Ahmedabad' },
    });
    assert.strictEqual(body.Version, '1.03');
    assert.strictEqual(body.TranDtls.SupTyp, 'B2B');
    assert.strictEqual(body.SellerDtls.Gstin, '29AABCA1234F1Z5');
    assert.strictEqual(body.BuyerDtls.Gstin, '24ACRPP7935N1ZO');
    assert.strictEqual(body.DocDtls.No, 'INV-2026-101');
    assert.strictEqual(body.ItemList.length, 1);
    assert.strictEqual(body.ItemList[0].HsnCd, '9988');
    assert.strictEqual(body.ValDtls.TotInvVal, '30975.00');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
