'use strict';

// Unit tests for the cloud Tally XML import pipeline: parse -> validate ->
// sequenced import (Groups -> Ledgers -> Vouchers) with dedupe.

const path = require('path');
const os = require('os');
const fs = require('fs');

// `node tests/tally-import.test.js --pg` runs on pglite instead of SQLite so
// the Drizzle query-builder path is exercised on the PostgreSQL dialect too.
if (process.argv.includes('--pg')) {
  process.env.KHATAOS_DB_ENGINE = 'pglite';
  delete process.env.KHATAOS_PGLITE_DIR;
  console.log('DB engine: in-process PostgreSQL (pglite)');
}

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'tally-import-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const Tally = require('../server/src/tally');
const TallyImport = require('../server/src/tally-import');
const { all, get } = require('../server/src/db');

const SAMPLE = [
  '<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><DATA>',
  '<TALLYMESSAGE><COMPANY><NAME>Acme Industries Pvt Ltd</NAME></COMPANY></TALLYMESSAGE>',
  '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
  '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
  '<TALLYMESSAGE><GROUP><NAME>Bank Accounts</NAME></GROUP></TALLYMESSAGE>',
  '<TALLYMESSAGE><LEDGER><NAME>Sai Traders &amp; Co</NAME><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>92040</OPENINGBALANCE></LEDGER></TALLYMESSAGE>',
  '<TALLYMESSAGE><LEDGER><NAME>Bank</NAME><PARENT>Bank Accounts</PARENT></LEDGER></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER><VOUCHERNUMBER>PV-1</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><DATE>20260730</DATE><PARTYLEDGERNAME>Sai Traders &amp; Co</PARTYLEDGERNAME><AMOUNT>-455000</AMOUNT><LEDGERENTRIES><LEDGERENTRY><LEDGERNAME>Sai Traders &amp; Co</LEDGERNAME><AMOUNT>455000</AMOUNT></LEDGERENTRY><LEDGERENTRY><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>-455000</AMOUNT></LEDGERENTRY></LEDGERENTRIES></VOUCHER></TALLYMESSAGE>',
  '</DATA></BODY></ENVELOPE>',
].join('');

const BAD_REFERENCE = [
  '<ENVELOPE><BODY><DATA>',
  '<TALLYMESSAGE><LEDGER><NAME>Orphan Ledger</NAME><PARENT>Missing Group</PARENT></LEDGER></TALLYMESSAGE>',
  '<TALLYMESSAGE><VOUCHER><VOUCHERNUMBER>PV-X</VOUCHERNUMBER><DATE>2026-08-01</DATE><PARTYLEDGERNAME>Unknown Ledger</PARTYLEDGERNAME><AMOUNT>1000</AMOUNT></VOUCHER></TALLYMESSAGE>',
  '</DATA></BODY></ENVELOPE>',
].join('');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

