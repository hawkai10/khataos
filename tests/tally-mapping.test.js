'use strict';

// Unit tests for vendor <-> Tally ledger mapping: auto-match by name/GSTIN,
// manual override, and the report rows the UI consumes.

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'tally-mapping-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, all, get } = require('../server/src/db');
const Mapping = require('../server/src/tally-mapping');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

(async () => {
  const coId = 'tally-mapping-' + Date.now();
  await insert('companies', { id: coId, name: 'Mapping Test Co', gstin: '29ABCDE1234F1Z5', created_at: new Date().toISOString() });
  const ledgers = [
    { name: 'Sundry Creditors - Shree Cement Traders', group_name: 'Sundry Creditors', gstin: null },
    { name: 'Sundry Creditors - Kumar Logistics', group_name: 'Sundry Creditors', gstin: null },
    { name: 'Sundry Creditors - Sai Traders', group_name: 'Sundry Creditors', gstin: '29AABFS7788K1Z4' },
    { name: 'HDFC Bank - Current A/c', group_name: 'Bank Accounts', gstin: null },
    { name: 'Rent Expenses', group_name: 'Indirect Expenses', gstin: null },
  ];
  for (const l of ledgers) {
    await insert('tally_ledgers', { id: 'tl-' + l.name, company_id: coId, name: l.name, group_name: l.group_name, opening_balance: 0, gstin: l.gstin });
  }

  const vendors = [
    { id: 'v1', name: 'Shree Cement Traders', gstin: '29AABCS2345K1Z2', ledger_name: 'Stale Ledger Name' },
    { id: 'v2', name: 'Kumar Logistics LLP', gstin: '29AABFK1234P1Z8', ledger_name: 'Sundry Creditors - Kumar Logistics' },
    { id: 'v3', name: 'Sai Traders & Co', gstin: '29AABFS7788K1Z4', ledger_name: 'Sai Traders & Co' },
    { id: 'v4', name: 'New Vendor Ltd', gstin: null, ledger_name: 'New Vendor Ltd' },
  ];
  for (const v of vendors) {
    await insert('vendors', {
      id: v.id, company_id: coId, name: v.name, gstin: v.gstin, ledger_name: v.ledger_name,
      tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1,
    });
  }

  await check('scoreMatch: exact, GSTIN, token, containment and no-match', () => {
    const vendor = { name: 'Sai Traders & Co', gstin: '29AABFS7788K1Z4' };
    assert.strictEqual(Mapping.scoreMatch(vendor, { name: 'Sai Traders & Co' }), 1.0);
    assert.strictEqual(Mapping.scoreMatch(vendor, { name: 'Anything Else', gstin: '29AABFS7788K1Z4' }), 0.95);
    assert.strictEqual(Mapping.scoreMatch(vendor, { name: 'Sundry Creditors - Sai Traders' }), 0.88); // core-name match
    assert.strictEqual(Mapping.scoreMatch(vendor, { name: 'Rent Expenses' }), 0);
  });

  await check('matchTier: GSTIN first, then exact name, then fuzzy', () => {
    const vendor = { name: 'Sai Traders & Co', gstin: '29AABFS7788K1Z4' };
    assert.strictEqual(Mapping.matchTier(vendor, { name: 'Sai Traders & Co' }), 'exact');
    assert.strictEqual(Mapping.matchTier(vendor, { name: 'Something Else', gstin: '29AABFS7788K1Z4' }), 'gstin');
    assert.strictEqual(Mapping.matchTier(vendor, { name: 'Sundry Creditors - Sai Traders' }), 'fuzzy');
  });

  await check('report: dangling/manual/suggested/unmatched statuses', async () => {
    const r = await Mapping.report(coId);
    const byVendor = Object.fromEntries(r.rows.map((x) => [x.vendor_id, x]));
    assert.strictEqual(byVendor.v1.status, 'dangling'); // stale reference, not in import
    assert.strictEqual(byVendor.v1.matched_ledger, 'Sundry Creditors - Shree Cement Traders');
    assert.strictEqual(byVendor.v2.status, 'manual'); // equals fuzzy match -> manually mapped
    assert.strictEqual(byVendor.v3.status, 'suggested'); // GSTIN match, not yet applied
    assert.strictEqual(byVendor.v3.matched_ledger, 'Sundry Creditors - Sai Traders');
    assert.strictEqual(byVendor.v4.status, 'unmatched');
    assert.strictEqual(r.summary.mapped, 1);
    assert.strictEqual(r.summary.suggested, 1);
    assert.strictEqual(r.summary.dangling, 1);
    assert.strictEqual(r.summary.unmatched, 1);
  });

  await check('autoMap: applies only GSTIN/exact, never fuzzy; leaves dangling alone', async () => {
    const r = await Mapping.autoMap(coId);
    const applied = Object.fromEntries(r.updated.map((u) => [u.vendor_id, u]));
    assert.ok(!applied.v1, 'fuzzy match must NOT auto-apply');
    assert.ok(!applied.v2, 'fuzzy match must NOT auto-apply');
    assert.strictEqual(applied.v3.to, 'Sundry Creditors - Sai Traders');
    assert.strictEqual(applied.v3.tier, 'gstin');
    assert.ok(!applied.v4);
    const v1 = await get('SELECT ledger_name FROM vendors WHERE id = ?', ['v1']);
    assert.strictEqual(v1.ledger_name, 'Stale Ledger Name'); // untouched
    const v4 = await get('SELECT ledger_name FROM vendors WHERE id = ?', ['v4']);
    assert.strictEqual(v4.ledger_name, 'New Vendor Ltd');
    const after = await Mapping.report(coId);
    const byVendor = Object.fromEntries(after.rows.map((x) => [x.vendor_id, x]));
    assert.strictEqual(byVendor.v1.status, 'dangling'); // still re-flagged after import
    assert.strictEqual(byVendor.v3.status, 'auto');
  });

  await check('setMapping: manual override, unknown ledger/vendor rejected', async () => {
    const r = await Mapping.setMapping(coId, 'v4', 'HDFC Bank - Current A/c');
    assert.strictEqual(r.ledger_name, 'HDFC Bank - Current A/c');
    const after = await Mapping.report(coId);
    const byVendor = Object.fromEntries(after.rows.map((x) => [x.vendor_id, x]));
    assert.strictEqual(byVendor.v4.status, 'manual'); // explicit mapping to an imported ledger
    let threw = false;
    try { await Mapping.setMapping(coId, 'v4', 'No Such Ledger'); } catch { threw = true; }
    assert.ok(threw, 'unknown ledger must be rejected');
    threw = false;
    try { await Mapping.setMapping(coId, 'missing-vendor', 'HDFC Bank - Current A/c'); } catch { threw = true; }
    assert.ok(threw, 'unknown vendor must be rejected');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
