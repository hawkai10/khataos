'use strict';

// Unit tests for the Tally XML toolkit (server/src/tally.js) — the cloud-only
// path. Covers real-world Tally export variants: VCHNUM/VCHDATE, VCHTYPE
// attributes, entries-derived amounts, XML entities, BOM, raw (wrapper-less)
// voucher files, and voucher builders.

const assert = require('assert');
const Tally = require('../server/src/tally');
const { blocksOf, valueOf, attrOf, num, deriveAmount } = Tally._internals;
const { VOUCHER_EXPORT, OFFICIAL_SAMPLE, VOUCHER_ONLY_EXPORT, VOUCHER_VARIANT, RAW_VOUCHER, IDENTITY_EXPORT } = require('./fixtures/tally-xml');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

check('config: cloud-upload only, always available', () => {
  const c = Tally.config();
  assert.strictEqual(c.provider, 'tally-xml-upload');
  assert.strictEqual(c.mode, 'cloud-upload');
  assert.strictEqual(c.enabled, true);
});

check('parse: real voucher export — VCHNUM, DATE, VCHTYPE attr, entries', () => {
  const d = Tally.parseExport(VOUCHER_EXPORT);
  assert.strictEqual(d.company, 'Acme Industries Pvt Ltd');
  assert.strictEqual(d.vouchers.length, 1);
  const v = d.vouchers[0];
  assert.strictEqual(v.voucher_number, 'PV-1'); // <VCHNUM> mapped
  assert.strictEqual(v.voucher_type, 'Payment'); // <VOUCHERTYPENAME> wins
  assert.strictEqual(v.date, '2026-07-30'); // YYYYMMDD normalized
  assert.strictEqual(v.amount, 45500000); // party-ledger entry amount (paise)
  assert.strictEqual(v.party_name, 'Global Freight LLP');
  assert.strictEqual(v.entries.length, 2);
});

check('parse: official Tally sample XML — mixed-case tags, PARTYNAME, LEDGERENTRIES.LIST', () => {
  const d = Tally.parseExport(OFFICIAL_SAMPLE);
  assert.strictEqual(d.company, 'Acme Industries Pvt Ltd');
  assert.strictEqual(d.groups.length, 1);
  assert.strictEqual(d.groups[0].name, 'North Zone Debtors');
  assert.strictEqual(d.groups[0].parent, 'Sundry Debtors');
  assert.strictEqual(d.ledgers.length, 1); // Alter block has no <NAME>, so only the Create ledger
  assert.strictEqual(d.ledgers[0].name, 'Customer ABC');
  assert.strictEqual(d.ledgers[0].group_name, 'North Zone Debtors');
  assert.strictEqual(d.vouchers.length, 1);
  const v = d.vouchers[0];
  assert.strictEqual(v.voucher_number, 'PV-2');
  assert.strictEqual(v.party_name, 'Customer ABC'); // <PARTYNAME> fallback when PARTYLEDGERNAME absent
  assert.strictEqual(v.amount, 2500000); // party entry read through <LEDGERENTRIES.LIST>
  assert.strictEqual(v.entries.length, 2);
});

check('parse: voucher-register export — flat LEDGERENTRIES.LIST + inventory allocations', () => {
  const d = Tally.parseExport(VOUCHER_ONLY_EXPORT);
  assert.strictEqual(d.company, 'Demo Traders Pvt Ltd'); // SVCURRENTCOMPANY fallback
  assert.strictEqual(d.groups.length, 0);
  assert.strictEqual(d.ledgers.length, 0);
  assert.strictEqual(d.vouchers.length, 5);
  const byNum = Object.fromEntries(d.vouchers.map((v) => [v.voucher_number, v]));
  const sl = byNum['SL/24-25/001'];
  assert.strictEqual(sl.amount, -11612500); // party entry wins over allocation amounts
  assert.strictEqual(sl.party_name, 'Sharma Enterprises');
  assert.strictEqual(sl.entries.length, 4); // Sales Account + CGST + SGST + party
  assert.strictEqual(byNum['PY/24-25/001'].amount, 2500000); // bank party entry
  assert.strictEqual(byNum['RC/24-25/001'].amount, 7500000);
  assert.strictEqual(byNum['JV/24-25/001'].amount, 350000); // no party -> largest, positive tie
  assert.strictEqual(byNum['JV/24-25/001'].party_name, null);
  assert.strictEqual(byNum['CN/24-25/001'].amount, 4000000);
});

