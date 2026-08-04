import { fromRupees, toRupees } from './money.js';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const inrFmtCompact = new Intl.NumberFormat('en-IN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function groupInt(intPart) {
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
}

export function inr(value) {
  if (typeof value === 'string' && value !== '') {
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (m) {
      return (m[1] === '-' ? '-' : '') + '₹' + groupInt(m[2]) + '.' + (m[3] || '').padEnd(2, '0');
    }
    return '₹' + value;
  }
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '₹0';
  return '₹' + inrFmt.format(n);
}

export function inrCompact(value) {
  if (typeof value === 'string' && value !== '') {
    return '₹' + inrFmtCompact.format(Number(fromRupees(value)) / 100);
  }
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '₹0';
  return '₹' + inrFmtCompact.format(n);
}

export function signedInr(value) {
  if (typeof value === 'string' && value !== '') {
    const p = fromRupees(value);
    const sign = p > 0n ? '+' : p < 0n ? '−' : '';
    return sign + inr(toRupees(p < 0n ? -p : p));
  }
  const n = Number(value ?? 0);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + inr(Math.abs(n));
}

export function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(String(value).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

export function esc(value) {
  return String(value ?? '');
}
