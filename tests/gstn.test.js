'use strict';

// Unit tests for the GSP/GSTN adapter (server/src/gstn.js):
//   - GSTR-2B mapping against a real GSP-shaped `b2b` fixture
//   - OTP -> AUTHTOKEN auth contract in mock mode
//   - deterministic mock payload that always produces mismatch flags
//   - e-invoice IRN body generation + mock IRN

const path = require('path');
const os = require('os');
const fs = require('fs');

// Isolate the test database so unit tests never touch the demo DB, and force
// mock mode so the contract tests are deterministic even if GSTN_* vars leak
// in from the environment.
const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'gstn-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
process.env.GSTN_MOCK = '1';
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, run } = require('../server/src/db');
const Gstn = require('../server/src/gstn');
const { uid, nowIso, todayStr } = require('../server/src/util');

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
  taxable_amount: 26250,
  cgst: 2362.5,
  sgst: 2362.5,
  igst: 0,
  gross_amount: 30975,
};

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

(async () => {
  // ---- mode / config without credentials ----
  await check('config: mock mode when unconfigured', () => {
    assert.strictEqual(Gstn.mode(), 'mock');
    const cfg = Gstn.config();
    assert.strictEqual(cfg.provider, 'gstn-via-gsp');
    assert.strictEqual(cfg.enabled, false);
    assert.ok(cfg.missing_env.length >= 5);
    assert.ok(cfg.missing_env.includes('GSTN_GSTIN'));
    assert.ok(cfg.gstr2b_endpoint.includes('{gstin}'));
  });

  // ---- OTP -> AUTHTOKEN contract (mock) ----
  await check('otp: request returns ref in mock mode', async () => {
    const out = await Gstn.requestOtp();
    assert.strictEqual(out.status, 'OTP_REQUESTED');
    assert.strictEqual(out.mode, 'mock');
    assert.ok(out.otp_ref);
  });

  await check('otp: 6-digit OTP authenticates with masked token', async () => {
    const out = await Gstn.validateOtp('123456');
    assert.strictEqual(out.status, 'AUTHENTICATED');
    assert.strictEqual(out.mode, 'mock');
    assert.strictEqual(out.expiry_minutes, 360);
    assert.ok(out.auth_token.startsWith('MOCK-A'));
  });

  await check('otp: invalid OTP rejected', async () => {
    let threw = false;
    try { await Gstn.validateOtp('12'); } catch (e) { threw = !!e.status; }
    assert.ok(threw, 'expected a 400-style error');
  });

  // ---- GSTR-2B mapping against the real fixture ----
  await check('gstr2b: maps b2b rows to snapshot rows', () => {
    const out = Gstn.mapGstr2b(GSTR2B_FIXTURE, { period: '122024', gstin: '29AABCA1234F1Z5' });
    assert.strictEqual(out.period, '122024');
    assert.strictEqual(out.gstin, '29AABCA1234F1Z5');
    assert.strictEqual(out.invoices.length, 2);
    assert.strictEqual(out.invoices[0].invoice_no, 'INV-2024-118');
    assert.strictEqual(out.invoices[0].gstin, '24ACRPP7935N1ZO');
    assert.strictEqual(out.invoices[0].taxable, 26250);
    assert.strictEqual(out.invoices[1].cgst, 48600);
  });

  await check('gstr2b: ITC totals aggregate across rows', () => {
    const out = Gstn.mapGstr2b(GSTR2B_FIXTURE, { period: '122024' });
    assert.strictEqual(out.itc_cgst, 50962.5);
    assert.strictEqual(out.itc_sgst, 50962.5);
    assert.strictEqual(out.itc_igst, 0);
    assert.strictEqual(out.total_itc, 101925);
  });

  await check('gstr2b: comma-formatted string amounts normalize', () => {
    const out = Gstn.mapGstr2b({
      b2b: [{ ctin: '24ACRPP7935N1ZO', docno: 'INV-9', txval: '26,250.00', cgst: '2,362.50', sgst: '2,362.50', igst: '0', cess: '0' }],
    }, { period: '122024' });
    assert.strictEqual(out.invoices[0].taxable, 26250);
    assert.strictEqual(out.invoices[0].cgst, 2362.5);
    assert.strictEqual(out.total_itc, 4725);
  });

  await check('gstr2b: empty payload yields zero rows and current period', () => {
    const out = Gstn.mapGstr2b({ b2b: [], cdnr: [] });
    assert.strictEqual(out.invoices.length, 0);
    assert.strictEqual(out.total_itc, 0);
    assert.strictEqual(out.period, todayStr().slice(0, 7));
    assert.strictEqual(out.source, 'gstn-simulated');
  });

  // ---- deterministic mock always produces mismatch conditions ----
  await check('gstr2b mock: first invoice missing, second at 88% -> mismatches', async () => {
    const coId = 'gstn-unit-' + Date.now();
    const period = todayStr().slice(0, 7);
    const v1 = uid('v'), v2 = uid('v');
    await insert('companies', { id: coId, name: 'Unit Co', gstin: '29AABCA1234F1Z5', city: 'Bengaluru', plan: 'standard', settings: '{}', created_at: nowIso() });
    await insert('vendors', { id: v1, company_id: coId, name: 'Vendor One', gstin: '24ACRPP7935N1ZO', ledger_name: 'Vendor One', tds_section: '194C', tds_rate: 2, credit_days: 30, active: 1 });
    await insert('vendors', { id: v2, company_id: coId, name: 'Vendor Two', gstin: '29AAJPA5678K1Z7', ledger_name: 'Vendor Two', tds_section: '194C', tds_rate: 2, credit_days: 30, active: 1 });
    const invA = { id: uid('inv'), company_id: coId, invoice_no: 'INV-A', vendor_id: v1, invoice_date: todayStr(), due_date: todayStr(), source: 'manual', status: 'approved', gross_amount: 30975, taxable_amount: 26250, cgst: 2362.5, sgst: 2362.5, igst: 0, net_payable: 30975, gstin_vendor: '24ACRPP7935N1ZO', created_at: nowIso() };
    const invB = { id: uid('inv'), company_id: coId, invoice_no: 'INV-B', vendor_id: v2, invoice_date: todayStr(), due_date: todayStr(), source: 'manual', status: 'approved', gross_amount: 637200, taxable_amount: 540000, cgst: 48600, sgst: 48600, igst: 0, net_payable: 637200, gstin_vendor: '29AAJPA5678K1Z7', created_at: nowIso() };
    await insert('invoices', invA);
    await insert('invoices', invB);
    try {
      const raw = await Gstn.fetchGstr2bRaw(coId, period, '29AABCA1234F1Z5');
      assert.strictEqual(raw.gstin, '29AABCA1234F1Z5');
      assert.strictEqual(raw.b2b.length, 1, 'first invoice must be absent from GSTR-2B');
      assert.strictEqual(raw.b2b[0].docno, 'INV-B');
      assert.ok(Math.abs(raw.b2b[0].cgst - Math.round(48600 * 0.88 * 100) / 100) < 0.01, 'second invoice must differ from platform value');
      const mapped = Gstn.mapGstr2b(raw, { period, gstin: '29AABCA1234F1Z5' });
      assert.strictEqual(mapped.invoices.length, 1);
      const platformItc = invA.cgst + invA.sgst + invA.igst;
      const g2bItc = mapped.invoices[0].cgst + mapped.invoices[0].sgst + mapped.invoices[0].igst;
      assert.ok(Math.abs(platformItc - g2bItc) > 1, 'ITC variance must exceed the 1-rupee mismatch threshold');
    } finally {
      await run('DELETE FROM invoices WHERE company_id = ?', [coId]);
      await run('DELETE FROM vendors WHERE company_id = ?', [coId]);
      await run('DELETE FROM companies WHERE id = ?', [coId]);
    }
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
    assert.strictEqual(body.ValDtls.TotInvVal, 30975);
  });

  await check('einvoice: mock IRN generation is deterministic', async () => {
    const a = await Gstn.generateIrn(EINVOICE);
    const b = await Gstn.generateIrn(EINVOICE);
    assert.strictEqual(a.mode, 'mock');
    assert.strictEqual(a.irp_status, 'IRN_GENERATED');
    assert.ok(a.irn.startsWith('IRN-'));
    assert.strictEqual(a.irn, b.irn);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