check('parse: VCHDATE + attribute-only type + entries-derived amount', () => {
  const d = Tally.parseExport(VOUCHER_VARIANT);
  assert.strictEqual(d.vouchers.length, 1);
  const v = d.vouchers[0];
  assert.strictEqual(v.voucher_number, 'RC-9');
  assert.strictEqual(v.voucher_type, 'Receipt'); // from VCHTYPE attribute
  assert.strictEqual(v.date, '2026-08-01');
  assert.strictEqual(v.amount, -12500000); // party entry (Nexus, -125000) drives the amount
});

check('parse: BOM, XML declaration and missing ENVELOPE are tolerated', () => {
  const d = Tally.parseExport(RAW_VOUCHER);
  assert.strictEqual(d.vouchers.length, 1);
  assert.strictEqual(d.vouchers[0].amount, 100000); // explicit <AMOUNT> wins (paise)
});

check('parse: GUID, ALTERID and ISCANCELLED survive the new parser intact', () => {
  const d = Tally.parseExport(IDENTITY_EXPORT);
  assert.strictEqual(d.company, 'Acme Industries & Sons'); // entity decoded
  assert.strictEqual(d.groups.length, 2);
  const sc = d.groups.find((g) => g.name === 'Sundry Creditors');
  assert.strictEqual(sc.parent, 'Current Liabilities');
  assert.strictEqual(sc.tally_guid, 'g-sc');
  assert.strictEqual(sc.tally_alterid, 1);
  const ledger = d.ledgers.find((l) => l.name === 'Sai Traders & Co');
  assert.strictEqual(ledger.gstin, '29AABCS7788K1Z4');
  assert.strictEqual(ledger.tally_guid, 'g-led');
  assert.strictEqual(ledger.tally_alterid, 3);
  const v = d.vouchers[0];
  assert.strictEqual(v.voucher_number, 'PU-1');
  assert.strictEqual(v.voucher_type, 'Purchase');
  assert.strictEqual(v.date, '2026-07-30');
  assert.strictEqual(v.amount, 11800000);
  assert.strictEqual(v.tally_guid, 'g-vch');
  assert.strictEqual(v.tally_alterid, 7);
  assert.strictEqual(v.cancelled, true);
  assert.strictEqual(v.entries.length, 3);
  const partyEntry = v.entries.find((e) => e.ledger === 'Sai Traders & Co');
  assert.deepStrictEqual(partyEntry.bill_refs, ['INV-ALPHA-1']);
  assert.strictEqual(v.entries[0].positive, true);
  assert.strictEqual(partyEntry.positive, false);
});

check('parse: ISCANCELLED Yes flags cancelled; absent stays false', () => {
  const xml = [
    '<VOUCHER><DATE>20260701</DATE><VCHNUM>X-C</VCHNUM><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><AMOUNT>1000</AMOUNT><ISCANCELLED>Yes</ISCANCELLED></VOUCHER>',
    '<VOUCHER><DATE>20260702</DATE><VCHNUM>X-2</VCHNUM><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><AMOUNT>2000</AMOUNT></VOUCHER>',
  ].join('');
  const d = Tally.parseExport(xml);
  const byNum = Object.fromEntries(d.vouchers.map((v) => [v.voucher_number, v]));
  assert.strictEqual(byNum['X-C'].cancelled, true);
  assert.strictEqual(byNum['X-2'].cancelled, false); // absent tag -> not cancelled
});

check('parse: XML entities decoded (vendor names with &amp;)', () => {
  const xml = '<LEDGER><NAME>Sai Traders &amp; Co</NAME><PARENT>Sundry Creditors</PARENT></LEDGER>';
  const d = Tally.parseExport(xml);
  assert.strictEqual(d.ledgers[0].name, 'Sai Traders & Co');
});

