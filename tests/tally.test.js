'use strict';

// Unit tests for the Tally XML toolkit (server/src/tally.js) — the cloud-only
// path. Covers real-world Tally export variants: VCHNUM/VCHDATE, VCHTYPE
// attributes, entries-derived amounts, XML entities, BOM, raw (wrapper-less)
// voucher files, and voucher builders.

const assert = require('assert');
const Tally = require('../server/src/tally');
const { extractBlocksWithAttrs, attr, tag, num, deriveAmount } = Tally._internals;

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

// Typical Tally "Voucher Register" XML export (ENVELOPE wrapped).
const VOUCHER_EXPORT = [
  '<?xml version="1.0"?>',
  '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><DATA>',
  '<TALLYMESSAGE><COMPANY><NAME>Acme Industries Pvt Ltd</NAME></COMPANY></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create" OBJVIEW="Invoice Voucher View">',
  '<DATE>20260730</DATE><VCHNUM>PV-1</VCHNUM><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
  '<PARTYLEDGERNAME>Global Freight LLP</PARTYLEDGERNAME>',
  '<LEDGERENTRIES><LEDGERENTRY><LEDGERNAME>Global Freight LLP</LEDGERNAME><AMOUNT>455000</AMOUNT></LEDGERENTRY>',
  '<LEDGERENTRY><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>-455000</AMOUNT></LEDGERENTRY></LEDGERENTRIES>',
  '</VOUCHER></TALLYMESSAGE>',
  '</DATA></BODY></ENVELOPE>',
].join('');

check('parse: real voucher export — VCHNUM, DATE, VCHTYPE attr, entries', () => {
  const d = Tally.parseExport(VOUCHER_EXPORT);
  assert.strictEqual(d.company, 'Acme Industries Pvt Ltd');
  assert.strictEqual(d.vouchers.length, 1);
  const v = d.vouchers[0];
  assert.strictEqual(v.voucher_number, 'PV-1'); // <VCHNUM> mapped
  assert.strictEqual(v.voucher_type, 'Payment'); // <VOUCHERTYPENAME> wins
  assert.strictEqual(v.date, '2026-07-30'); // YYYYMMDD normalized
  assert.strictEqual(v.amount, 455000); // party-ledger entry amount
  assert.strictEqual(v.party_name, 'Global Freight LLP');
  assert.strictEqual(v.entries.length, 2);
});

// Mirror of Tally's official sample XML (help.tallysolutions.com/sample-xml/):
// uppercase <GROUP>/<LEDGER> masters with NAME + PARENT, mixed-case
// <Ledger NAME="..." Action="Alter"> with address fields, and a Payment
// voucher using <PARTYNAME> with entries wrapped in <LEDGERENTRIES.LIST>.
const OFFICIAL_SAMPLE = [
  '<?xml version="1.0"?>',
  '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><DATA>',
  '<TALLYMESSAGE><COMPANY><NAME>Acme Industries Pvt Ltd</NAME></COMPANY></TALLYMESSAGE>',
  '<TALLYMESSAGE><GROUP Action="Create"><NAME>North Zone Debtors</NAME><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>',
  '<TALLYMESSAGE><LEDGER Action="Create"><NAME>Customer ABC</NAME><PARENT>North Zone Debtors</PARENT></LEDGER></TALLYMESSAGE>',
  '<TALLYMESSAGE><Ledger NAME="Customer ABC" Action="Alter">',
  '<MAILINGNAME.LIST TYPE="String"><MAILINGNAME>Customer - Mailing name</MAILINGNAME></MAILINGNAME.LIST>',
  '<ADDRESS.LIST TYPE="String"><ADDRESS>Door No</ADDRESS><ADDRESS>Lane</ADDRESS></ADDRESS.LIST>',
  '<PINCODE>560068</PINCODE><COUNTRYNAME>India</COUNTRYNAME><LEDSTATENAME>Karnataka</LEDSTATENAME>',
  '<EMAIL>A@abc.com</EMAIL><EMAILCC>ACC@abc.com</EMAILCC>',
  '<LEDGERPHONE>0888888</LEDGERPHONE><LEDGERMOBILE>99999999</LEDGERMOBILE>',
  '</Ledger></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create">',
  '<DATE>20260730</DATE><VOUCHERNUMBER>PV-2</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
  '<PARTYNAME>Customer ABC</PARTYNAME>',
  '<LEDGERENTRIES.LIST><LEDGERENTRY><LEDGERNAME>Customer ABC</LEDGERNAME><AMOUNT>25000</AMOUNT></LEDGERENTRY>',
  '<LEDGERENTRY><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>-25000</AMOUNT></LEDGERENTRY></LEDGERENTRIES.LIST>',
  '</VOUCHER></TALLYMESSAGE>',
  '</DATA></BODY></ENVELOPE>',
].join('');

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
  assert.strictEqual(v.amount, 25000); // party entry read through <LEDGERENTRIES.LIST>
  assert.strictEqual(v.entries.length, 2);
});

