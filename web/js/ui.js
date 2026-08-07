'use strict';

const UI = {
  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  inr(n, dec = 0) {
    const neg = n < 0;
    const v = Math.abs(Number(n) || 0);
    const s = v.toFixed(dec);
    const [i, d] = s.split('.');
    const last3 = i.slice(-3);
    const rest = i.slice(0, -3);
    const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
    return (neg ? '-' : '') + '\u20B9' + grouped + (d ? '.' + d : '');
  },

  inrFull(n) { return this.inr(n, 2); },

  // Exact paise helpers: the API delivers amounts as rupee decimal strings.
  // All summing goes through BigInt paise, never Number arithmetic.
  paiseOf(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return 0n;
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return 0n;
    const paise = BigInt(m[2]) * 100n + BigInt((m[3] || '').padEnd(2, '0'));
    return m[1] === '-' ? -paise : paise;
  },

  rupees(paise) {
    const p = BigInt(paise);
    const neg = p < 0n;
    const a = neg ? -p : p;
    return (neg ? '-' : '') + (a / 100n).toString() + '.' + String(a % 100n).padStart(2, '0');
  },

  sumRupees(values) {
    return values.reduce((t, v) => t + this.paiseOf(v), 0n);
  },

  signRupees(value) {
    const p = this.paiseOf(value);
    return p > 0n ? 1 : p < 0n ? -1 : 0;
  },

  // Compact Indian units for KPI cards: ₹22.04 Cr / ₹1.2 L — keeps big
  // numbers from overflowing their boxes; full values live in the sub-line.
  inrCompact(n) {
    const v = Number(n) || 0;
    const neg = v < 0;
    const a = Math.abs(v);
    if (a >= 1e7) {
      const s = (a / 1e7).toFixed(2).replace(/\.?0+$/, '');
      return (neg ? '-' : '') + '\u20B9' + s + ' Cr';
    }
    if (a >= 1e5) {
      const s = (a / 1e5).toFixed(1).replace(/\.0$/, '');
      return (neg ? '-' : '') + '\u20B9' + s + ' L';
    }
    return this.inr(v);
  },

  // Feather-style stroke icons (24px grid)
  svgIcon(path) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  },

  ICONS: {
    bank: '<path d="M12 3l9 5H3l9-5z"/><path d="M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 21h18"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    bell: '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    doc: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>',
    percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"/>',
    bar: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 01-4 4h-4a4 4 0 01-4-4V8h12z"/>',
  },

  kpiCard({ icon, label, value, sub, alert, title }) {
    const ico = this.ICONS[icon] ? this.svgIcon(this.ICONS[icon]) : '';
    return `<div class="card kpi ${alert ? 'alert' : ''}"${title ? ` title="${this.esc(title)}"` : ''}>
      <div class="kpi-top"><span class="label">${this.esc(label)}</span><span class="kpi-ico">${ico}</span></div>
      <div class="value">${value}</div>
      <div class="sub">${sub}</div>
    </div>`;
  },

  date(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },

  rel(iso) {
    if (!iso) return '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff > 1) return `in ${diff}d`;
    return `${-diff}d overdue`;
  },

  relTime(mins) {
    if (mins == null || isNaN(mins)) return '—';
    mins = Math.max(0, Math.floor(mins));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  },

  // Freshness pill: ok when within freshMin, warn between, danger when stale.
  freshPill(iso, opts = {}) {
    const freshMin = opts.freshMin != null ? opts.freshMin : 15;
    const warnMin = opts.warnMin != null ? opts.warnMin : 90;
    if (!iso) return '<span class="pill neutral">never synced</span>';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '<span class="pill neutral">unknown</span>';
    const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
    const title = `Last synced ${new Date(t).toLocaleString('en-IN')}`;
    if (mins <= freshMin) return `<span class="pill ok" title="${title}">${this.relTime(mins)} ago</span>`;
    if (mins <= warnMin) return `<span class="pill warn" title="${title}">aging · ${this.relTime(mins)} ago</span>`;
    return `<span class="pill danger" title="${title}">stale · ${this.relTime(mins)} ago</span>`;
  },

  statusPill(status) {
    const map = {
      captured: ['Captured', 'neutral'], validation_failed: ['Validation failed', 'danger'],
      pending_approval: ['Pending approval', 'warn'], approved: ['Approved', 'info'],
      rejected: ['Rejected', 'danger'], paid: ['Paid', 'ok'], scheduled: ['Scheduled', 'info'],
      draft: ['Draft', 'neutral'], pending: ['Pending', 'warn'], processing: ['Processing', 'warn'], executing: ['Executing', 'warn'],
      completed: ['Completed', 'ok'], failed: ['Failed', 'danger'], pending_approval_pay: ['Awaiting approval', 'warn'], unavailable: ['Unavailable', 'neutral'],
      matched: ['Matched', 'ok'], mismatch: ['Mismatch', 'danger'], pending_m: ['Pending', 'warn'],
      none: ['No match', 'neutral'], connected: ['Connected', 'ok'], degraded: ['Degraded', 'warn'],
      disconnected: ['Disconnected', 'danger'], queued: ['Queued', 'neutral'], synced: ['Synced', 'ok'],
      retrying: ['Retrying', 'warn'], open: ['Open', 'danger'],
    };
    const m = map[status] || [status, 'neutral'];
    return `<span class="pill ${m[1]}">${this.esc(m[0])}</span>`;
  },

  modePill(mode) {
    return `<span class="pill neutral mono">${this.esc(mode || '—')}</span>`;
  },

  roleLabel(role) {
    return { cfo: 'CFO / Admin', finance_manager: 'Finance Manager', finance_executive: 'Finance Executive' }[role] || role;
  },

  toast(msg, type = 'ok') {
    const root = document.getElementById('toast-root');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3600);
  },

  openModal(html, wide = false) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) this.closeModal(); });
  },

  closeModal() {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';
  },

  confirm(title, text, onYes, yesLabel = 'Confirm') {
    this.openModal(`
      <div class="modal-head"><h3>${this.esc(title)}</h3></div>
      <div class="modal-body"><p>${this.esc(text)}</p></div>
      <div class="modal-foot">
        <button class="btn ghost" id="confirm-no">Cancel</button>
        <button class="btn danger" id="confirm-yes">${this.esc(yesLabel)}</button>
      </div>`);
    document.getElementById('confirm-no').onclick = () => this.closeModal();
    document.getElementById('confirm-yes').onclick = () => { this.closeModal(); onYes(); };
  },

  empty(text) {
    return `<div class="empty">${this.esc(text)}</div>`;
  },

  // Premium SVG area chart: grid lines, compact ₹ axis labels, highlighted
  // end point, and a hover tooltip per data point.
  trendChart(points, height = 190) {
    if (!points || points.length < 2) return '<div class="empty">No trend data yet</div>';
    const W = 940, H = height, padL = 58, padR = 16, padT = 12, padB = 26;
    const vals = points.map(p => p.balance);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const padV = (max - min) * 0.06;
    min -= padV; max += padV;
    const span = max - min;
    const x = (i) => padL + (i / (points.length - 1)) * (W - padL - padR);
    const y = (v) => H - padB - ((v - min) / span) * (H - padT - padB);
    const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
    const area = `${padL},${H - padB} ${line} ${W - padR},${H - padB}`;
    const last = points[points.length - 1];
    const first = points[0];
    const change = first.balance ? ((last.balance - first.balance) / Math.abs(first.balance)) * 100 : 0;
    const trendUp = change >= 0;

    const ticks = 4;
    const grid = [];
    for (let i = 0; i <= ticks; i++) {
      const val = min + (span * i) / ticks;
      const yy = y(val);
      grid.push(`<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#e8edf5" stroke-width="1"/>`);
      grid.push(`<text x="${padL - 8}" y="${yy + 3.5}" text-anchor="end" font-size="10" fill="#94a3b8">${this.inrCompact(val)}</text>`);
    }
    const xLabels = points
      .map((p, i) => ({ i, p }))
      .filter((_, i) => i % Math.max(1, Math.round(points.length / 5)) === 0)
      .map(({ i, p }) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#94a3b8">${this.date(p.date).slice(0, 6)}</text>`).join('');
    const dots = points.map((p, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p.balance).toFixed(1)}" r="2.2" fill="#1d4ed8"><title>${p.date}: ${this.inr(p.balance)}</title></circle>`).join('');

    return `<div class="chart-wrap">
      <div class="chart-summary">
        <span class="chart-value">${this.inrCompact(last.balance)}</span>
        <span class="chart-delta ${trendUp ? 'up' : 'down'}">${trendUp ? '↑' : '↓'} ${Math.abs(change).toFixed(1)}% · 30 days</span>
        <span class="muted small">${this.date(first.date)} — ${this.date(last.date)}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="trend" role="img" aria-label="Daily closing balance, last 30 days">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${grid.join('')}
        <polygon points="${area}" fill="url(#trendFill)"/>
        <polyline points="${line}" fill="none" stroke="#1d4ed8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        <circle cx="${x(points.length - 1)}" cy="${y(last.balance)}" r="4.5" fill="#fff" stroke="#1d4ed8" stroke-width="2.4"/>
        ${xLabels}
      </svg>
      <div class="chart-x"><span>Daily closing balance</span><span class="mono">₹ in Indian format</span></div>
    </div>`;
  },

  spinner() { return '<div class="spinner"></div>'; },

  async loadInto(el, promise) {
    el.innerHTML = this.spinner();
    try { el.innerHTML = await promise; } catch (e) { el.innerHTML = `<div class="empty">${this.esc(e.message)}</div>`; }
  },
};