check('parse: empty/garbage input never throws', () => {
  assert.deepStrictEqual(Tally.parseExport(''), { company: null, groups: [], ledgers: [], vouchers: [] });
  assert.strictEqual(Tally.parseExport('<broken').vouchers.length, 0);
  assert.strictEqual(Tally.parseExport('plain text').vouchers.length, 0);
});

check('helpers: parsed-object accessors and numbers', () => {
  assert.strictEqual(attrOf({ '@_VCHTYPE': 'Payment', '@_ACTION': 'Create' }, 'VCHTYPE'), 'Payment');
  assert.strictEqual(attrOf({ '@_VCHTYPE': 'Payment' }, 'vchtype'), 'Payment'); // case-insensitive
  assert.strictEqual(valueOf({ NAME: 'Sai Traders & Co' }, 'NAME'), 'Sai Traders & Co');
  assert.strictEqual(valueOf({ NAME: { '#text': ' padded ' } }, 'NAME'), 'padded');
  assert.strictEqual(valueOf({ NAME: 'X' }, 'MISSING'), null);
  assert.strictEqual(blocksOf({ LEDGER: [{ NAME: 'A' }, { NAME: 'B' }] }, 'LEDGER').length, 2);
  assert.strictEqual(blocksOf({ LEDGER: { NAME: 'A' } }, 'LEDGER').length, 1); // single -> array
  assert.strictEqual(blocksOf({ Ledger: { NAME: 'A' } }, 'LEDGER').length, 1); // mixed case
  assert.strictEqual(num('45,50,000.50'), 4550000.5);
  assert.strictEqual(num('not-a-number'), null);
  assert.strictEqual(num(null), null);
  assert.strictEqual(deriveAmount([{ ledger: 'A', amount: 100 }, { ledger: 'B', amount: -100 }], 'B'), -100);
  assert.strictEqual(deriveAmount([], 'X'), 0);
});

check('date normalization: YYYYMMDD and YYYY-MM-DD; invalid -> null', () => {
  assert.strictEqual(Tally.normalizeTallyDate('20260730'), '2026-07-30');
  assert.strictEqual(Tally.normalizeTallyDate('2026-07-30'), '2026-07-30');
  assert.strictEqual(Tally.normalizeTallyDate('30/07/2026'), null);
});

check('voucher builder: purchase voucher with GST/TDS entries', () => {
  const xml = Tally.buildPurchaseVoucher(
    { invoice_no: 'INV-2026-118', invoice_date: '2026-08-02', gross_amount: 211901000, taxable_amount: 185000000, cgst: 15876000, sgst: 16650000, igst: 0, tds_amount: 4625000, net_payable: 207276000 },
    { ledger_name: 'Sundry Creditors - Shree Cement', name: 'Shree Cement Traders' }
  );
  assert.ok(xml.includes('VCHTYPE="Purchase"'));
  assert.ok(xml.includes('<LEDGERNAME>Input CGST</LEDGERNAME>'));
  assert.ok(xml.includes('<LEDGERNAME>Input SGST</LEDGERNAME>'));
  assert.ok(xml.includes('<LEDGERNAME>TDS Payable</LEDGERNAME>'));
  assert.ok(xml.includes('<AMOUNT>2072760.00</AMOUNT>'));
});

check('voucher builder: payment voucher debits bank', () => {
  const xml = Tally.buildPaymentVoucher(
    { reference: 'NEFT-99012345', amount: 45500000, net_amount: 44590000, processed_at: '2026-08-03T09:00:00Z' },
    { ledger_name: 'Sundry Creditors - Global Freight', name: 'Global Freight LLP' }
  );
  assert.ok(xml.includes('VCHTYPE="Payment"'));
  assert.ok(xml.includes('<LEDGERNAME>Bank</LEDGERNAME>'));
  assert.ok(xml.includes('<AMOUNT>-445900.00</AMOUNT>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
