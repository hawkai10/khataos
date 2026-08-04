'use strict';

// Unit tests for the Decentro adapter mapping + config, using the exact
// response shape published in Decentro's Connected Banking docs.

const assert = require('assert');
const Decentro = require('../server/src/decentro');

// Fixture: docs example for GET /v2/banking/account/{acc}/statement
const STATEMENT_FIXTURE = {
  decentroTxnId: 'DCTRTXXXXXXXXXXXXXXXXX',
  status: 'SUCCESS',
  responseCode: 'S00000',
  message: 'Statement retrieved successfully',
  data: {
    accountNumber: 'XXXXX',
    name: 'Acme Industries Pvt Ltd',
    ifsc: 'ICIC0003132',
    branchAddress: 'Bengaluru',
    totalCount: 2,
    withdrawalCount: 1,
    depositCount: 1,
    openingBalance: 100,
    closingBalance: 100,
    statement: [
      { timestamp: '2020-10-02T16:21:45.795052', description: 'ATM/CASH WDL/02-10-20/0', depositAmount: 0, withdrawalAmount: 100, balance: 100, bankTransactionId: 'S2XXXXXXX', type: 'DEBIT' },
      { timestamp: '2020-10-01T00:21:45.795052', description: 'UPI/2FA/01-10-20/REF123456789', depositAmount: 100, withdrawalAmount: 0, balance: 200, bankTransactionId: 'S2YYYYYYY', type: 'CREDIT' },
    ],
  },
};

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' — ' + e.message); }
}

check('mapStatement: two rows mapped', () => {
  const out = Decentro.mapStatement(STATEMENT_FIXTURE.data);
  assert.strictEqual(out.rows.length, 2);
  assert.strictEqual(out.name, 'Acme Industries Pvt Ltd');
  assert.strictEqual(out.ifsc, 'ICIC0003132');
});

check('mapStatement: debit amount is negative', () => {
  const out = Decentro.mapStatement(STATEMENT_FIXTURE.data);
  assert.strictEqual(out.rows[0].amount, -10000); // -100 rupees -> paise
});

check('mapStatement: credit amount is positive with UPI mode', () => {
  const out = Decentro.mapStatement(STATEMENT_FIXTURE.data);
  assert.strictEqual(out.rows[1].amount, 10000); // 100 rupees -> paise
  assert.strictEqual(out.rows[1].mode, 'UPI');
});

check('mapStatement: dates and balances mapped', () => {
  const out = Decentro.mapStatement(STATEMENT_FIXTURE.data);
  assert.strictEqual(out.rows[0].txn_date, '2020-10-02');
  assert.strictEqual(out.rows[0].balance_after, 10000); // 100 rupees -> paise
  assert.strictEqual(out.rows[0].external_id, 'S2XXXXXXX');
});

check('mapStatement: mode inference covers ATM/IMPS/NEFT/RTGS/CHQ', () => {
  const probe = Decentro.mapStatement({ statement: [
    { description: 'ATM WDL', timestamp: '2020-01-01T00:00:00' },
    { description: 'IMPS/OUTWARD', timestamp: '2020-01-02T00:00:00' },
    { description: 'NEFT/CREDIT', timestamp: '2020-01-03T00:00:00' },
    { description: 'RTGS SETTLEMENT', timestamp: '2020-01-04T00:00:00' },
    { description: 'CHQ NO 778812', timestamp: '2020-01-05T00:00:00' },
  ]}).rows.map(r => r.mode);
  assert.deepStrictEqual(probe, ['ATM', 'IMPS', 'NEFT', 'RTGS', 'CHQ']);
});

check('mapStatement: rows without a date are dropped', () => {
  const out = Decentro.mapStatement({ statement: [{ description: 'draft', timestamp: '' }] });
  assert.strictEqual(out.rows.length, 0);
});

check('config: disabled without env vars', () => {
  const cfg = Decentro.config();
  assert.strictEqual(cfg.enabled, false);
  assert.ok(cfg.missing_env.length >= 3);
  assert.strictEqual(cfg.provider, 'decentro-connected-banking');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