// Faithful to Tally's Voucher Register export: flat <LEDGERENTRIES.LIST>
// entries (one block per ledger), inventory <ACCOUNTINGALLOCATIONS.LIST>,
// company carried in <STATICVARIABLES><SVCURRENTCOMPANY>, no masters.
const VOUCHER_ONLY_EXPORT = [
  '<?xml version="1.0"?>',
  '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST>',
  '<STATICVARIABLES><SVCURRENTCOMPANY>Demo Traders Pvt Ltd</SVCURRENTCOMPANY></STATICVARIABLES></HEADER><BODY><DATA>',
  '<TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20240401</DATE>',
  '<VOUCHERNUMBER>SL/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>',
  '<PARTYNAME>Sharma Enterprises</PARTYNAME><PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
  '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>HP Laptop</STOCKITEMNAME><AMOUNT>104000.00</AMOUNT>',
  '<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>104000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>',
  '</ALLINVENTORYENTRIES.LIST>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><AMOUNT>2812.50</AMOUNT></LEDGERENTRIES.LIST>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><AMOUNT>2812.50</AMOUNT></LEDGERENTRIES.LIST>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><AMOUNT>-116125.00</AMOUNT></LEDGERENTRIES.LIST>',
  '</VOUCHER></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create"><DATE>20240405</DATE>',
  '<VOUCHERNUMBER>PY/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
  '<PARTYLEDGERNAME>HDFC Bank - Current A/c</PARTYLEDGERNAME>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><AMOUNT>-25000.00</AMOUNT></LEDGERENTRIES.LIST>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><AMOUNT>25000.00</AMOUNT></LEDGERENTRIES.LIST>',
  '</VOUCHER></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt" ACTION="Create"><DATE>20240408</DATE>',
  '<VOUCHERNUMBER>RC/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>',
  '<PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><AMOUNT>-75000.00</AMOUNT></LEDGERENTRIES.LIST>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><AMOUNT>75000.00</AMOUNT></LEDGERENTRIES.LIST>',
  '</VOUCHER></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER VCHTYPE="Journal" ACTION="Create"><DATE>20240410</DATE>',
  '<VOUCHERNUMBER>JV/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Depreciation</LEDGERNAME><AMOUNT>-3500.00</AMOUNT></LEDGERENTRIES.LIST>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Office Equipment</LEDGERNAME><AMOUNT>3500.00</AMOUNT></LEDGERENTRIES.LIST>',
  '</VOUCHER></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER VCHTYPE="Contra" ACTION="Create"><DATE>20240412</DATE>',
  '<VOUCHERNUMBER>CN/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Contra</VOUCHERTYPENAME>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><AMOUNT>-40000.00</AMOUNT></LEDGERENTRIES.LIST>',
  '<LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>40000.00</AMOUNT></LEDGERENTRIES.LIST>',
  '</VOUCHER></TALLYMESSAGE>',
  '</DATA></BODY></ENVELOPE>',
].join('');

check('parse: voucher-register export — flat LEDGERENTRIES.LIST + inventory allocations', () => {
  const d = Tally.parseExport(VOUCHER_ONLY_EXPORT);
  assert.strictEqual(d.company, 'Demo Traders Pvt Ltd'); // SVCURRENTCOMPANY fallback
  assert.strictEqual(d.groups.length, 0);
  assert.strictEqual(d.ledgers.length, 0);
  assert.strictEqual(d.vouchers.length, 5);
  const byNum = Object.fromEntries(d.vouchers.map((v) => [v.voucher_number, v]));
  const sl = byNum['SL/24-25/001'];
  assert.strictEqual(sl.amount, -116125); // party entry wins over allocation amounts
  assert.strictEqual(sl.party_name, 'Sharma Enterprises');
  assert.strictEqual(sl.entries.length, 4); // Sales Account + CGST + SGST + party
  assert.strictEqual(byNum['PY/24-25/001'].amount, 25000); // bank party entry
  assert.strictEqual(byNum['RC/24-25/001'].amount, 75000);
  assert.strictEqual(byNum['JV/24-25/001'].amount, 3500); // no party -> largest, positive tie
  assert.strictEqual(byNum['JV/24-25/001'].party_name, null);
  assert.strictEqual(byNum['CN/24-25/001'].amount, 40000);
});

