'use strict';

// Tests for reconciliation wired to real imported Tally vouchers:
//   - BILLALLOCATIONS ref with a different amount -> mismatch, never a false match
//   - BILLALLOCATIONS ref with matching amount -> billref match, labelled
//   - amount + date + party fallback -> fuzzy match, labelled

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'recon-tally-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const { insert, all, get, run } = require('../server/src/db');
const recon = require('../server/src/recon');
const { uid, todayStr, nowIso } = require('../server/src/util');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

async function setup(coId, vendorLedger) {
  await insert('companies', { id: coId, name: 'Recon Test Co', gstin: '29ABCDE1234F1Z5', created_at: nowIso() });
  const bankCode = 'HDFC' + coId.slice(-5);
  await insert('banks', { code: bankCode, name: 'HDFC Bank', kind: 'direct_api', aa_supported: 1 });
  await insert('bank_accounts', {
    id: 'acct-' + coId, company_id: coId, bank_code: bankCode, account_name: 'Current', account_number: '12345',
    type: 'current', ifsc: 'HDFC0001234', status: 'active', source: 'direct_api', opened_at: nowIso(),
  });
  await insert('vendors', {
    id: 'v-' + coId, company_id: coId, name: 'Sai Traders & Co', gstin: '29AABFS7788K1Z4',
    ledger_name: vendorLedger, tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1,
  });
  await insert('invoices', {
    id: 'inv-' + coId, company_id: coId, invoice_no: 'INV-2026-1', invoice_date: todayStr(),
    due_date: todayStr(), source: 'manual', status: 'approved',
    gross_amount: 75000, taxable_amount: 75000, cgst: 0, sgst: 0, igst: 0, cess: 0,
    tds_amount: 0, net_payable: 75000, hsns: '[]', created_at: nowIso(),
  });
}

async function addTxn(coId, id, amount, ref) {
  await insert('bank_transactions', {
    id, company_id: coId, account_id: 'acct-' + coId, txn_date: todayStr(), amount,
    description: 'Bank debit ' + amount, mode: 'UPI', ref_no: ref, status: 'posted', matched: 0, created_at: nowIso(),
  });
}

async function addVoucher(coId, number, type, amount, party, entries) {
  await insert('tally_vouchers', {
    id: uid('tv'), company_id: coId, voucher_number: number, voucher_type: type,
    date: todayStr(), amount, party_name: party, entry_json: JSON.stringify(entries),
    tally_guid: 'guid-' + number, tally_alterid: 1, imported_at: nowIso(),
  });
}

