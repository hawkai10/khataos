const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const inrFmtCompact = new Intl.NumberFormat('en-IN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function inr(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '₹0';
  return '₹' + inrFmt.format(n);
}

export function inrCompact(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '₹0';
  return '₹' + inrFmtCompact.format(n);
}

export function signedInr(value) {
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