// Variant used by some releases: VCHDATE + no VOUCHERTYPENAME, type only on
// the attribute, no voucher-level amount, party entry absent -> largest entry.
const VOUCHER_VARIANT = [
  '<VOUCHER VCHTYPE="Receipt">',
  '<VCHDATE>2026-08-01</VCHDATE><VOUCHERNUMBER>RC-9</VOUCHERNUMBER>',
  '<PARTYLEDGERNAME>Nexus Retail Pvt Ltd</PARTYLEDGERNAME>',
  '<LEDGERENTRIES><LEDGERENTRY><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>125000</AMOUNT></LEDGERENTRY>',
  '<LEDGERENTRY><LEDGERNAME>Nexus Retail Pvt Ltd</LEDGERNAME><AMOUNT>-125000</AMOUNT></LEDGERENTRY></LEDGERENTRIES>',
  '</VOUCHER>',
].join('');

check('parse: VCHDATE + attribute-only type + entries-derived amount', () => {
  const d = Tally.parseExport(VOUCHER_VARIANT);
  assert.strictEqual(d.vouchers.length, 1);
  const v = d.vouchers[0];
  assert.strictEqual(v.voucher_number, 'RC-9');
  assert.strictEqual(v.voucher_type, 'Receipt'); // from VCHTYPE attribute
  assert.strictEqual(v.date, '2026-08-01');
  assert.strictEqual(v.amount, -125000); // party entry (Nexus, -125000) drives the amount
});

check('parse: BOM, XML declaration and missing ENVELOPE are tolerated', () => {
  const raw = '\uFEFF<?xml version="1.0"?><VOUCHER><DATE>20260701</DATE><VCHNUM>X-1</VCHNUM><AMOUNT>1000</AMOUNT></VOUCHER>';
  const d = Tally.parseExport(raw);
  assert.strictEqual(d.vouchers.length, 1);
  assert.strictEqual(d.vouchers[0].amount, 1000); // explicit <AMOUNT> wins
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

check('helpers: attributes, tags and numbers', () => {
  assert.strictEqual(attr('VCHTYPE="Payment" ACTION="Create"', 'VCHTYPE'), 'Payment');
  assert.strictEqual(tag('<NAME>Sai Traders &amp; Co</NAME>', 'NAME'), 'Sai Traders & Co');
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
    { invoice_no: 'INV-2026-118', invoice_date: '2026-08-02', gross_amount: 2119010, taxable_amount: 1850000, cgst: 158760, sgst: 166500, igst: 0, tds_amount: 46250, net_payable: 2072760 },
    { ledger_name: 'Sundry Creditors - Shree Cement', name: 'Shree Cement Traders' }
  );
  assert.ok(xml.includes('VCHTYPE="Purchase"'));
  assert.ok(xml.includes('<LEDGERNAME>Input CGST</LEDGERNAME>'));
  assert.ok(xml.includes('<LEDGERNAME>Input SGST</LEDGERNAME>'));
  assert.ok(xml.includes('<LEDGERNAME>TDS Payable</LEDGERNAME>'));
  assert.ok(xml.includes('<AMOUNT>2072760</AMOUNT>'));
});

check('voucher builder: payment voucher debits bank', () => {
  const xml = Tally.buildPaymentVoucher(
    { reference: 'NEFT-99012345', amount: 455000, net_amount: 445900, processed_at: '2026-08-03T09:00:00Z' },
    { ledger_name: 'Sundry Creditors - Global Freight', name: 'Global Freight LLP' }
  );
  assert.ok(xml.includes('VCHTYPE="Payment"'));
  assert.ok(xml.includes('<LEDGERNAME>Bank</LEDGERNAME>'));
  assert.ok(xml.includes('<AMOUNT>-445900</AMOUNT>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