(async () => {
  const coId = 'tally-import-' + Date.now();

  await check('parse: extracts company, groups, ledgers, vouchers', () => {
    const d = Tally.parseExport(SAMPLE);
    assert.strictEqual(d.company, 'Acme Industries Pvt Ltd');
    assert.strictEqual(d.groups.length, 3);
    assert.strictEqual(d.ledgers.length, 2);
    assert.strictEqual(d.vouchers.length, 1);
    assert.strictEqual(d.ledgers[0].name, 'Sai Traders & Co'); // XML entity unescaped
    assert.strictEqual(d.ledgers[0].group_name, 'Sundry Creditors');
    assert.strictEqual(d.vouchers[0].date, '2026-07-30'); // YYYYMMDD normalized
    assert.strictEqual(d.vouchers[0].amount, -455000);
  });

  await check('import: valid export imports in sequence with dedupe', async () => {
    const r1 = await TallyImport.handleImport(coId, SAMPLE);
    assert.strictEqual(r1.parsed.groups, 3);
    assert.strictEqual(r1.imported.groups.imported, 3);
    assert.strictEqual(r1.imported.ledgers.imported, 2);
    assert.strictEqual(r1.imported.vouchers.imported, 1);
    assert.strictEqual(r1.validation.errors.length, 0);

    const r2 = await TallyImport.handleImport(coId, SAMPLE); // idempotent
    assert.strictEqual(r2.imported.groups.imported + r2.imported.ledgers.imported + r2.imported.vouchers.imported, 0);

    const groups = await all('SELECT name, parent FROM tally_groups WHERE company_id = ?', [coId]);
    const ledgers = await all('SELECT name, group_name, opening_balance FROM tally_ledgers WHERE company_id = ?', [coId]);
    const vouchers = await all('SELECT voucher_number, date, amount FROM tally_vouchers WHERE company_id = ?', [coId]);
    assert.deepStrictEqual(groups.sort((a, b) => a.name.localeCompare(b.name)).map((g) => g.name), ['Bank Accounts', 'Current Liabilities', 'Sundry Creditors']);
    const sai = ledgers.find((l) => l.name === 'Sai Traders & Co');
    assert.strictEqual(sai.group_name, 'Sundry Creditors');
    assert.strictEqual(sai.opening_balance, 92040);
    assert.strictEqual(vouchers[0].voucher_number, 'PV-1');
  });

  await check('validation: missing group / party ledger are reported and skipped', async () => {
    const r = await TallyImport.handleImport(coId, BAD_REFERENCE);
    // The missing-group error remains; the unknown party ledger is now
    // auto-created (warning) so the voucher can still import.
    assert.strictEqual(r.validation.errors.length, 1);
    const autoWarn = r.validation.warnings.find((w) => w.type === 'auto-ledger' && w.record === 'Unknown Ledger');
    assert.ok(autoWarn, 'expected an auto-ledger warning, got: ' + JSON.stringify(r.validation.warnings));
    assert.strictEqual(r.imported.ledgers.imported, 1); // Unknown Ledger auto-created
    assert.strictEqual(r.imported.vouchers.imported, 1);
  });

  await check('validation: ledger without PARENT group emits warning (Tally requires a group)', async () => {
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><LEDGER><NAME>Orphan Ledger</NAME><OPENINGBALANCE>1000</OPENINGBALANCE></LEDGER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');
    const r = await TallyImport.handleImport(coId, xml);
    const warn = r.validation.warnings.find((w) => w.type === 'ledger' && w.record === 'Orphan Ledger');
    assert.ok(warn, 'expected a PARENT-group warning, got: ' + JSON.stringify(r.validation.warnings));
    assert.strictEqual(r.validation.errors.length, 0); // warning, not an error — still imported
    assert.strictEqual(r.imported.ledgers.imported, 1);
  });

  await check('validation: voucher-only export auto-creates missing ledgers', async () => {
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><VOUCHER><VOUCHERNUMBER>PV-9</VOUCHERNUMBER><DATE>20260730</DATE>',
      '<PARTYLEDGERNAME>Ghost Ledger</PARTYLEDGERNAME><AMOUNT>1000</AMOUNT></VOUCHER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');
    const r = await TallyImport.handleImport(coId, xml);
    const warn = r.validation.warnings.find((w) => w.type === 'export');
    assert.ok(warn, 'expected a voucher-only warning, got: ' + JSON.stringify(r.validation.warnings));
    const autoWarn = r.validation.warnings.find((w) => w.type === 'auto-ledger' && w.record === 'Ghost Ledger');
    assert.ok(autoWarn && autoWarn.message.includes('Sundry Debtors'), 'expected auto-ledger warning, got: ' + JSON.stringify(r.validation.warnings));
    assert.strictEqual(r.validation.errors.length, 0);
    assert.strictEqual(r.imported.vouchers.imported, 1);
  });

  await check('import: flat LEDGERENTRIES.LIST vouchers import with correct amounts', async () => {
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Current Assets</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Bank Accounts</NAME><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Cash-in-Hand</NAME><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Fixed Assets</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Indirect Expenses</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>HDFC Bank - Current A/c</NAME><PARENT>Bank Accounts</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Cash</NAME><PARENT>Cash-in-Hand</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Office Equipment</NAME><PARENT>Fixed Assets</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Rent Expenses</NAME><PARENT>Indirect Expenses</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Depreciation</NAME><PARENT>Indirect Expenses</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create"><DATE>20240405</DATE>',
      '<VOUCHERNUMBER>PY/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>HDFC Bank - Current A/c</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><AMOUNT>-25000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><AMOUNT>25000.00</AMOUNT></LEDGERENTRIES.LIST>',
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
    const r = await TallyImport.handleImport(coId, xml);
    assert.strictEqual(r.validation.errors.length, 0, JSON.stringify(r.validation.errors));
    assert.strictEqual(r.imported.vouchers.imported, 3);
    const vs = await all('SELECT voucher_number, amount FROM tally_vouchers WHERE company_id = ?', [coId]);
    const byNum = Object.fromEntries(vs.map((v) => [v.voucher_number, v.amount]));
    assert.strictEqual(byNum['PY/24-25/001'], 25000);
    assert.strictEqual(byNum['JV/24-25/001'], 3500);
    assert.strictEqual(byNum['CN/24-25/001'], 40000);
  });

  await check('import: voucher-only export auto-creates ledgers and imports all 6 vouchers', async () => {
    const co2 = coId + '-voucher-only';
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20240401</DATE>',
      '<VOUCHERNUMBER>SL/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
      '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>HP Laptop</STOCKITEMNAME><AMOUNT>104000.00</AMOUNT>',
      '<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>104000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>',
      '</ALLINVENTORYENTRIES.LIST>',
      '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Mouse</STOCKITEMNAME><AMOUNT>6500.00</AMOUNT>',
      '<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>6500.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>',
      '</ALLINVENTORYENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><AMOUNT>2812.50</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><AMOUNT>2812.50</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><AMOUNT>-116125.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Purchase" ACTION="Create"><DATE>20240403</DATE>',
      '<VOUCHERNUMBER>PU/24-25/001</VOUCHERNUMBER><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Verma Electronics Wholesale</PARTYLEDGERNAME>',
      '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>HP Laptop</STOCKITEMNAME><AMOUNT>-235000.00</AMOUNT>',
      '<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Purchase Account</LEDGERNAME><AMOUNT>-235000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>',
      '</ALLINVENTORYENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Input CGST</LEDGERNAME><AMOUNT>-5875.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Input SGST</LEDGERNAME><AMOUNT>-5875.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Verma Electronics Wholesale</LEDGERNAME><AMOUNT>246750.00</AMOUNT></LEDGERENTRIES.LIST>',
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
    const r = await TallyImport.handleImport(co2, xml);
    assert.strictEqual(r.validation.errors.length, 0, JSON.stringify(r.validation.errors));
    assert.ok(r.validation.warnings.some((w) => w.type === 'auto-ledger'), 'expected auto-ledger warnings');
    assert.strictEqual(r.imported.vouchers.imported, 6);

    const ledgers = await all('SELECT name, group_name FROM tally_ledgers WHERE company_id = ?', [co2]);
    const lg = Object.fromEntries(ledgers.map((l) => [l.name, l.group_name]));
    assert.strictEqual(lg['Sharma Enterprises'], 'Sundry Debtors');
    assert.strictEqual(lg['Verma Electronics Wholesale'], 'Sundry Creditors');
    assert.strictEqual(lg['HDFC Bank - Current A/c'], 'Bank Accounts');
    assert.strictEqual(lg['Sales Account'], 'Sales Accounts');
    assert.strictEqual(lg['Output CGST'], 'Duties & Taxes');
    assert.strictEqual(lg['Rent Expenses'], 'Indirect Expenses');
    assert.strictEqual(lg['Office Equipment'], 'Fixed Assets');
    assert.strictEqual(lg['Cash'], 'Cash-in-Hand');

    const vs = await all('SELECT voucher_number, amount FROM tally_vouchers WHERE company_id = ?', [co2]);
    const byNum = Object.fromEntries(vs.map((v) => [v.voucher_number, v.amount]));
    assert.strictEqual(byNum['SL/24-25/001'], -116125);
    assert.strictEqual(byNum['PU/24-25/001'], 246750);
    assert.strictEqual(byNum['PY/24-25/001'], 25000);
    assert.strictEqual(byNum['RC/24-25/001'], 75000);
    assert.strictEqual(byNum['JV/24-25/001'], 3500);
    assert.strictEqual(byNum['CN/24-25/001'], 40000);
  });

  await check('import: realistic VCHNUM/VCHDATE voucher imports with derived amount', async () => {
    const co3 = coId + '-vchnum';
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Current Assets</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Bank Accounts</NAME><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Global Freight LLP</NAME><PARENT>Sundry Creditors</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Bank</NAME><PARENT>Bank Accounts</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create">',
      '<VCHDATE>20260730</VCHDATE><VCHNUM>PV-2026-77</VCHNUM><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Global Freight LLP</PARTYLEDGERNAME>',
      '<LEDGERENTRIES><LEDGERENTRY><LEDGERNAME>Global Freight LLP</LEDGERNAME><AMOUNT>455000</AMOUNT></LEDGERENTRY>',
      '<LEDGERENTRY><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>-455000</AMOUNT></LEDGERENTRY></LEDGERENTRIES>',
      '</VOUCHER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');
    const r = await TallyImport.handleImport(co3, xml);
    assert.strictEqual(r.validation.errors.length, 0, JSON.stringify(r.validation.errors));
    assert.strictEqual(r.imported.ledgers.imported, 2);
    assert.strictEqual(r.imported.vouchers.imported, 1);
    const vs = await all('SELECT voucher_number, date, amount FROM tally_vouchers WHERE company_id = ?', [co3]);
    const v = vs.find((x) => x.voucher_number === 'PV-2026-77');
    assert.ok(v, 'voucher must exist');
    assert.strictEqual(v.date, '2026-07-30');
    assert.strictEqual(v.amount, 455000);
  });

  await check('import: empty/unsupported XML is rejected', async () => {
    let threw = false;
    try { await TallyImport.handleImport(coId, '<xml/>'); } catch { threw = true; }
    assert.ok(threw, 'expected a parse rejection');
  });

  await check('import: GUID + ALTERID upsert — edits count as updated, not skipped', async () => {
    const co = coId + '-guid-upsert';
    const xml = (amount, alterid) => [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Sharma Enterprises</NAME><PARENT>Sundry Creditors</PARENT><GUID>g-ledger-1</GUID><ALTERID>1</ALTERID></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Rent Expenses</NAME><PARENT>Current Liabilities</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create"><GUID>g-vch-1</GUID><ALTERID>' + alterid + '</ALTERID>',
      '<DATE>20240405</DATE><VOUCHERNUMBER>PY-G/001</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-' + amount + '.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>' + amount + '.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');

    const r1 = await TallyImport.handleImport(co, xml(25000, 1));
    assert.strictEqual(r1.imported.ledgers.imported, 2);
    assert.strictEqual(r1.imported.vouchers.imported, 1);
    assert.strictEqual(r1.validation.errors.length, 0, JSON.stringify(r1.validation.errors));

    const r2 = await TallyImport.handleImport(co, xml(30000, 2)); // same GUID, higher ALTERID, edited amount
    assert.strictEqual(r2.imported.vouchers.updated, 1, JSON.stringify(r2.imported));
    assert.strictEqual(r2.imported.vouchers.imported, 0);
    const v = await get('SELECT amount FROM tally_vouchers WHERE company_id = ? AND voucher_number = ?', [co, 'PY-G/001']);
    assert.strictEqual(v.amount, 30000);

    const r3 = await TallyImport.handleImport(co, xml(30000, 2)); // true duplicate: same ALTERID
    assert.strictEqual(r3.imported.vouchers.skipped, 1);
    assert.strictEqual(r3.imported.vouchers.updated, 0);
  });

  await check('import: same number/date with distinct GUIDs never collide on the fallback key', async () => {
    const co = coId + '-dedup-guid';
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Current Assets</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Bank Accounts</NAME><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Debtors</NAME><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Sharma Enterprises</NAME><PARENT>Sundry Debtors</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>HDFC Bank - Current A/c</NAME><PARENT>Bank Accounts</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create"><GUID>g-pay-001</GUID><ALTERID>1</ALTERID>',
      '<DATE>20240405</DATE><VOUCHERNUMBER>001</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>HDFC Bank - Current A/c</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-25000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>25000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt" ACTION="Create"><GUID>g-rec-001</GUID><ALTERID>1</ALTERID>',
      '<DATE>20240405</DATE><VOUCHERNUMBER>001</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-30000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>30000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');
    const r = await TallyImport.handleImport(co, xml);
    assert.strictEqual(r.validation.errors.length, 0, JSON.stringify(r.validation.errors));
    assert.strictEqual(r.imported.vouchers.imported, 2, JSON.stringify(r.imported));
    const vs = await all('SELECT voucher_number, voucher_type, tally_guid FROM tally_vouchers WHERE company_id = ?', [co]);
    assert.strictEqual(vs.length, 2);
    assert.ok(vs.some((v) => v.voucher_type === 'Payment' && v.tally_guid === 'g-pay-001'));
    assert.ok(vs.some((v) => v.voucher_type === 'Receipt' && v.tally_guid === 'g-rec-001'));
  });

  await check('import: GUID-less vouchers of different types sharing number/date both import', async () => {
    const co = coId + '-dedup-noguid';
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Current Assets</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Bank Accounts</NAME><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Debtors</NAME><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Sharma Enterprises</NAME><PARENT>Sundry Debtors</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>HDFC Bank - Current A/c</NAME><PARENT>Bank Accounts</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create">',
      '<DATE>20240405</DATE><VOUCHERNUMBER>001</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>HDFC Bank - Current A/c</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-25000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>25000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt" ACTION="Create">',
      '<DATE>20240405</DATE><VOUCHERNUMBER>001</VOUCHERNUMBER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank - Current A/c</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-30000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>30000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');
    const r = await TallyImport.handleImport(co, xml);
    assert.strictEqual(r.validation.errors.length, 0, JSON.stringify(r.validation.errors));
    assert.strictEqual(r.imported.vouchers.imported, 2, JSON.stringify(r.imported));
    const vs = await all('SELECT voucher_number, voucher_type FROM tally_vouchers WHERE company_id = ?', [co]);
    assert.strictEqual(vs.length, 2);
    assert.ok(vs.some((v) => v.voucher_type === 'Payment'));
    assert.ok(vs.some((v) => v.voucher_type === 'Receipt'));
  });

  await check('import: cancelled voucher is stored with cancelled=1 and still counted for audit', async () => {
    const co = coId + '-cancelled';
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Verma Electronics Wholesale</NAME><PARENT>Sundry Creditors</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><VOUCHER><DATE>20240403</DATE><VOUCHERNUMBER>PU-C/001</VOUCHERNUMBER><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Verma Electronics Wholesale</PARTYLEDGERNAME><AMOUNT>246750</AMOUNT>',
      '<ISCANCELLED>Yes</ISCANCELLED>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Purchase Account</LEDGERNAME><AMOUNT>-246750.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Verma Electronics Wholesale</LEDGERNAME><AMOUNT>246750.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');
    const r = await TallyImport.handleImport(co, xml);
    assert.strictEqual(r.validation.errors.length, 0, JSON.stringify(r.validation.errors));
    assert.strictEqual(r.imported.vouchers.imported, 1); // stored, not hidden
    const v = await get('SELECT cancelled FROM tally_vouchers WHERE company_id = ? AND voucher_number = ?', [co, 'PU-C/001']);
    assert.strictEqual(v.cancelled, 1);
  });

  await check('validation: unbalanced voucher is rejected with a specific error, others import', async () => {
    const co = coId + '-balance';
    const xml = [
      '<ENVELOPE><BODY><DATA>',
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Sharma Enterprises</NAME><PARENT>Sundry Creditors</PARENT></LEDGER></TALLYMESSAGE>',
      '<TALLYMESSAGE><LEDGER><NAME>Rent Expenses</NAME><PARENT>Current Liabilities</PARENT></LEDGER></TALLYMESSAGE>',
      // balanced voucher — must still import
      '<TALLYMESSAGE><VOUCHER><DATE>20240405</DATE><VOUCHERNUMBER>PY-BAL/001</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      // unbalanced voucher — debit 1000 vs credit 900
      '<TALLYMESSAGE><VOUCHER><DATE>20240406</DATE><VOUCHERNUMBER>PY-UNBAL/001</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>',
      '<PARTYLEDGERNAME>Sharma Enterprises</PARTYLEDGERNAME>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></LEDGERENTRIES.LIST>',
      '<LEDGERENTRIES.LIST><LEDGERNAME>Sharma Enterprises</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT></LEDGERENTRIES.LIST>',
      '</VOUCHER></TALLYMESSAGE>',
      '</DATA></BODY></ENVELOPE>',
    ].join('');
    const r = await TallyImport.handleImport(co, xml);
    const unbal = r.validation.errors.find((e) => e.record === 'PY-UNBAL/001');
    assert.ok(unbal, 'expected an unbalanced error, got: ' + JSON.stringify(r.validation.errors));
    assert.ok(unbal.message.includes('unbalanced') && unbal.message.includes('debit'), unbal.message);
    assert.strictEqual(r.imported.vouchers.imported, 1); // balanced one imports
    assert.strictEqual(r.imported.vouchers.skipped, 1); // unbalanced one skipped
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
