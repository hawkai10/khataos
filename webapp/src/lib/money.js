// Exact money helpers for the webapp. The API delivers amounts as rupee
// decimal strings ("59000.00"); all arithmetic goes through BigInt paise,
// never Number.

export function fromRupees(value) {
  const s = String(value ?? '').trim();
  if (!s) return 0n;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error('invalid rupee amount: ' + s);
  const neg = m[1] === '-';
  const paise = BigInt(m[2]) * 100n + BigInt((m[3] || '').padEnd(2, '0'));
  return neg ? -paise : paise;
}

export function toRupees(paise) {
  const p = BigInt(paise);
  const neg = p < 0n;
  const a = neg ? -p : p;
  return (neg ? '-' : '') + (a / 100n).toString() + '.' + String(a % 100n).padStart(2, '0');
}

export function sumRupees(values) {
  return values.reduce((t, v) => t + fromRupees(v), 0n);
}

export function signRupees(value) {
  const p = fromRupees(value);
  return p > 0n ? 1 : p < 0n ? -1 : 0;
}

// Numeric conversion for chart scales only (exact paise -> rupees number).
// Never used for arithmetic.
export function rupeeToNumber(value) {
  return Number(fromRupees(value)) / 100;
}
