'use strict';

// Equivalence test: the fast-xml-parser-backed parseExport must produce
// byte-for-byte identical structured output to the original hand-rolled
// parser for the same inputs. The legacy parser is frozen in
// tests/fixtures/legacy-parser.js and is only used here as a reference.

const assert = require('assert');
const Tally = require('../server/src/tally');
const Legacy = require('./fixtures/legacy-parser');
const { VOUCHER_EXPORT, OFFICIAL_SAMPLE, VOUCHER_ONLY_EXPORT, VOUCHER_VARIANT, RAW_VOUCHER, IDENTITY_EXPORT } = require('./fixtures/tally-xml');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

const DEMO_FILES = [
  ['voucher register (VCHNUM/VCHTYPE attr)', VOUCHER_EXPORT],
  ['official Tally sample (mixed case, PARTYNAME, wrapped lists)', OFFICIAL_SAMPLE],
  ['voucher-only register (flat lists + inventory allocations)', VOUCHER_ONLY_EXPORT],
  ['VCHDATE + attribute-only type variant', VOUCHER_VARIANT],
  ['BOM + XML declaration + wrapper-less raw voucher', RAW_VOUCHER],
  ['GUID/ALTERID/ISCANCELLED identity export', IDENTITY_EXPORT],
];

for (const [label, xml] of DEMO_FILES) {
  check(`equivalence: ${label}`, () => {
    const legacyOut = Legacy.parseExport(xml);
    const newOut = Tally.parseExport(xml);
    assert.deepStrictEqual(newOut, legacyOut);
    assert.strictEqual(JSON.stringify(newOut), JSON.stringify(legacyOut), 'JSON output differs byte-for-byte');
  });
}

check('equivalence: empty / malformed input yields the same empty structure', () => {
  for (const bad of ['', '   ', '<broken', 'plain text', '<<<garbage']) {
    assert.deepStrictEqual(Tally.parseExport(bad), Legacy.parseExport(bad), `mismatch for ${JSON.stringify(bad)}`);
  }
});

check('new parser: GUID/ALTERID/ISCANCELLED intact in structured output', () => {
  const d = Tally.parseExport(IDENTITY_EXPORT);
  assert.strictEqual(d.company, 'Acme Industries & Sons');
  assert.strictEqual(d.groups.find((g) => g.name === 'Sundry Creditors').tally_guid, 'g-sc');
  assert.strictEqual(d.ledgers.find((l) => l.name === 'Sai Traders & Co').tally_alterid, 3);
  const v = d.vouchers[0];
  assert.strictEqual(v.tally_guid, 'g-vch');
  assert.strictEqual(v.tally_alterid, 7);
  assert.strictEqual(v.cancelled, true);
  assert.strictEqual(v.entries.length, 3);
  assert.deepStrictEqual(v.entries.find((e) => e.ledger === 'Sai Traders & Co').bill_refs, ['INV-ALPHA-1']);
});

check('new parser: entries from nested, flat and inventory shapes are preserved in order', () => {
  const d = Tally.parseExport(VOUCHER_ONLY_EXPORT);
  const sl = d.vouchers.find((v) => v.voucher_number === 'SL/24-25/001');
  // order: flat CGST/SGST/party entries first, then inventory allocation
  assert.deepStrictEqual(sl.entries.map((e) => e.ledger), ['Output CGST', 'Output SGST', 'Sharma Enterprises', 'Sales Account']);
  assert.strictEqual(sl.amount, -116125); // party entry wins over allocation amounts
  const off = Tally.parseExport(OFFICIAL_SAMPLE);
  assert.deepStrictEqual(off.vouchers[0].entries.map((e) => e.ledger), ['Customer ABC', 'Bank']); // wrapped list unwrapped once
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