(async () => {
  const day = todayStr();

  await check('bill-ref with different amount -> mismatch, transaction stays unmatched', async () => {
    const co = 'rc-mismatch-' + Date.now();
    await setup(co, 'Sundry Creditors - Sai Traders');
    await addTxn(co, 'txn-1', -75000, 'R1');
    await addVoucher(co, 'RC-1', 'Receipt', 50000, 'Sundry Creditors - Sai Traders', [
      { ledger: 'HDFC Bank - Current A/c', amount: -50000, positive: true, bill_refs: [] },
      { ledger: 'Sundry Creditors - Sai Traders', amount: 50000, positive: false, bill_refs: ['INV-2026-1'] },
    ]);
    const stats = await recon.matchAll(co);
    const mm = await get(`SELECT * FROM recon_matches WHERE bank_txn_id = ? AND status = 'mismatch'`, ['txn-1']);
    assert.ok(mm, 'expected a mismatch record');
    assert.strictEqual(mm.tally_voucher_no, 'RC-1');
    assert.ok(mm.notes.includes('amount differs'), mm.notes);
    const txn = await get('SELECT matched FROM bank_transactions WHERE id = ?', ['txn-1']);
    assert.strictEqual(txn.matched, 0, 'mismatched transaction must stay unmatched');
    assert.strictEqual(stats.auto, 0, 'no false match');
  });

  await check('bill-ref with matching amount -> billref match labelled as Tally voucher', async () => {
    const co = 'rc-billref-' + Date.now();
    await setup(co, 'Sundry Creditors - Sai Traders');
    await addTxn(co, 'txn-2', -75000, 'R2');
    await addVoucher(co, 'PY-1', 'Payment', 75000, 'Sundry Creditors - Sai Traders', [
      { ledger: 'Sundry Creditors - Sai Traders', amount: 75000, positive: false, bill_refs: ['INV-2026-1'] },
      { ledger: 'HDFC Bank - Current A/c', amount: -75000, positive: true, bill_refs: [] },
    ]);
    const stats = await recon.matchAll(co);
    const m = await get(`SELECT * FROM recon_matches WHERE bank_txn_id = ? AND status = 'matched'`, ['txn-2']);
    assert.ok(m, 'expected a match');
    assert.strictEqual(m.tally_voucher_no, 'PY-1');
    assert.strictEqual(m.match_type, 'billref');
    assert.ok(m.notes.includes('Matched against Tally voucher #PY-1'), m.notes);
    const txn = await get('SELECT matched FROM bank_transactions WHERE id = ?', ['txn-2']);
    assert.strictEqual(txn.matched, 1);
    assert.ok(stats.auto >= 1);
  });

  await check('amount + date + party fallback -> fuzzy match against Tally voucher', async () => {
    const co = 'rc-fuzzy-' + Date.now();
    await setup(co, 'Sundry Creditors - Sai Traders');
    await addTxn(co, 'txn-3', -25000, 'R3');
    await addVoucher(co, 'PY-2', 'Payment', 25000, 'Sundry Creditors - Sai Traders', [
      { ledger: 'Rent Expenses', amount: -25000, positive: true, bill_refs: [] },
      { ledger: 'Sundry Creditors - Sai Traders', amount: 25000, positive: false, bill_refs: [] },
    ]);
    const stats = await recon.matchAll(co);
    const m = await get(`SELECT * FROM recon_matches WHERE bank_txn_id = ? AND status = 'matched'`, ['txn-3']);
    assert.ok(m, 'expected a fuzzy match');
    assert.strictEqual(m.tally_voucher_no, 'PY-2');
    assert.strictEqual(m.match_type, 'fuzzy');
    assert.ok(m.notes.includes('Matched against Tally voucher #PY-2'), m.notes);
    const txn = await get('SELECT matched FROM bank_transactions WHERE id = ?', ['txn-3']);
    assert.strictEqual(txn.matched, 1);
    assert.ok(stats.auto >= 1);
  });

  await check('cancelled voucher is stored but never offered as a recon candidate', async () => {
    const co = 'rc-cancelled-' + Date.now();
    await setup(co, 'Sundry Creditors - Sai Traders');
    await addTxn(co, 'txn-4', -25000, 'R4');
    await addVoucher(co, 'PY-C', 'Payment', 25000, 'Sundry Creditors - Sai Traders', [
      { ledger: 'Rent Expenses', amount: -25000, positive: true, bill_refs: [] },
      { ledger: 'Sundry Creditors - Sai Traders', amount: 25000, positive: false, bill_refs: [] },
    ]);
    await run('UPDATE tally_vouchers SET cancelled = 1 WHERE company_id = ?', [co]);
    const stats = await recon.matchAll(co);
    const m = await get('SELECT * FROM recon_matches WHERE bank_txn_id = ?', ['txn-4']);
    assert.strictEqual(m, null, 'cancelled voucher must not match a bank transaction');
    const txn = await get('SELECT matched FROM bank_transactions WHERE id = ?', ['txn-4']);
    assert.strictEqual(txn.matched, 0);
    assert.strictEqual(stats.auto, 0);
  });

  await check('bank credit reconciles against a Debit Note voucher', async () => {
    const co = 'rc-dn-' + Date.now();
    await setup(co, 'Sundry Creditors - Sai Traders');
    await addTxn(co, 'txn-5', 20000, 'R5'); // positive = bank credit (refund)
    await addVoucher(co, 'DN-1', 'Debit Note', 20000, 'Sundry Creditors - Sai Traders', [
      { ledger: 'Sundry Creditors - Sai Traders', amount: -20000, positive: true, bill_refs: [] },
      { ledger: 'Purchase Return', amount: 20000, positive: false, bill_refs: [] },
    ]);
    const matched = await recon.autoVoucherMatch(co, 30);
    const m = await get(`SELECT * FROM recon_matches WHERE bank_txn_id = ? AND status = 'matched'`, ['txn-5']);
    assert.ok(m, 'expected a Debit Note match for the bank credit');
    assert.strictEqual(m.tally_voucher_no, 'DN-1');
    assert.strictEqual(m.match_type, 'fuzzy');
    const txn = await get('SELECT matched FROM bank_transactions WHERE id = ?', ['txn-5']);
    assert.strictEqual(txn.matched, 1);
    assert.strictEqual(matched, 1);
  });

  await check('bank debit reconciles against a Credit Note voucher', async () => {
    const co = 'rc-cn-' + Date.now();
    await setup(co, 'Sundry Creditors - Sai Traders');
    await addTxn(co, 'txn-6', -15000, 'R6'); // negative = bank debit (refund paid out)
    await addVoucher(co, 'CN-1', 'Credit Note', 15000, 'Sundry Creditors - Sai Traders', [
      { ledger: 'Sales Return', amount: -15000, positive: true, bill_refs: [] },
      { ledger: 'Sundry Creditors - Sai Traders', amount: 15000, positive: false, bill_refs: [] },
    ]);
    const stats = await recon.matchAll(co);
    const m = await get(`SELECT * FROM recon_matches WHERE bank_txn_id = ? AND status = 'matched'`, ['txn-6']);
    assert.ok(m, 'expected a Credit Note match for the bank debit');
    assert.strictEqual(m.tally_voucher_no, 'CN-1');
    const txn = await get('SELECT matched FROM bank_transactions WHERE id = ?', ['txn-6']);
    assert.strictEqual(txn.matched, 1);
    assert.ok(stats.auto >= 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
