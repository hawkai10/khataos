'use strict';

// Worked-example unit tests for the exact Money (BigInt paise) value object:
// sums, TDS deduction, aging bucket totals, and the float traps that the old
// Number-based model got wrong.

const assert = require('assert');
const { Money } = require('../server/src/money');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

const r = (s) => Money.fromRupees(s);

(async () => {
  await check('parse: fromRupees string to exact paise', () => {
    assert.strictEqual(r('100.99').toPaise(), 10099n);
    assert.strictEqual(r('0.01').toPaise(), 1n);
    assert.strictEqual(r('-50.5').toPaise(), -5050n);
    assert.strictEqual(r('1000').toPaise(), 100000n);
    assert.strictEqual(r('0').toPaise(), 0n);
  });

  await check('parse: JSON integer number accepted exactly, floats rejected on precision', () => {
    assert.strictEqual(Money.fromRupees(59000).toPaise(), 5900000n);
    assert.strictEqual(Money.fromRupees(100.99).toPaise(), 10099n); // shortest round-trip string
    assert.throws(() => Money.fromRupees('1.234'), /invalid rupee amount/);
    assert.throws(() => Money.fromRupees('abc'), /invalid rupee amount/);
  });

  await check('sum: 100.99 + 0.01 = 101.00 exactly (the classic float trap)', () => {
    const total = Money.sum([r('100.99'), r('0.01')]);
    assert.strictEqual(total.toRupees(), '101.00');
    assert.strictEqual(Money.sum([r('0.1'), r('0.2')]).toRupees(), '0.30');
  });

  await check('plus/minus: exact no drift', () => {
    assert.strictEqual(r('100000.00').plus(r('1.25')).minus(r('0.25')).toRupees(), '100001.00');
    assert.strictEqual(r('-100.00').abs().toRupees(), '100.00');
  });

  await check('TDS worked example: 2% TDS on 100000.00 gross', () => {
    const gross = r('100000.00');
    const tds = gross.percentBps(200); // 2% = 200 bps
    const net = gross.minus(tds);
    assert.strictEqual(tds.toRupees(), '2000.00');
    assert.strictEqual(net.toRupees(), '98000.00');
    // Fractional paise rounds half away from zero: 1.25 @ 0.5% (50bps)
    assert.strictEqual(r('1.25').percentBps(50).toRupees(), '0.01');
    assert.strictEqual(r('1.24').percentBps(50).toRupees(), '0.01'); // 0.62 paise -> 1
    assert.strictEqual(r('-1.25').percentBps(50).toRupees(), '-0.01');
  });

  await check('divide: exact integer paise with half-away rounding', () => {
    assert.strictEqual(Money.fromPaise(100).divide(3).toPaise(), 33n);
    assert.strictEqual(Money.fromPaise(5).divide(2).toPaise(), 3n); // 2.5 -> 3
    assert.strictEqual(Money.fromPaise(-100).divide(3).toPaise(), -33n);
    assert.strictEqual(Money.fromPaise(1000000).divide(3).toPaise(), 333333n);
    assert.throws(() => Money.fromPaise(1).divide(0), /divide by zero/);
  });

  await check('aging bucket worked example: purchases netted by debit notes', () => {
    // Same FIFO netting as services/aging.js: purchases [59000.00, 118000.00],
    // debit note 5000.00 applied oldest-first -> buckets total 172000.00.
    const purchases = [r('59000.00'), r('118000.00')];
    let dn = r('5000.00');
    const buckets = [];
    for (const p of purchases) {
      const applied = dn.gt(r('0')) && dn.lt(p) ? dn : p.lte(dn) ? p : r('0');
      const net = p.minus(applied);
      dn = dn.minus(applied);
      buckets.push(net);
    }
    assert.strictEqual(buckets[0].toRupees(), '54000.00');
    assert.strictEqual(buckets[1].toRupees(), '118000.00');
    assert.strictEqual(Money.sum(buckets).toRupees(), '172000.00');
  });

  await check('equals: exact comparison rejects near-misses', () => {
    assert.strictEqual(r('100.00').equals(r('100.00')), true);
    assert.strictEqual(r('100.00').equals(r('100.99')), false); // old ±1 tolerance matched this
    assert.strictEqual(Money.sum([r('59000.00'), r('59000.00')]).equals(r('118000.00')), true);
  });

  await check('toRupees: formatting always two decimals', () => {
    assert.strictEqual(r('1000').toRupees(), '1000.00');
    assert.strictEqual(r('0.5').toRupees(), '0.50');
    assert.strictEqual(r('-0.5').toRupees(), '-0.50');
    assert.strictEqual(Money.fromPaise(9204050n).toRupees(), '92040.50');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
