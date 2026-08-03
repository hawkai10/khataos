'use strict';

// Deterministic fuzz test for the Tally XML parser: hundreds of generated
// export variants (random tags, attributes, dates, amounts, entities,
// malformed blocks) must never throw and must always yield a well-typed
// result. Uses a fixed seed so failures are reproducible.

const assert = require('assert');
const Tally = require('../server/src/tally');
const { mulberry32 } = require('../server/src/util');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

const VENDORS = ['Sai Traders & Co', 'Verma Electronics Wholesale', 'Global Freight LLP'];
const TYPES = ['Purchase', 'Payment', 'Receipt', 'Sales', 'Journal', 'Contra', 'Debit Note', 'Credit Note'];
const ATTRS = ['VCHTYPE="Purchase"', 'ACTION="Create"', 'OBJVIEW="Invoice Voucher View"', ''];

function randomVoucher(rng) {
  const parts = [];
  const withEntries = rng() < 0.7;
  if (rng() < 0.15) parts.push('<ISCANCELLED>Yes</ISCANCELLED>');
  if (rng() < 0.2) parts.push(`<GUID>g-${Math.floor(rng() * 1e6)}</GUID>`);
  if (rng() < 0.2) parts.push(`<ALTERID>${1 + Math.floor(rng() * 5)}</ALTERID>`);
  if (rng() < 0.5) parts.push(`<VOUCHERNUMBER>${rng() < 0.5 ? 'PV-' : ''}${100 + Math.floor(rng() * 900)}</VOUCHERNUMBER>`);
  else parts.push(`<VCHNUM>V${100 + Math.floor(rng() * 900)}</VCHNUM>`);
  const date = rng() < 0.5 ? `2026${String(1 + Math.floor(rng() * 12)).padStart(2, '0')}${String(1 + Math.floor(rng() * 28)).padStart(2, '0')}` : `2026-${String(1 + Math.floor(rng() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rng() * 28)).padStart(2, '0')}`;
  if (rng() < 0.5) parts.push(`<DATE>${date}</DATE>`); else parts.push(`<VCHDATE>${date}</VCHDATE>`);
  const type = TYPES[Math.floor(rng() * TYPES.length)];
  if (rng() < 0.8) parts.push(`<VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>`);
  if (rng() < 0.5) parts.push(`<PARTYLEDGERNAME>${VENDORS[Math.floor(rng() * VENDORS.length)]}</PARTYLEDGERNAME>`);
  if (rng() < 0.3) parts.push(`<PARTYNAME>${VENDORS[Math.floor(rng() * VENDORS.length)]}</PARTYNAME>`);
  if (rng() < 0.5) parts.push(`<AMOUNT>${(rng() < 0.5 ? -1 : 1) * Math.round(1000 + rng() * 5e5)}</AMOUNT>`);
  if (withEntries) {
    const n = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const ledger = rng() < 0.5 ? VENDORS[Math.floor(rng() * VENDORS.length)] : ['Bank', 'Rent Expenses', 'Purchase Account', 'Input CGST'][Math.floor(rng() * 4)];
      const amount = Math.round((rng() < 0.5 ? -1 : 1) * (100 + rng() * 2e5));
      const flat = rng() < 0.6;
      const refs = rng() < 0.2 ? `<BILLALLOCATIONS.LIST><NAME>INV-${Math.floor(rng() * 1e4)}</NAME></BILLALLOCATIONS.LIST>` : '';
      if (flat) parts.push(`<LEDGERENTRIES.LIST>${rng() < 0.5 ? `<ISDEEMEDPOSITIVE>${rng() < 0.5 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` : ''}<LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT>${refs}</LEDGERENTRIES.LIST>`);
      else parts.push(`<LEDGERENTRIES><LEDGERENTRY><LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT>${refs}</LEDGERENTRY></LEDGERENTRIES>`);
    }
  }
  const attrs = ATTRS[Math.floor(rng() * ATTRS.length)];
  return `<VOUCHER${attrs ? ' ' + attrs : ''}>${parts.join('')}</VOUCHER>`;
}

function randomExport(rng) {
  const parts = [];
  if (rng() < 0.7) parts.push('<?xml version="1.0"?>');
  if (rng() < 0.2) parts.push('\uFEFF');
  const wrapped = rng() < 0.8;
  if (wrapped) parts.push('<ENVELOPE><BODY><DATA>');
  if (rng() < 0.4) parts.push('<TALLYMESSAGE><COMPANY><NAME>Fuzz Co</NAME></COMPANY></TALLYMESSAGE>');
  for (let i = 0; i < 1 + Math.floor(rng() * 5); i++) {
    if (rng() < 0.3) {
      parts.push(`<TALLYMESSAGE><GROUP><NAME>Group ${i}</NAME>${rng() < 0.4 ? `<PARENT>Parent ${i}</PARENT>` : ''}${rng() < 0.2 ? `<GUID>g${i}</GUID>` : ''}</GROUP></TALLYMESSAGE>`);
    } else if (rng() < 0.5) {
      parts.push(`<TALLYMESSAGE><LEDGER><NAME>Ledger ${i}</NAME><PARENT>Group ${Math.max(0, i - 1)}</PARENT>${rng() < 0.3 ? `<GSTIN>29AABCA${String(1000 + i)}K1Z5</GSTIN>` : ''}${rng() < 0.2 ? `<OPENINGBALANCE>${Math.round(rng() * 1e5)}</OPENINGBALANCE>` : ''}</LEDGER></TALLYMESSAGE>`);
    } else {
      parts.push(`<TALLYMESSAGE>${randomVoucher(rng)}</TALLYMESSAGE>`);
    }
  }
  // occasional malformed input
  if (rng() < 0.1) parts.push('<VOUCHER><DATE>2026-01-01</DATE>'); // unclosed
  if (rng() < 0.05) parts.push('<<<broken');
  if (wrapped) parts.push('</DATA></BODY></ENVELOPE>');
  return parts.join('');
}

check('fuzz: 300 generated exports parse without throwing and stay well-typed', () => {
  const rng = mulberry32(20260803);
  for (let i = 0; i < 300; i++) {
    const xml = randomExport(rng);
    let out;
    assert.doesNotThrow(() => { out = Tally.parseExport(xml); }, `iteration ${i} threw`);
    assert.deepStrictEqual(Object.keys(out).sort(), ['company', 'groups', 'ledgers', 'vouchers']);
    assert.ok(Array.isArray(out.groups) && Array.isArray(out.ledgers) && Array.isArray(out.vouchers));
    for (const v of out.vouchers) {
      assert.strictEqual(typeof v.amount, 'number', `iteration ${i}: amount`);
      assert.ok(Number.isFinite(v.amount));
      assert.strictEqual(typeof v.cancelled, 'boolean', `iteration ${i}: cancelled`);
      assert.ok(v.voucher_number === null || typeof v.voucher_number === 'string');
      assert.ok(v.voucher_type === null || typeof v.voucher_type === 'string');
      assert.ok(v.date === null || /^\d{4}-\d{2}-\d{2}$/.test(v.date), `iteration ${i}: date ${v.date}`);
      assert.ok(Array.isArray(v.entries));
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
