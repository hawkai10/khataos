'use strict';

// ============================================================================
// Exact money: integer paise backed by BigInt. The whole codebase stores and
// computes amounts in paise — Number arithmetic on money is forbidden.
//   - fromRupees() parses a decimal string (or an integer JSON number via its
//     shortest round-trip string) into paise; it never does float math.
//   - percentBps(bps) computes a percentage of this amount in basis points
//     (1% = 100 bps), rounded half away from zero (the GST/rounding convention
//     used by Indian accounting software).
//   - toRupees() returns an exact decimal string like "100.99" / "-50.50".
// ============================================================================

class Money {
  constructor(paise) {
    if (typeof paise !== 'bigint') throw new Error('Money must be constructed from BigInt paise');
    this.paise = paise;
  }

  // Exact integer paise (BigInt, decimal string, or a safe integer Number).
  static fromPaise(paise) {
    if (typeof paise === 'bigint') return new Money(paise);
    if (typeof paise === 'number') {
      if (!Number.isSafeInteger(paise)) throw new Error(`unsafe paise value: ${paise}`);
      return new Money(BigInt(paise));
    }
    const s = String(paise).trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`invalid paise value: ${s}`);
    return new Money(BigInt(s));
  }

  // Parse rupees from a decimal string ("100.99", "-50.5", "0"). JSON numbers
  // are accepted via their shortest round-trip string (String(100.99) ===
  // "100.99"), so no float precision is ever introduced.
  static fromRupees(amount) {
    if (typeof amount === 'number') amount = String(amount);
    const s = String(amount).trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid rupee amount: ${s}`);
    const neg = s.startsWith('-');
    const t = neg ? s.slice(1) : s;
    const [intPart, decPart = ''] = t.split('.');
    const paise = BigInt(intPart) * 100n + BigInt((decPart + '00').slice(0, 2));
    return new Money(neg ? -paise : paise);
  }

  static sum(items) {
    let total = 0n;
    for (const m of items) total += toPaise(m);
    return new Money(total);
  }

  toPaise() { return this.paise; }

  plus(other) { return new Money(this.paise + toPaise(other)); }
  minus(other) { return new Money(this.paise - toPaise(other)); }

  // Percentage of this amount in basis points (1% = 100 bps), half away from
  // zero: 10000.00 * 200bps = 200.00; 1.25 * 50bps = 0.01 (0.0625 -> 0.07? no:
  // 1.25 = 125 paise, *50/10000 = 0.625 paise -> rounds to 1 paise).
  percentBps(bps) {
    const b = BigInt(bps);
    const num = this.paise * b;
    const half = 5000n;
    const q = num / 10000n;
    const r = num % 10000n;
    return new Money(r >= half ? q + 1n : r <= -half ? q - 1n : q);
  }

  // Integer division of paise by a whole number, rounded half away from zero
  // (used for e.g. monthly burn = 90-day outflows / 3).
  divide(n) {
    const d = BigInt(n);
    if (d === 0n) throw new Error('Money.divide by zero');
    const neg = this.paise < 0n;
    const p = neg ? -this.paise : this.paise;
    const q = p / d;
    const r = p % d;
    return new Money(neg ? -(r * 2n >= d ? q + 1n : q) : (r * 2n >= d ? q + 1n : q));
  }

  abs() { return this.paise < 0n ? new Money(-this.paise) : this; }
  negate() { return new Money(-this.paise); }

  equals(other) { return this.paise === toPaise(other); }
  gt(other) { return this.paise > toPaise(other); }
  gte(other) { return this.paise >= toPaise(other); }
  lt(other) { return this.paise < toPaise(other); }
  lte(other) { return this.paise <= toPaise(other); }
  isZero() { return this.paise === 0n; }
  isNegative() { return this.paise < 0n; }

  // Exact decimal string, always two decimal places: "100.00", "-0.50".
  toRupees() {
    const neg = this.paise < 0n;
    const p = neg ? -this.paise : this.paise;
    const rupees = p / 100n;
    const paise = p % 100n;
    return (neg ? '-' : '') + rupees.toString() + '.' + String(paise).padStart(2, '0');
  }
}

function toPaise(value) {
  return value instanceof Money ? value.paise : Money.fromPaise(value).paise;
}

module.exports = { Money };
