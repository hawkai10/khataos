'use strict';

/* ====================================================================
   KhataOS SPA — vanilla JS, no build step.
   ==================================================================== */

const App = {
  view: 'dashboard',
  timers: [],
  navBadges: {},

  init() {
    document.addEventListener('khataos:unauthorized', () => {
      this.showLogin();
      UI.toast('Session expired — please log in again.', 'warn');
    });
    const loginForm = document.getElementById('login-form');
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      try {
        await API.login(email, password);
        this.showApp();
      } catch (err) { UI.toast(err.message, 'err'); }
    });
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await API.logout();
      this.showLogin();
    });
    if (API.user) this.showApp(); else this.showLogin();
  },

  showLogin() { document.getElementById('app').classList.add('hidden'); document.getElementById('login-view').classList.remove('hidden'); },

  showApp() {
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    const u = API.user;
    document.getElementById('user-name').textContent = u.name;
    document.getElementById('user-role').textContent = UI.roleLabel(u.role);
    document.getElementById('user-avatar').textContent = u.name.charAt(0);
    this.renderNav();
    this.navigate('dashboard');
    AssistantUI.init();
  },

  NAV: [
    ['dashboard', 'Dashboard', 'grid'],
    ['cash', 'Cash & Banks', 'bank'],
    ['payables', 'Payables', 'doc'],
    ['payments', 'Payments', 'send'],
    ['recon', 'Reconciliation', 'refresh'],
    ['gst', 'GST & Compliance', 'percent'],
    ['tally', 'Tally Sync', 'layers'],
    ['onboarding', 'Onboarding', 'compass'],
    ['metrics', 'Success Metrics', 'bar'],
    ['system', 'System Health', 'activity'],
    ['settings', 'Settings & Audit', 'cog'],
  ],

  renderNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = this.NAV.map(([key, label, ico]) => `
      <button class="nav-item ${key === this.view ? 'active' : ''}" data-view="${key}">
        <span class="ico">${UI.svgIcon(UI.ICONS[ico])}</span><span>${label}</span>
        ${this.navBadges[key] ? `<span class="nav-badge">${this.navBadges[key]}</span>` : ''}
      </button>`).join('');
    nav.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => this.navigate(btn.dataset.view)));
  },

  clearTimers() { this.timers.forEach(t => clearInterval(t)); this.timers = []; },

  setBadge(key, count) {
    this.navBadges[key] = count || null;
    this.renderNav();
  },

  async navigate(view) {
    this.clearTimers();
    this.view = view;
    this.renderNav();
    const v = this.VIEWS[view];
    if (!v) { document.getElementById('view').innerHTML = UI.empty('Unknown view'); return; }
    document.getElementById('page-title').textContent = v.title;
    document.getElementById('page-sub').textContent = v.sub || '';
    const crumb = document.getElementById('page-crumb');
    if (crumb) crumb.textContent = v.title;
    const actions = document.getElementById('topbar-actions');
    actions.innerHTML = '';
    if (v.actions) v.actions(actions);
    const container = document.getElementById('view');
    container.innerHTML = UI.spinner();
    try { await v.render(container); } catch (err) { container.innerHTML = UI.empty(err.message); }
  },
};

/* ====================================================================
   Dashboard — the four morning questions + 5-7 KPIs
   ==================================================================== */
App.VIEWS = {};

App.VIEWS.dashboard = {
  title: 'CFO Dashboard',
  sub: 'Cash, payments and compliance at a glance',
  async render(el) {
    const d = await API.get('/api/dashboard');
    const kpis = [
      UI.kpiCard({ icon: 'bank', label: 'Available cash', value: UI.inrCompact(d.cash.available), sub: `${UI.inr(d.cash.available)} across ${d.cash.accounts} accounts`, title: `Available cash: ${UI.inr(d.cash.available)}` }),
      UI.kpiCard({ icon: 'calendar', label: 'Due this week', value: `${d.payments.due_this_week.count} payment${d.payments.due_this_week.count === 1 ? '' : 's'}`, sub: UI.inrCompact(d.payments.due_this_week.amount), alert: d.payments.due_this_week.count > 0 }),
      UI.kpiCard({ icon: 'shield', label: 'GST liability', value: UI.inrCompact(d.gst.liability), sub: `${d.gst.open_mismatches} GSTR-2B mismatch${d.gst.open_mismatches === 1 ? '' : 'es'} open`, alert: d.gst.open_mismatches > 0 }),
      UI.kpiCard({ icon: 'clock', label: 'Cash runway', value: d.cash.runway_months != null ? `${d.cash.runway_months} mo` : '—', sub: `burn ${UI.inrCompact(d.cash.monthly_burn)} / month` }),
      UI.kpiCard({ icon: 'target', label: 'Recon accuracy', value: `${d.recon.accuracy}%`, sub: `${d.recon.auto_matched}/${d.recon.total} auto-matched`, alert: d.recon.accuracy < d.recon.target, title: `Reconciliation accuracy vs target ${d.recon.target}%` }),
      UI.kpiCard({ icon: 'bell', label: 'Overdue invoices', value: `${d.payments.overdue.count}`, sub: d.payments.overdue.count ? UI.inrCompact(d.payments.overdue.amount) : 'nothing overdue', alert: d.payments.overdue.count > 0 }),
    ];
    el.innerHTML = `
      <div class="grid kpis">${kpis.join('')}</div>
      <div class="grid cols-2">
        <div class="card">
          <h3>Cash trend · last 30 days</h3>
          ${UI.trendChart(d.trend)}
          <div class="kv" style="margin-top:12px">
            <div class="item"><div class="k">Available</div><div class="v">${UI.inr(d.cash.available)}</div></div>
            <div class="item"><div class="k">Uncleared</div><div class="v">${UI.inr(d.cash.uncleared)}</div></div>
            <div class="item"><div class="k">Accounts</div><div class="v">${d.cash.accounts}</div></div>
            <div class="item"><div class="k">Runway</div><div class="v">${d.cash.runway_months != null ? d.cash.runway_months + ' months' : '—'}</div></div>
          </div>
          <div class="stat-row" style="margin-top:8px"><span class="k">Last bank sync</span><span class="v">${UI.freshPill(d.cash.last_synced_at)}</span></div>
        </div>
        <div class="grid">
          <div class="card">
            <h3>Payments due this week</h3>
            ${d.payments.due_this_week.count
              ? `<div class="stat-row"><span class="k">Count</span><span class="v">${d.payments.due_this_week.count}</span></div>
                 <div class="stat-row"><span class="k">Amount</span><span class="v">${UI.inrFull(d.payments.due_this_week.amount)}</span></div>`
              : UI.empty('Nothing due this week')}
            ${d.payments.overdue.count ? `<div class="stat-row" style="color:var(--danger)"><span class="k">Overdue</span><span class="v">${d.payments.overdue.count} · ${UI.inr(d.payments.overdue.amount)}</span></div>` : ''}
          </div>
          <div class="card">
            <h3>GST position</h3>
            <div class="stat-row"><span class="k">ITC available (${UI.esc(d.gst.period || '')})</span><span class="v">${UI.inr(d.gst.itc)}</span></div>
            <div class="stat-row"><span class="k">Liability (approved, unpaid)</span><span class="v">${UI.inr(d.gst.liability)}</span></div>
            <div class="stat-row"><span class="k">GSTR-2B mismatches</span><span class="v" style="color:${d.gst.open_mismatches ? 'var(--danger)' : 'var(--ok)'}">${d.gst.open_mismatches}</span></div>
            <div class="stat-row"><span class="k">GSTR-2B fetched</span><span class="v">${UI.freshPill(d.gst.fetched_at, { freshMin: 60, warnMin: 1440 })}</span></div>
            <div style="margin-top:10px"><a class="btn small" href="#" data-go="gst">Review GST →</a></div>
          </div>
          <div class="card">
            <h3>Reconciliation & Tally</h3>
            <div class="stat-row"><span class="k">Auto-match accuracy</span><span class="v">${d.recon.accuracy}%</span></div>
            <div class="stat-row"><span class="k">Auto-matched</span><span class="v">${d.recon.auto_matched}/${d.recon.total}</span></div>
            <div class="stat-row"><span class="k">Data as of</span><span class="v">${UI.freshPill(d.recon.as_of)}</span></div>
            <div class="stat-row"><span class="k">Tally sync</span><span class="v">${UI.statusPill(d.tally.status || 'disconnected')}</span></div>
            <div class="stat-row"><span class="k">Tally last sync</span><span class="v">${UI.freshPill(d.tally.last_sync_at, { freshMin: 5, warnMin: 30 })}</span></div>
            <div class="stat-row"><span class="k">Tally uptime (30d)</span><span class="v">${d.tally.uptime_30d}%</span></div>
          </div>
        </div>
      </div>`;
    el.querySelectorAll('[data-go]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); App.navigate(a.dataset.go); }));
  },
};

/* ====================================================================
   Cash & Banks — multi-bank visibility, AA consent onboarding, refresh
   ==================================================================== */
App.VIEWS.cash = {
  title: 'Cash & Banks',
  sub: 'Consolidated cash across Account Aggregator and direct API connections',
  actions(bar) {
    bar.innerHTML = `
      <button class="btn" id="cash-refresh">⟳ Refresh feeds</button>
      <button class="btn primary" id="cash-connect">＋ Connect a bank</button>`;
    bar.querySelector('#cash-connect').onclick = () => connectBankWizard();
    bar.querySelector('#cash-refresh').onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try { const r = await API.post('/api/cash/refresh'); UI.toast(`Fetched ${r.added_transactions} new transactions · recon ${r.recon.accuracy}%`); App.navigate('cash'); }
      catch (err) { UI.toast(err.message, 'err'); }
      finally { btn.disabled = false; }
    };
  },
  async render(el) {
    const [overview, accounts, txns, trend, decentro] = await Promise.all([
      API.get('/api/cash/overview'), API.get('/api/cash/accounts'),
      API.get('/api/cash/transactions?days=7'), API.get('/api/cash/trend?days=30'),
      API.get('/api/integrations/decentro/status'),
    ]);
    const total = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    const unc = accounts.reduce((s, a) => s + (a.uncleared || 0), 0);
    const inflow = txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const outflow = Math.abs(txns.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0));
    const syncMins = overview.last_synced_at ? Math.floor((Date.now() - new Date(overview.last_synced_at).getTime()) / 60000) : null;
    el.innerHTML = `
      ${syncMins != null && syncMins > 15 ? `
        <div class="stale-banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <span>Bank data was last synced <strong>${UI.relTime(syncMins)} ago</strong>. Balances may be outdated — refresh to see the latest cash position.</span>
          <button class="btn small" id="stale-refresh">⟳ Refresh now</button>
        </div>` : ''}
      <div class="grid kpis">
        ${UI.kpiCard({ icon: 'bank', label: 'Total available cash', value: UI.inrCompact(total), sub: `${UI.inr(total)} across ${accounts.length} accounts`, title: `Available cash: ${UI.inr(total)}` })}
        ${UI.kpiCard({ icon: 'refresh', label: 'Uncleared funds', value: UI.inrCompact(unc), sub: 'cheques / deposits in clearing' })}
        ${UI.kpiCard({ icon: 'bar', label: '7-day inflows', value: UI.inrCompact(inflow), sub: 'credits received' })}
        ${UI.kpiCard({ icon: 'bar', label: '7-day outflows', value: UI.inrCompact(outflow), sub: 'debits paid' })}
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h3>Cash trend · 30 days</h3>
          ${UI.trendChart(trend)}
        </div>
        <div class="card">
          <h3>Bank accounts</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Account</th><th class="num">Balance</th><th>Uncleared</th><th>Source</th><th>Last sync</th></tr></thead>
            <tbody>
              ${accounts.map(a => `
                <tr>
                  <td><strong>${UI.esc(a.account_name)}</strong><br><span class="muted small mono">${a.bank_name} · ${UI.esc(a.account_number.slice(-4).padStart(8, '•'))} · ${a.ifsc}</span></td>
                  <td class="num"><strong>${UI.inr(a.balance)}</strong></td>
                  <td class="num">${UI.inr(a.uncleared)}</td>
                  <td><span class="badge">${a.source === 'aa' ? 'AA' : 'Direct API'}</span></td>
                  <td>${UI.freshPill(a.last_synced_at)}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>
          <p class="muted small" style="margin:8px 0 0">Last full refresh: ${UI.date(overview.last_synced_at)} · Account Aggregator (Sahamati, simulated) · Decentro Connected Banking: <strong>${decentro.enabled ? 'live (configured)' : 'not configured'}</strong></p>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>Recent transactions · 7 days</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Mode</th><th class="num">Amount</th><th class="num">Balance</th><th>Status</th></tr></thead>
          <tbody>
            ${txns.slice(0, 25).map(t => `
              <tr>
                <td>${UI.date(t.txn_date)}</td>
                <td class="muted small">${UI.esc(t.account_name)}</td>
                <td class="cell-ellipsis" title="${UI.esc(t.description)}">${UI.esc(t.description)}</td>
                <td>${UI.modePill(t.mode)}</td>
                <td class="num" style="color:${t.amount >= 0 ? 'var(--ok)' : 'var(--ink)'}">${t.amount >= 0 ? '+' : '−'}${UI.inrFull(Math.abs(t.amount))}</td>
                <td class="num muted">${UI.inr(t.balance_after)}</td>
                <td>${t.status === 'uncleared' ? '<span class="pill warn">uncleared</span>' : '<span class="pill ok">posted</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
    const sr = el.querySelector('#stale-refresh');
    if (sr) sr.onclick = async () => { try { await API.post('/api/cash/refresh'); UI.toast('Bank feeds refreshed'); App.navigate('cash'); } catch (err) { UI.toast(err.message, 'err'); } };
  },
};

async function connectBankWizard() {
  const banks = await API.get('/api/banks');
  const decentro = await API.get('/api/integrations/decentro/status');
  UI.openModal(`
    <div class="modal-head"><h3>Connect a bank account</h3></div>
    <div class="modal-body">
      <div class="field"><label>Data provider</label>
        <select id="provider">
          <option value="aa">Account Aggregator (Sahamati) — simulated in demo</option>
          <option value="decentro" ${decentro.enabled ? '' : 'disabled'}>Decentro Connected Banking — live API ${decentro.enabled ? '' : '(not configured)'}</option>
        </select>
        ${!decentro.enabled ? `<p class="hint">Set <span class="mono">DECENTRO_CLIENT_ID</span>, <span class="mono">DECENTRO_CLIENT_SECRET</span>, <span class="mono">DECENTRO_MODULE_SECRET</span> (and <span class="mono">DECENTRO_PROVIDER_SECRET</span>) then restart the server to fetch real bank data via decentro.tech — see <a href="/docs/decentro.md" target="_blank">docs/decentro.md</a>.</p>` : ''}
      </div>
      <div class="field"><label>Bank</label>
        <select id="aa-bank">${banks.map(b => `<option value="${b.code}">${UI.esc(b.name)}${b.aa_supported ? ' (AA)' : ''}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Account number</label><input id="aa-account" placeholder="e.g. 002201045678"></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="aa-start">Continue</button></div>`);
  document.getElementById('aa-start').onclick = async () => {
    const provider = document.getElementById('provider').value;
    const bankCode = document.getElementById('aa-bank').value;
    const accountNumber = document.getElementById('aa-account').value.trim();
    if (!accountNumber) return UI.toast('Enter an account number', 'err');
    if (provider === 'decentro') {
      decentroFlow(bankCode, accountNumber);
      return;
    }
    try {
      const c = await API.post('/api/aa/consent/start', { bank_code: bankCode, account_number: accountNumber });
      UI.openModal(`
        <div class="modal-head"><h3>Consent request sent</h3></div>
        <div class="modal-body">
          <p>Consent-based access via the AA framework (Sahamati) — credentials never leave the bank. A request was raised (<span class="mono">${UI.esc(c.consentId)}</span>) and an OTP was sent to <strong>${UI.esc(c.otpSentTo)}</strong>.</p>
          <div class="field"><label>Enter 6-digit OTP</label><input id="aa-otp" maxlength="6" placeholder="••••••"></div>
          <p class="hint">Consent valid 365 days for balances + transactions. Revocable anytime.</p>
        </div>
        <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="aa-verify">Verify & connect</button></div>`);
      document.getElementById('aa-verify').onclick = async () => {
        const otp = document.getElementById('aa-otp').value;
        try {
          await API.post('/api/aa/consent/verify', { consent_id: c.consentId, otp, bank_code: bankCode, account_number: accountNumber });
          UI.closeModal();
          UI.toast('Bank connected — cash data pulled');
          App.navigate('cash');
          App.navigate('onboarding');
        } catch (err) { UI.toast(err.message, 'err'); }
      };
    } catch (err) { UI.toast(err.message, 'err'); }
  };
}

// Decentro Connected Banking connect flow: metadata -> bank portal redirect
// -> status polling + webhook confirmation -> account activation.
async function decentroFlow(bankCode, accountNumber) {
  UI.openModal(`
    <div class="modal-head"><h3>Link account via Decentro</h3></div>
    <div class="modal-body">
      <p class="muted small">These details go to Decentro's Link Account API, which returns a redirect to your bank's internet banking portal where you approve the connected-banking consent.</p>
      <div class="form-grid">
        <div class="field"><label>Account number</label><input id="d-acc" value="${UI.esc(accountNumber)}" disabled></div>
        <div class="field"><label>Bank</label><input value="${UI.esc(bankCode)}" disabled></div>
        <div class="field"><label>Account name</label><input id="d-name" placeholder="e.g. Company Name Pvt Ltd"></div>
        <div class="field"><label>IFSC</label><input id="d-ifsc" placeholder="ICIC0000022"></div>
        <div class="field"><label>PAN (business)</label><input id="d-pan" placeholder="AABCA1234F" maxlength="10"></div>
        <div class="field"><label>Mobile (registered)</label><input id="d-mobile" placeholder="98XXXXXXXX" maxlength="10"></div>
        <div class="field"><label>Email</label><input id="d-email" type="email" placeholder="finance@company.in"></div>
        <div class="field"><label>Customer ID (Decentro)</label><input id="d-customer" placeholder="optional"></div>
      </div>
      <p class="hint">Provider parameters (${bankCode === 'ICIC' ? 'ICICI: Corp ID, User ID, Alias ID' : 'Netbanking User ID'}):</p>
      ${bankCode === 'ICIC' ? `
        <div class="form-grid">
          <div class="field"><label>Corp ID *</label><input id="d-corp" placeholder="CORP_ID"></div>
          <div class="field"><label>User ID *</label><input id="d-user" placeholder="admin user id"></div>
          <div class="field"><label>Alias ID</label><input id="d-alias" placeholder="optional"></div>
        </div>` : `
        <div class="field"><label>Netbanking user ID *</label><input id="d-user" placeholder="user id with admin privileges"></div>`}
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="d-start">Request bank portal link</button></div>`);

  document.getElementById('d-start').onclick = async () => {
    const name = document.getElementById('d-name').value.trim();
    const ifsc = document.getElementById('d-ifsc').value.trim();
    const mobile = document.getElementById('d-mobile').value.trim();
    if (!name) return UI.toast('Account name is required', 'err');
    if (!ifsc) return UI.toast('IFSC is required', 'err');
    if (mobile && !/^\d{10}$/.test(mobile)) return UI.toast('Mobile must be 10 digits', 'err');
    const body = {
      bank_code: bankCode, account_number: accountNumber, name, ifsc,
      pan: document.getElementById('d-pan').value.trim() || undefined,
      mobile: mobile || undefined,
      email: document.getElementById('d-email').value.trim() || undefined,
      customer_id: document.getElementById('d-customer').value.trim() || undefined,
    };
    const uid = document.getElementById('d-user').value.trim();
    if (uid) body.user_id = uid;
    if (bankCode === 'ICIC') {
      const corp = document.getElementById('d-corp').value.trim();
      if (!corp) return UI.toast('Corp ID is required for ICICI', 'err');
      body.corp_id = corp;
      const alias = document.getElementById('d-alias').value.trim();
      if (alias) body.alias_id = alias;
    }
    try {
      const r = await API.post('/api/decentro/link', body);
      showDecentroPortalStep(r, accountNumber);
    } catch (err) { UI.toast(err.message, 'err'); }
  };
}

function showDecentroPortalStep(r, accountNumber) {
  let pollTimer = null;
  UI.openModal(`
    <div class="modal-head"><h3>Approve on your bank portal</h3></div>
    <div class="modal-body">
      <p>Decentro has created a link request. Open the portal below, log in, approve the <strong>Connected Banking</strong> consent, and confirm the OTP.</p>
      <div class="card" style="background:#fafbfc;text-align:center;padding:18px">
        <div class="muted small" style="word-break:break-all">${UI.esc(r.redirect_url)}</div>
        <div class="toolbar" style="justify-content:center;margin-top:12px">
          <button class="btn primary" id="d-open">Open bank portal</button>
        </div>
      </div>
      <div class="stat-row"><span class="k">Link status</span><span class="v" id="d-status"><span class="pill warn">waiting for approval…</span></span></div>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn small" id="d-check">I've approved — check now</button>
        <button class="btn small ghost" id="d-sim">Simulate approval callback (dev)</button>
      </div>
      <p class="hint">KhataOS also completes automatically when Decentro sends the Account Linkage Status Callback to <span class="mono">POST /api/decentro/webhook</span>.</p>
    </div>
    <div class="modal-foot"><button class="btn ghost" id="d-cancel">Close</button></div>`);

  const setStatus = (html) => { const el = document.getElementById('d-status'); if (el) el.innerHTML = html; };
  const finish = async (result) => {
    clearInterval(pollTimer);
    UI.toast(`Decentro linked — ${result.present_balance != null ? 'balance ' + UI.inr(result.present_balance) : ''} · ${result.transactions_pulled || 0} transactions pulled`);
    UI.closeModal();
    App.navigate('cash');
  };
  const poll = async () => {
    try {
      const s = await API.post('/api/decentro/link/status', { link_id: r.link_id });
      if (s.status === 'linked') { await finish(s); return true; }
      setStatus(`<span class="pill warn">${UI.esc(s.status || 'PENDING')}</span>`);
    } catch (err) { setStatus(`<span class="pill neutral">${UI.esc(err.message.slice(0, 60))}</span>`); }
    return false;
  };
  document.getElementById('d-open').onclick = () => window.open(r.redirect_url, '_blank');
  document.getElementById('d-check').onclick = async () => { if (!(await poll())) UI.toast('Not linked yet — approve on the portal or wait for the callback', 'warn'); };
  document.getElementById('d-sim').onclick = async () => {
    try {
      const w = await API.post('/api/decentro/webhook', { account_number: accountNumber, status: 'SUCCESS' });
      UI.toast(w.linked ? 'Callback processed — account linked' : 'Callback ignored', 'warn');
    } catch (err) { UI.toast(err.message, 'err'); }
  };
  document.getElementById('d-cancel').onclick = () => { clearInterval(pollTimer); UI.closeModal(); };
  pollTimer = setInterval(async () => { if (await poll()) clearInterval(pollTimer); }, 4000);
}

/* ====================================================================
   Payables — invoice capture (email / PDF / manual), OCR, approvals,
   three-way matching
   ==================================================================== */
App.VIEWS.payables = {
  title: 'Payables',
  sub: 'Invoice-to-payment workflow · capture → validate → approve → pay',
  tab: 'all',
  q: '',
  actions(bar) {
    bar.innerHTML = `
      <button class="btn" id="pay-email">✉ Simulate email</button>
      <button class="btn" id="pay-pdf">⇪ Upload PDF</button>
      <button class="btn primary" id="pay-manual">＋ Manual entry</button>`;
    bar.querySelector('#pay-email').onclick = () => captureModal('email');
    bar.querySelector('#pay-pdf').onclick = () => captureModal('pdf');
    bar.querySelector('#pay-manual').onclick = () => captureModal('manual');
  },
  async render(el) {
    const [pending] = await Promise.all([API.get('/api/approvals/pending').catch(() => [])]);
    App.setBadge('payables', pending.length);
    const q = encodeURIComponent(this.q);
    const inv = await API.get(`/api/invoices?q=${q}`);
    const tabs = [
      ['all', 'All'], ['pending_approval', 'Pending approval'], ['approved', 'Approved'],
      ['scheduled', 'Scheduled'], ['paid', 'Paid'], ['overdue', 'Overdue'], ['rejected', 'Rejected'],
    ];
    const counts = {};
    inv.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
    const overdueCount = inv.filter(i => i.due_date && i.due_date < new Date().toISOString().slice(0, 10) && ['approved', 'scheduled', 'pending_approval'].includes(i.status)).length;
    counts.overdue = overdueCount;
    const tab = this.tab === 'overdue'
      ? inv.filter(i => i.due_date && i.due_date < new Date().toISOString().slice(0, 10) && ['approved', 'scheduled', 'pending_approval'].includes(i.status))
      : this.tab === 'all' ? inv : inv.filter(i => i.status === this.tab);
    el.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <div class="tabs" style="margin:0;border:0">
            ${tabs.map(([key, label]) => `<div class="tab ${this.tab === key ? 'active' : ''}" data-tab="${key}">${label}${counts[key] ? ` <span class="badge">${counts[key]}</span>` : ''}</div>`).join('')}
          </div>
          <input type="search" id="inv-q" placeholder="Search invoice no / vendor…" value="${UI.esc(this.q)}">
        </div>
        ${tab.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Vendor</th><th>Date</th><th>Due</th><th class="num">Gross</th><th class="num">Net payable</th><th>3-way</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${tab.map(i => `
              <tr class="row-click" data-inv="${i.id}">
                <td><strong>${UI.esc(i.invoice_no)}</strong><br><span class="muted small">${UI.esc(i.source)}</span></td>
                <td class="cell-ellipsis" title="${UI.esc(i.vendor_name || '')}">${UI.esc(i.vendor_name || '—')}</td>
                <td>${UI.date(i.invoice_date)}</td>
                <td>${UI.date(i.due_date)}<br><span class="muted small">${UI.rel(i.due_date)}</span></td>
                <td class="num">${UI.inr(i.gross_amount)}</td>
                <td class="num"><strong>${UI.inr(i.net_payable)}</strong></td>
                <td>${UI.statusPill(i.three_way_match || 'none')}</td>
                <td>${UI.statusPill(i.status)}</td>
                <td><button class="btn small" data-inv="${i.id}">View</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : UI.empty('No invoices in this view')}
      </div>`;
    el.querySelectorAll('[data-inv]').forEach(btn => btn.addEventListener('click', () => openInvoice(btn.dataset.inv)));
    el.querySelector('#inv-q').addEventListener('input', (e) => { this.q = e.target.value; App.navigate('payables'); });
    el.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => { this.tab = t.dataset.tab; App.navigate('payables'); }));
  },
};

function captureModal(mode) {
  if (mode === 'email') {
    UI.openModal(`
      <div class="modal-head"><h3>Invoice capture — email forwarding</h3></div>
      <div class="modal-body">
        <p>Set your forwarding rule once in your mail client: <strong>invoices@yourcompany.in → forward@invoices.khataos.in</strong>. Any invoice forwarded here is OCR'd and pushed into the approval queue automatically.</p>
        <p class="hint">No sample emails exist — forwarding a real supplier invoice triggers capture.</p>
      </div>
      <div class="modal-foot"><button class="btn primary" onclick="UI.closeModal()">Got it</button></div>`);
    return;
  }
  if (mode === 'pdf') {
    UI.openModal(`
      <div class="modal-head"><h3>Invoice capture — PDF upload</h3></div>
      <div class="modal-body">
        <p>Paste the OCR text extracted from the PDF (our OCR engine is trained on Indian GST invoice formats) and the invoice will be captured.</p>
        <div class="field"><label>OCR text</label><textarea id="pdf-text" rows="8" placeholder="Supplier, GSTIN, invoice no, taxable value, CGST/SGST/IGST, TDS, grand total…"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="pdf-ocr">Run OCR</button></div>`);
    document.getElementById('pdf-ocr').onclick = async () => {
      try {
        const text = document.getElementById('pdf-text').value;
        const inv = await API.post('/api/invoices/capture', { source: 'pdf', text });
        UI.closeModal();
        UI.toast(`Extracted ${inv.invoice_no} · pending approval`);
        App.navigate('payables');
      } catch (err) { UI.toast(err.message, 'err'); }
    };
    return;
  }
  // manual
  UI.openModal(`
    <div class="modal-head"><h3>Manual invoice entry</h3></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="field"><label>Invoice no *</label><input id="m-no" placeholder="INV-2026-XXXX"></div>
        <div class="field"><label>Vendor</label><select id="m-vendor"></select></div>
        <div class="field"><label>Invoice date</label><input id="m-date" type="date"></div>
        <div class="field"><label>Due date</label><input id="m-due" type="date"></div>
        <div class="field"><label>Taxable amount (₹) *</label><input id="m-tax" type="number" step="0.01" min="0"></div>
        <div class="field"><label>Inter-state (IGST 18%)</label><select id="m-inter"><option value="0">No — CGST+SGST 9% each</option><option value="1">Yes — IGST 18%</option></select></div>
        <div class="field"><label>GSTIN of supplier</label><input id="m-gstin" placeholder="29AAAAA0000A1Z5"></div>
        <div class="field"><label>Purchase order (Tally)</label><input id="m-po" placeholder="PO-2026-XXX"></div>
      </div>
      <p class="hint">TDS and net payable are computed from the vendor master; approval routing follows your tenant rules.</p>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="m-save">Save invoice</button></div>`);
  (async () => {
    const vendors = await API.get('/api/vendors');
    document.getElementById('m-vendor').innerHTML = '<option value="">— none —</option>' + vendors.map(v => `<option value="${v.id}">${UI.esc(v.name)}</option>`).join('');
    document.getElementById('m-date').value = new Date().toISOString().slice(0, 10);
  })();
  document.getElementById('m-save').onclick = async () => {
    const no = document.getElementById('m-no').value.trim();
    const tax = parseFloat(document.getElementById('m-tax').value);
    if (!no || isNaN(tax)) return UI.toast('Invoice no and taxable amount required', 'err');
    try {
      await API.post('/api/invoices/capture', {
        source: 'manual', invoice_no: no, vendor_id: document.getElementById('m-vendor').value || null,
        invoice_date: document.getElementById('m-date').value, due_date: document.getElementById('m-due').value || undefined,
        taxable_amount: tax, igst: document.getElementById('m-inter').value === '1' ? tax * 0.18 : 0,
        gstin_vendor: document.getElementById('m-gstin').value || undefined,
        purchase_order_no: document.getElementById('m-po').value || undefined,
      });
      UI.closeModal();
      UI.toast('Invoice captured → pending approval');
      App.navigate('payables');
    } catch (err) { UI.toast(err.message, 'err'); }
  };
}

async function openInvoice(id) {
  const inv = await API.get(`/api/invoices/${id}`);
  const me = API.user;
  const nextPending = inv.approvals.find(a => a.status === 'pending' && a.required_role === me.role);
  const canApprove = !!nextPending;
  const canReject = !!inv.approvals.find(a => a.status === 'pending' && a.required_role === me.role);
  UI.openModal(`
    <div class="modal-head">
      <div class="detail-head">
        <div><div class="big">${UI.esc(inv.invoice_no)}</div>
        <div class="muted">${UI.esc(inv.vendor ? inv.vendor.name : 'Unassigned vendor')} · ${UI.esc(inv.gstin_vendor || 'no GSTIN')}</div></div>
        <div style="text-align:right">${UI.statusPill(inv.status)}<br><span class="muted small">${UI.esc(inv.source)} · ${UI.date(inv.invoice_date)}</span></div>
      </div>
    </div>
    <div class="modal-body">
      <div class="kv" style="margin-bottom:12px">
        <div class="item"><div class="k">Gross amount</div><div class="v">${UI.inr(inv.gross_amount)}</div></div>
        <div class="item"><div class="k">Taxable</div><div class="v">${UI.inr(inv.taxable_amount)}</div></div>
        <div class="item"><div class="k">CGST / SGST / IGST</div><div class="v small">${UI.inr(inv.cgst)} / ${UI.inr(inv.sgst)} / ${UI.inr(inv.igst)}</div></div>
        <div class="item"><div class="k">TDS (${UI.esc(inv.vendor ? inv.vendor.tds_section : '—')})</div><div class="v">−${UI.inr(inv.tds_amount)}</div></div>
        <div class="item"><div class="k">Net payable</div><div class="v">${UI.inr(inv.net_payable)}</div></div>
        <div class="item"><div class="k">Due date</div><div class="v">${UI.date(inv.due_date)} <span class="muted small">${UI.rel(inv.due_date)}</span></div></div>
      </div>
      ${inv.notes ? `<p class="small" style="background:var(--warn-soft);border-radius:8px;padding:8px 10px;color:#92400e">${UI.esc(inv.notes)}</p>` : ''}
      <h3 style="margin:14px 0 8px">Lines</h3>
      ${inv.lines.length ? `<div class="table-wrap"><table>
        <thead><tr><th>HSN</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th></tr></thead>
        <tbody>${inv.lines.map(l => `<tr><td class="mono">${UI.esc(l.hsn)}</td><td>${UI.esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${UI.inr(l.rate)}</td><td class="num">${UI.inr(l.taxable)}</td></tr>`).join('')}</tbody>
      </table></div>` : UI.empty('No line items (OCR low-confidence capture)')}
      <h3 style="margin:14px 0 8px">Approval chain</h3>
      ${inv.approvals.map(a => `
        <div class="stat-row"><span class="k">Level ${a.level} · ${UI.esc(a.threshold_note)}</span>
          <span class="v">${a.status === 'pending' ? '<span class="pill warn">waiting for ' + UI.roleLabel(a.required_role) + '</span>' : UI.statusPill(a.status) + (a.approver_name ? ' <span class="muted small">by ' + UI.esc(a.approver_name) + '</span>' : '')}</span></div>`).join('')}
      <h3 style="margin:14px 0 8px">Three-way match</h3>
      <div class="stat-row"><span class="k">PO / Receipt</span><span class="v">${UI.esc(inv.purchase_order_no || '—')} / ${UI.esc(inv.receipt_note_no || '—')}</span></div>
      <div style="margin-top:8px"><button class="btn small" id="twm-btn">Run three-way match</button></div>
      <div id="twm-result" class="small" style="margin-top:6px"></div>
      ${inv.payments && inv.payments.length ? `<h3 style="margin:14px 0 8px">Payments</h3>
        ${inv.payments.map(p => `<div class="stat-row"><span class="k">${p.mode} · ${UI.esc(p.reference)}</span><span class="v">${UI.statusPill(p.status)}</span></div>`).join('')}` : ''}
    </div>
    <div class="modal-foot">
      ${canReject ? `<button class="btn danger" id="inv-reject">Reject</button>` : ''}
      ${canApprove ? `<button class="btn primary" id="inv-approve">Approve (level ${nextPending.level})</button>` : ''}
      <button class="btn ghost" onclick="UI.closeModal()">Close</button>
    </div>`, true);
  document.getElementById('twm-btn').onclick = async () => {
    try { const r = await API.post(`/api/invoices/${inv.id}/three-way-match`, {}); document.getElementById('twm-result').innerHTML = `${UI.statusPill(r.status)} ${UI.esc(r.detail)}`; }
    catch (err) { document.getElementById('twm-result').textContent = err.message; }
  };
  if (canApprove) document.getElementById('inv-approve').onclick = async () => {
    try { await API.post(`/api/invoices/${inv.id}/approve`, {}); UI.closeModal(); UI.toast('Approved — Tally voucher queued'); App.navigate('payables'); }
    catch (err) { UI.toast(err.message, 'err'); }
  };
  if (canReject) document.getElementById('inv-reject').onclick = async () => {
    try { await API.post(`/api/invoices/${inv.id}/reject`, {}); UI.closeModal(); UI.toast('Invoice rejected'); App.navigate('payables'); }
    catch (err) { UI.toast(err.message, 'err'); }
  };
}

/* ====================================================================
   Payments — UPI / IMPS / NEFT / RTGS via gateway orchestration
   ==================================================================== */
App.VIEWS.payments = {
  title: 'Payments',
  sub: 'RazorpayX orchestration (simulated) · batch, scheduled & instant',
  tab: 'all',
  actions(bar) {
    bar.innerHTML = `
      <button class="btn" id="pay-new">＋ New payment</button>
      <button class="btn" id="pay-batch">▤ Batch pay</button>`;
    bar.querySelector('#pay-new').onclick = paymentModal;
    bar.querySelector('#pay-batch').onclick = batchModal;
  },
  async render(el) {
    const pay = await API.get('/api/payments?status=all');
    const tabs = [['all', 'All'], ['processing', 'Processing'], ['pending_approval', 'Awaiting approval'], ['scheduled', 'Scheduled'], ['completed', 'Completed'], ['failed', 'Failed']];
    const counts = {};
    pay.forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
    const tab = this.tab === 'all' ? pay : pay.filter(p => p.status === this.tab);
    el.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <div class="tabs" style="margin:0;border:0">
            ${tabs.map(([k, l]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${l}${counts[k] ? ` <span class="badge">${counts[k]}</span>` : ''}</div>`).join('')}
          </div>
          <span class="muted small" id="pay-live"></span>
        </div>
        <div id="pay-table">
        ${tab.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Reference</th><th>Vendor</th><th>Invoices</th><th>Mode</th><th>Type</th><th class="num">Gross</th><th class="num">TDS</th><th class="num">Net</th><th>Scheduled</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${tab.map(p => `
              <tr>
                <td><strong class="mono">${UI.esc(p.reference || '—')}</strong><br><span class="muted small">${p.gateway_txn_id ? 'UTR ' + UI.esc(p.gateway_txn_id) : ''}</span></td>
                <td class="cell-ellipsis" title="${UI.esc(p.vendor_name || '')}">${UI.esc(p.vendor_name || '—')}</td>
                <td class="small cell-ellipsis wide" title="${UI.esc(p.invoice_refs || '')}">${UI.esc(p.invoice_refs || '—')}</td>
                <td>${UI.modePill(p.mode)}</td>
                <td><span class="badge">${UI.esc(p.type)}</span></td>
                <td class="num">${UI.inr(p.amount)}</td>
                <td class="num muted">${UI.inr(p.tds_amount)}</td>
                <td class="num"><strong>${UI.inr(p.net_amount)}</strong></td>
                <td>${UI.date(p.scheduled_date)}</td>
                <td>${UI.statusPill(p.status)}${p.failure_reason ? `<div class="small" style="color:var(--danger)">${UI.esc(p.failure_reason)}</div>` : ''}</td>
                <td>${actionButtons(p)}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : UI.empty('No payments in this view')}
        </div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => { this.tab = t.dataset.tab; App.navigate('payments'); }));
    bindPaymentActions(el);
    if (pay.some(p => ['processing', 'pending', 'queued'].includes(p.status))) {
      const live = el.querySelector('#pay-live');
      if (live) live.textContent = '● tracking live gateway updates…';
      App.timers.push(setInterval(async () => {
        const fresh = await API.get('/api/payments?status=all');
        if (!fresh.some(p => ['processing', 'pending', 'queued'].includes(p.status))) { App.navigate('payments'); return; }
        const table = document.getElementById('pay-table');
        if (table) {
          const t = fresh.filter(p => this.tab === 'all' || p.status === this.tab);
          table.innerHTML = t.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Reference</th><th>Vendor</th><th>Invoices</th><th>Mode</th><th>Type</th><th class="num">Gross</th><th class="num">TDS</th><th class="num">Net</th><th>Scheduled</th><th>Status</th><th></th></tr></thead>
            <tbody>${t.map(p => `
              <tr>
                <td><strong class="mono">${UI.esc(p.reference || '—')}</strong><br><span class="muted small">${p.gateway_txn_id ? 'UTR ' + UI.esc(p.gateway_txn_id) : ''}</span></td>
                <td class="cell-ellipsis" title="${UI.esc(p.vendor_name || '')}">${UI.esc(p.vendor_name || '—')}</td>
                <td class="small cell-ellipsis wide" title="${UI.esc(p.invoice_refs || '')}">${UI.esc(p.invoice_refs || '—')}</td>
                <td>${UI.modePill(p.mode)}</td>
                <td><span class="badge">${UI.esc(p.type)}</span></td>
                <td class="num">${UI.inr(p.amount)}</td>
                <td class="num muted">${UI.inr(p.tds_amount)}</td>
                <td class="num"><strong>${UI.inr(p.net_amount)}</strong></td>
                <td>${UI.date(p.scheduled_date)}</td>
                <td>${UI.statusPill(p.status)}${p.failure_reason ? `<div class="small" style="color:var(--danger)">${UI.esc(p.failure_reason)}</div>` : ''}</td>
                <td>${actionButtons(p)}</td>
              </tr>`).join('')}</tbody>
          </table></div>` : UI.empty('No payments in this view');
          bindPaymentActions(document.getElementById('view'));
        }
      }, 2500));
    }
  },
};

function actionButtons(p) {
  const canApprove = p.status === 'pending_approval';
  const canExecute = p.status === 'approved';
  const btns = [];
  if (canApprove) btns.push(`<button class="btn small primary" data-approve="${p.id}">Approve</button>`);
  if (canExecute) btns.push(`<button class="btn small" data-execute="${p.id}">Execute now</button>`);
  return btns.join(' ');
}

function bindPaymentActions(root) {
  root.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', async () => {
    try { await API.post(`/api/payments/${b.dataset.approve}/approve`, {}); UI.toast('Approved — dispatching to gateway'); App.navigate('payments'); }
    catch (err) { UI.toast(err.message, 'err'); }
  }));
  root.querySelectorAll('[data-execute]').forEach(b => b.addEventListener('click', async () => {
    try { await API.post(`/api/payments/${b.dataset.execute}/execute`, {}); UI.toast('Instant execution initiated'); App.navigate('payments'); }
    catch (err) { UI.toast(err.message, 'err'); }
  }));
}

async function paymentModal() {
  const [vendors, invoices, accounts] = await Promise.all([
    API.get('/api/vendors'), API.get('/api/invoices?status=all'), API.get('/api/cash/accounts'),
  ]);
  const payable = invoices.filter(i => ['approved', 'scheduled', 'pending_approval'].includes(i.status) && !['inv_11', 'inv_12'].includes(i.id));
  UI.openModal(`
    <div class="modal-head"><h3>New payment</h3></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="field"><label>Vendor</label><select id="p-vendor"></select></div>
        <div class="field"><label>Mode</label><select id="p-mode">
          <option value="NEFT">NEFT</option><option value="IMPS">IMPS</option>
          <option value="UPI">UPI</option><option value="RTGS">RTGS</option>
        </select></div>
        <div class="field"><label>Type</label><select id="p-type">
          <option value="batch">Batch (standard)</option><option value="scheduled">Scheduled</option>
          <option value="instant">Instant</option>
        </select></div>
        <div class="field"><label>Scheduled date</label><input id="p-date" type="date"></div>
        <div class="field"><label>Debit account</label><select id="p-account">
          ${accounts.map(a => `<option value="${a.id}">${UI.esc(a.account_name)} (${UI.inr(a.balance)})</option>`).join('')}
        </select></div>
      </div>
      <div class="field"><label>Invoices</label>
        <select id="p-invoices" size="6" multiple style="height:auto">
          ${payable.map(i => `<option value="${i.id}">${UI.esc(i.invoice_no)} — ${UI.esc(i.vendor_name || '?')} — ${UI.inr(i.net_payable)}</option>`).join('')}
        </select>
        <div class="hint">Ctrl/Cmd+click to select multiple. GST ledger and TDS section are auto-tagged from vendor master.</div>
      </div>
      <div id="p-summary" class="small muted"></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="p-save">Create payment</button></div>`);
  document.getElementById('p-vendor').innerHTML = vendors.map(v => `<option value="${v.id}">${UI.esc(v.name)} (${UI.esc(v.tds_section || 'no TDS')} ${v.tds_rate * 100}%)</option>`).join('');
  document.getElementById('p-invoices').addEventListener('change', () => {
    const sel = Array.from(document.getElementById('p-invoices').selectedOptions).map(o => o.value);
    const sum = sel.reduce((s, id) => s + (payable.find(i => i.id === id)?.net_payable || 0), 0);
    document.getElementById('p-summary').textContent = sel.length ? `${sel.length} invoice(s) · net ₹${sum.toLocaleString('en-IN')} (TDS already deducted)` : '';
  });
  document.getElementById('p-save').onclick = async () => {
    const vendorId = document.getElementById('p-vendor').value;
    const invoiceIds = Array.from(document.getElementById('p-invoices').selectedOptions).map(o => o.value);
    if (!vendorId || !invoiceIds.length) return UI.toast('Select a vendor and at least one invoice', 'err');
    try {
      const r = await API.post('/api/payments', {
        vendor_id: vendorId, invoice_ids: invoiceIds, mode: document.getElementById('p-mode').value,
        type: document.getElementById('p-type').value,
        scheduled_date: document.getElementById('p-date').value || undefined,
        account_id: document.getElementById('p-account').value,
      });
      UI.closeModal();
      UI.toast(r.status === 'pending_approval' ? 'Payment created — awaiting CFO approval' : 'Payment created — dispatching');
      App.navigate('payments');
    } catch (err) { UI.toast(err.message, 'err'); }
  };
}

async function batchModal() {
  const invoices = await API.get('/api/invoices?status=all');
  const payable = invoices.filter(i => ['approved', 'scheduled', 'pending_approval'].includes(i.status)).slice(0, 8);
  UI.openModal(`
    <div class="modal-head"><h3>Batch payments</h3></div>
    <div class="modal-body">
      <p class="muted small">Select approved invoices — one payment is created per vendor, grouped by mode, and dispatched to RazorpayX as a batch.</p>
      <div class="field"><label>Mode</label><select id="b-mode">
        <option value="NEFT">NEFT</option><option value="IMPS">IMPS</option><option value="UPI">UPI</option><option value="RTGS">RTGS</option>
      </select></div>
      <div class="field"><label>Schedule</label><select id="b-sched"><option value="">As soon as possible</option><option value="tmr">Tomorrow</option><option value="week">Next week</option></select></div>
      <div class="field"><label>Invoices</label>
        ${payable.map(i => `<label style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--line)">
          <input type="checkbox" class="b-inv" value="${i.id}"> <span style="flex:1">${UI.esc(i.invoice_no)} — ${UI.esc(i.vendor_name || '?')}</span> <strong>${UI.inr(i.net_payable)}</strong>
        </label>`).join('')}
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="b-save">Create batch</button></div>`);
  document.getElementById('b-save').onclick = async () => {
    const ids = Array.from(document.querySelectorAll('.b-inv:checked')).map(c => c.value);
    if (!ids.length) return UI.toast('Select at least one invoice', 'err');
    const selected = invoices.filter(i => ids.includes(i.id));
    const byVendor = {};
    selected.forEach(i => { (byVendor[i.vendor_id] = byVendor[i.vendor_id] || []).push(i.id); });
    const sched = document.getElementById('b-sched').value;
    let scheduledDate;
    if (sched === 'tmr') { const d = new Date(); d.setDate(d.getDate() + 1); scheduledDate = d.toISOString().slice(0, 10); }
    if (sched === 'week') { const d = new Date(); d.setDate(d.getDate() + 7); scheduledDate = d.toISOString().slice(0, 10); }
    try {
      const items = Object.keys(byVendor).map(v => ({ vendor_id: v, invoice_ids: byVendor[v], mode: document.getElementById('b-mode').value, scheduled_date: scheduledDate }));
      const r = await API.post('/api/payments/batch', { items });
      UI.closeModal();
      UI.toast(`Batch created: ${r.length} payment(s)`);
      App.navigate('payments');
    } catch (err) { UI.toast(err.message, 'err'); }
  };
}

/* ====================================================================
   Reconciliation — auto-match engine, manual matching, accuracy score
   ==================================================================== */
App.VIEWS.recon = {
  title: 'Reconciliation',
  sub: 'Bank transactions × platform payments × Tally vouchers',
  async render(el) {
    const [summary, unmatched] = await Promise.all([
      API.get('/api/recon/summary'), API.get('/api/recon/unmatched'),
    ]);
    const s = summary;
    el.innerHTML = `
      <div class="grid kpis">
        <div class="card kpi"><div class="label">Auto-match accuracy</div><div class="value">${s.accuracy}%</div><div class="sub">target ≥ ${s.target}%</div></div>
        <div class="card kpi"><div class="label">Auto-matched</div><div class="value">${s.auto_matched}</div><div class="sub">of ${s.total} posted transactions (30d)</div></div>
        <div class="card kpi"><div class="label">Manual matches</div><div class="value">${s.manual_matched}</div><div class="sub">reviewed by finance team</div></div>
        <div class="card kpi ${unmatched.length ? 'alert' : ''}"><div class="label">Unmatched</div><div class="value">${unmatched.length}</div><div class="sub">awaiting review</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h3>Unmatched transactions</h3>
          ${unmatched.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Mode</th><th class="num">Amount</th><th></th></tr></thead>
            <tbody>${unmatched.slice(0, 12).map(t => `
              <tr>
                <td>${UI.date(t.txn_date)}</td>
                <td class="muted small">${UI.esc(t.account_name)}</td>
                <td class="small cell-ellipsis wide" title="${UI.esc(t.description)}">${UI.esc(t.description)}</td>
                <td>${UI.modePill(t.mode)}</td>
                <td class="num ${t.amount < 0 ? '' : 'muted'}">${t.amount < 0 ? '−' : '+'}${UI.inr(Math.abs(t.amount))}</td>
                <td><button class="btn small" data-mmatch="${t.id}">Match</button></td>
              </tr>`).join('')}</tbody>
          </table></div>
          <div class="toolbar" style="margin-top:10px">
            <button class="btn small primary" id="recon-run">⟳ Re-run matcher</button>
          </div>` : UI.empty('No unmatched transactions — the bank matches cleanly')}
        </div>
        <div class="card">
          <h3>Recent matches</h3>
          <div class="stat-row"><span class="k">Data as of</span><span class="v">${UI.freshPill(summary.as_of)}</span></div>
          ${summary.recent && summary.recent.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Bank txn</th><th>Matched to</th><th>Type</th><th class="num">Confidence</th><th>By</th></tr></thead>
            <tbody>${summary.recent.slice(0, 12).map(m => `
              <tr>
                <td class="small">${UI.date(m.txn_date)} · ${UI.esc((m.description || '').slice(0, 28))}</td>
                <td class="small">${m.payment_ref ? `<span class="mono">${UI.esc(m.payment_ref)}</span>` : UI.esc(m.tally_voucher_no || '—')}</td>
                <td>${UI.statusPill(m.match_type)}</td>
                <td class="num">${Math.round((m.confidence || 0) * 100)}%</td>
                <td class="muted small">${m.matched_by === 'auto' ? 'auto' : 'manual'}</td>
              </tr>`).join('')}</tbody>
          </table></div>` : UI.empty('No matches recorded')}
          <p class="hint" style="margin-top:10px">Matching uses amount + date + reference; fuzzy matching handles partial/combined payments. Voucher matches come from the Tally ODBC sync (simulated).</p>
        </div>
      </div>`;
    el.querySelector('#recon-run').onclick = async (btn) => {
      btn.currentTarget.disabled = true;
      try { const r = await API.post('/api/recon/run', {}); UI.toast(`Matcher finished — accuracy ${r.score.accuracy}% (${r.auto} matched)`); App.navigate('recon'); }
      catch (err) { UI.toast(err.message, 'err'); }
      finally { btn.currentTarget.disabled = false; }
    };
    el.querySelectorAll('[data-mmatch]').forEach(b => b.addEventListener('click', () => manualMatch(b.dataset.mmatch, unmatched.find(t => t.id === b.dataset.mmatch))));
  },
};

async function manualMatch(txnId, txn) {
  const payments = await API.get('/api/payments?status=completed');
  UI.openModal(`
    <div class="modal-head"><h3>Manual match</h3></div>
    <div class="modal-body">
      <p class="small">${UI.date(txn.txn_date)} · <span class="mono">${UI.esc(txn.description)}</span> · <strong>${UI.inr(Math.abs(txn.amount))}</strong> (${txn.amount < 0 ? 'debit' : 'credit'})</p>
      <div class="field"><label>Match to platform payment</label><select id="rm-pay">
        <option value="">— choose payment —</option>
        ${payments.map(p => `<option value="${p.id}">${UI.esc(p.reference)} — ${UI.esc(p.vendor_name || '')} — ${UI.inr(p.net_amount)}</option>`).join('')}
      </select></div>
      <div class="field"><label>…or Tally voucher no</label><input id="rm-vno" placeholder="PV-00012345"></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="UI.closeModal()">Cancel</button><button class="btn primary" id="rm-save">Match</button></div>`);
  document.getElementById('rm-save').onclick = async () => {
    const paymentId = document.getElementById('rm-pay').value;
    const vno = document.getElementById('rm-vno').value.trim();
    if (!paymentId && !vno) return UI.toast('Select a payment or enter a voucher no', 'err');
    try {
      if (paymentId) await API.post('/api/recon/manual-match', { bank_txn_id: txnId, payment_id: paymentId });
      else await API.post(`/api/recon/unmatched/${txnId}/voucher`, {});
      UI.closeModal(); UI.toast('Matched manually'); App.navigate('recon');
    } catch (err) { UI.toast(err.message, 'err'); }
  };
}

/* ====================================================================
   GST & Compliance — ITC visibility, liabilities, GSTR-2B mismatch scan,
   ClearTax/Tally-ready exports
   ==================================================================== */
App.VIEWS.gst = {
  title: 'GST & Compliance',
  sub: 'Input credit, liabilities, and GSTR-2B reconciliation',
  async render(el) {
    const g = await API.get('/api/gst/summary');
    el.innerHTML = `
      <div class="grid kpis">
        <div class="card kpi"><div class="label">ITC available</div><div class="value">${UI.inr(g.itc)}</div><div class="sub">${UI.esc(g.period || '—')} · GSTR-2B</div></div>
        <div class="card kpi"><div class="label">Pending liability</div><div class="value">${UI.inr(g.liability)}</div><div class="sub">approved invoices awaiting payment</div></div>
        <div class="card kpi"><div class="label">Committed</div><div class="value">${UI.inr(g.committed)}</div><div class="sub">incl. pending approvals</div></div>
        <div class="card kpi ${g.mismatch_count ? 'alert' : ''}"><div class="label">GSTR-2B mismatches</div><div class="value">${g.mismatch_count}</div><div class="sub">${g.mismatch_count ? 'action needed' : 'clean'}</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h3>ITC breakdown (${UI.esc(g.period || '—')})</h3>
          <div class="stat-row"><span class="k">CGST</span><span class="v">${UI.inr(g.itc_cgst)}</span></div>
          <div class="stat-row"><span class="k">SGST</span><span class="v">${UI.inr(g.itc_sgst)}</span></div>
          <div class="stat-row"><span class="k">IGST</span><span class="v">${UI.inr(g.itc_igst)}</span></div>
          <div class="stat-row"><span class="k">Fetched (GSTR-2B)</span><span class="v">${UI.freshPill(g.fetched_at, { freshMin: 60, warnMin: 1440 })}</span></div>
          <div class="toolbar" style="margin-top:12px">
            <button class="btn small" id="gst-refresh">⟳ Refresh GSTR-2B</button>
            <button class="btn small" id="gst-export3">⇩ GSTR-3B CSV (ClearTax)</button>
            <button class="btn small" id="gst-export2">⇩ GSTR-2B ITC CSV</button>
          </div>
          <p class="hint" style="margin-top:10px">No return filing in the MVP — these CSVs import directly into ClearTax or Tally for final filing.</p>
        </div>
        <div class="card">
          <h3>GSTR-2B mismatch flags</h3>
          ${g.mismatches.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Invoice</th><th>Supplier</th><th class="num">Platform ITC</th><th class="num">GSTR-2B</th><th class="num">Variance</th><th>Note</th></tr></thead>
            <tbody>${g.mismatches.slice(0, 15).map(m => `
              <tr>
                <td class="mono">${UI.esc(m.invoice_no)}</td>
                <td class="small">${UI.esc(m.vendor_name)}<br><span class="muted mono">${UI.esc(m.vendor_gstin)}</span></td>
                <td class="num">${UI.inr(m.platform_amount)}</td>
                <td class="num">${UI.inr(m.gstr2b_amount)}</td>
                <td class="num" style="color:${m.variance ? 'var(--danger)' : 'var(--ok)'}">${m.variance > 0 ? '+' : ''}${UI.inr(m.variance)}</td>
                <td class="small muted">${UI.esc(m.note)}</td>
              </tr>`).join('')}</tbody>
          </table></div>` : UI.empty('No mismatches in the current period')}
        </div>
      </div>`;
    el.querySelector('#gst-refresh').onclick = async () => {
      try { const r = await API.post('/api/gst/refresh', {}); UI.toast(`GSTR-2B refreshed — ${r.mismatches} mismatch(es)`); App.navigate('gst'); }
      catch (err) { UI.toast(err.message, 'err'); }
    };
    el.querySelector('#gst-export3').onclick = () => { window.location.href = `/api/gst/export?type=gstr3b&period=${encodeURIComponent(g.period || '')}`; };
    el.querySelector('#gst-export2').onclick = () => { window.location.href = `/api/gst/export?type=gstr2b&period=${encodeURIComponent(g.period || '')}`; };
  },
};

/* ====================================================================
   Tally Sync — connector health, queue, sync logs
   ==================================================================== */
App.VIEWS.tally = {
  title: 'TallyPrime Sync',
  sub: 'Windows connector · ODBC + XML · TallyPrime 2.1+',
  async render(el) {
    const [health, logs] = await Promise.all([API.get('/api/tally/health'), API.get('/api/tally/sync-logs')]);
    el.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h3>Connector health</h3>
          <div class="kv">
            <div class="item"><div class="k">Status</div><div class="v">${UI.statusPill(health.status || 'disconnected')}</div></div>
            <div class="item"><div class="k">Version</div><div class="v small">${UI.esc(health.version || '—')}</div></div>
            <div class="item"><div class="k">Mode</div><div class="v small">${UI.esc(health.mode || '—')} ${health.mode === 'single-user' ? '(queued syncs)' : ''}</div></div>
            <div class="item"><div class="k">Queue depth</div><div class="v">${health.queue_depth}</div></div>
            <div class="item"><div class="k">Uptime (30d)</div><div class="v">${health.uptime_30d != null ? health.uptime_30d + '%' : '—'}</div></div>
            <div class="item"><div class="k">Last sync</div><div class="v">${UI.freshPill(health.last_sync_at, { freshMin: 5, warnMin: 30 })}</div></div>
          </div>
          <div class="toolbar" style="margin-top:14px">
            <button class="btn small" id="tally-pull">⇩ Pull ledgers & vouchers</button>
            <a class="btn small" href="/docs/tally-connector.md" target="_blank">Connector docs</a>
          </div>
          <p class="hint" style="margin-top:10px">Approving an invoice queues a purchase voucher here; completed payments sync back. In single-user mode the connector queues and retries until the Tally data file is free.</p>
        </div>
        <div class="card">
          <h3>Recent sync activity</h3>
          ${logs.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Entity</th><th>Action</th><th>Status</th><th>Queued</th><th></th></tr></thead>
            <tbody>${logs.slice(0, 25).map(l => `
              <tr>
                <td class="small">${UI.esc(l.entity)}${l.entity_id ? ` <span class="muted mono">· ${UI.esc(String(l.entity_id).slice(0, 14))}</span>` : ''}</td>
                <td class="small">${UI.esc(l.action)}</td>
                <td>${UI.statusPill(l.status)}${l.error ? `<div class="small" style="color:var(--danger)">${UI.esc(l.error)}</div>` : ''}</td>
                <td class="muted small">${UI.date(l.queued_at)}</td>
                <td>${l.status === 'failed' ? `<button class="btn small" data-retry="${l.id}">Retry</button>` : ''}</td>
              </tr>`).join('')}</tbody>
          </table></div>` : UI.empty('No sync activity yet — run "Pull ledgers & vouchers"')}
        </div>
      </div>`;
    el.querySelector('#tally-pull').onclick = async () => {
      try { await API.post('/api/tally/pull-ledgers', {}); UI.toast('Ledger pull queued — will sync shortly'); setTimeout(() => App.navigate('tally'), 1600); }
      catch (err) { UI.toast(err.message, 'err'); }
    };
    el.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', async () => {
      try { await API.post(`/api/tally/retry/${b.dataset.retry}`, {}); UI.toast('Retry queued'); App.navigate('tally'); }
      catch (err) { UI.toast(err.message, 'err'); }
    }));
  },
};

/* ====================================================================
   Onboarding — self-serve journey, ≤15 min to first cash
   ==================================================================== */
App.VIEWS.onboarding = {
  title: 'Onboarding',
  sub: 'Self-serve: first bank connected and cash visible in under 15 minutes',
  async render(el) {
    const steps = await API.get('/api/onboarding');
    const done = steps.filter(s => s.status === 'done').length;
    const pct = Math.round((done / Math.max(steps.length, 4)) * 100);
    const defs = {
      connect_bank: ['₹', 'Connect bank via Account Aggregator', 'Consent-based access to ICICI, HDFC, Axis, Kotak, Yes, SBI + direct APIs'],
      install_tally: ['▣', 'Install Tally connector', 'Windows service on your Tally server · ODBC + XML · TallyPrime 2.1+'],
      email_routing: ['✉', 'Enable email forwarding', 'Forward invoices to forward@invoices.khataos.in — OCR does the rest'],
      vendor_import: ['☰', 'Import vendor master', 'Ledgers, GSTINs, TDS sections and bank details pulled from Tally'],
    };
    el.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <h3>Setup progress — ${pct}%</h3>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <p class="muted small">White-glove onboarding (₹50,000 one-time) has our team complete these steps for you. Everything below is demo-actionable right now.</p>
      </div>
      <div class="card">
        <div class="onboard-list">
          ${['connect_bank', 'install_tally', 'email_routing', 'vendor_import'].map(step => {
            const s = steps.find(x => x.step === step);
            const d = defs[step];
            return `
              <div class="onboard-item ${s && s.status === 'done' ? 'done' : ''}">
                <div class="step-ico">${s && s.status === 'done' ? '✓' : d[0]}</div>
                <div class="step-body">
                  <div class="step-title">${d[1]}</div>
                  <div class="step-detail">${s && s.detail ? UI.esc(s.detail) : d[2]}</div>
                </div>
                ${s && s.status === 'done' ? '<span class="pill ok">done</span>' : `<button class="btn small primary" data-step="${step}">Do it</button>`}
              </div>`;
          }).join('')}
        </div>
      </div>`;
    el.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
      const step = b.dataset.step;
      if (step === 'connect_bank') { App.navigate('cash'); setTimeout(() => connectBankWizard(), 400); }
      if (step === 'install_tally') {
        UI.confirm('Install Tally connector', 'This downloads and installs the KhataOS connector service on your Tally server, then runs the first sync. Simulate the guided installer now?', async () => {
          await API.post('/api/onboarding/install_tally/complete', { detail: 'Connector v0.1.0 installed, first sync OK' });
          UI.toast('Tally connector installed & synced'); App.navigate('onboarding');
        }, 'Install (demo)');
      }
      if (step === 'email_routing') {
        UI.confirm('Email forwarding', 'Set your forwarding rule (invoices@yourcompany.in → forward@invoices.khataos.in). Forwarded invoices are OCR\u2019d and pushed into the approval queue.', async () => {
          await API.post('/api/onboarding/email_routing/complete', { detail: 'forward@invoices.khataos.in active' });
          UI.toast('Email routing marked complete'); App.navigate('onboarding');
        }, 'Mark complete');
      }
      if (step === 'vendor_import') {
        UI.confirm('Vendor import', 'Pull ledgers, GSTINs, TDS sections and bank details from Tally into the KhataOS vendor master. Demo now?', async () => {
          await API.post('/api/onboarding/vendor_import/complete', { detail: '8 vendors imported from Tally' });
          UI.toast('Vendor master imported'); App.navigate('onboarding');
        }, 'Import (demo)');
      }
    }));
  },
};

/* ====================================================================
   Success Metrics — MVP targets vs current (simulated) performance
   ==================================================================== */
App.VIEWS.metrics = {
  title: 'Success Metrics',
  sub: 'MVP targets defined before code — instrumented where the product can self-report',
  async render(el) {
    const m = await API.get('/api/metrics');
    const bar = (val, target, invert = false) => {
      const pct = Math.min(100, Math.round((val / target) * 100));
      return `<div class="metric-bar"><div class="${pct >= 100 ? 'hit' : 'miss'}" style="width:${pct}%"></div></div>
        <div class="small muted" style="margin-top:3px">${invert ? `${val} ≤ target ${target}` : `${val} of target ${target}`}</div>`;
    };
    el.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h3>Commercial</h3>
          <div class="stat-row"><span class="k">Paying customers (6 mo)</span><span class="v">${m.customers.paying} (target ${m.customers.target})</span></div>
          ${bar(m.customers.paying, m.customers.target)}
          <div class="stat-row" style="margin-top:8px"><span class="k">Average contract value</span><span class="v">${UI.inr(m.customers.acv_inr)} / yr (target ₹3,00,000)</span></div>
          <div class="stat-row"><span class="k">Retention at 6 months</span><span class="v">${m.customers.retention_6m}% (target > 90%)</span></div>
          <div class="stat-row"><span class="k">Banks reachable (AA + direct)</span><span class="v">${m.banks.connected} (target ${m.banks.target})</span></div>
          <div style="margin-top:4px">${bar(m.banks.connected, m.banks.target)}</div>
          <p class="hint" style="margin-top:8px">Simulated baselines — replace with live sales pipeline input.</p>
        </div>
        <div class="card">
          <h3>Product</h3>
          <div class="stat-row"><span class="k">Tally sync uptime (30d)</span><span class="v">${m.tally_uptime}% (target ≥ ${m.target_uptime}%)</span></div>
          ${bar(m.tally_uptime, m.target_uptime)}
          <div class="stat-row" style="margin-top:8px"><span class="k">Auto bank reconciliation</span><span class="v">${m.recon.accuracy}% (target ≥ ${m.recon.target}%)</span></div>
          ${bar(m.recon.accuracy, m.recon.target)}
          <div class="stat-row" style="margin-top:8px"><span class="k">Invoice→payment cycle</span><span class="v">${m.cycle.avg_days != null ? m.cycle.avg_days + 'd vs baseline ' + m.cycle.baseline_days + 'd' : '—'}</span></div>
          <div class="stat-row"><span class="k">Improvement</span><span class="v" style="color:${(m.cycle.improvement_pct || 0) >= m.cycle.target_pct ? 'var(--ok)' : 'var(--warn)'}">${m.cycle.improvement_pct != null ? m.cycle.improvement_pct + '%' : '—'} (target ≥ ${m.cycle.target_pct}%)</span></div>
          <div class="stat-row"><span class="k">Daily active users</span><span class="v">${m.engagement.dau}/${m.engagement.mau} (${m.engagement.daumau_pct}% · target ≥ ${m.engagement.target_pct}%)</span></div>
          ${bar(m.engagement.dau, m.engagement.mau)}
          <p class="hint" style="margin-top:8px">DAU/MAU updates from real logins; cycle time and recon accuracy are computed from live platform data.</p>
        </div>
      </div>`;
  },
};

/* ====================================================================
   Settings & Audit — approval rules, RBAC matrix, audit trail
   ==================================================================== */
App.VIEWS.settings = {
  title: 'Settings & Audit',
  sub: 'Approval rules, roles, and the immutable audit trail',
  async render(el) {
    const [settings, users, audit] = await Promise.all([API.get('/api/settings'), API.get('/api/users').catch(() => []), API.get('/api/audit').catch(() => [])]);
    el.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h3>Approval rules</h3>
          <div class="field"><label>CFO approval threshold (invoices)</label><input id="s-cfo" type="number" value="${settings.cfo_approval_threshold || 100000}"></div>
          <div class="field"><label>CFO approval threshold (payments)</label><input id="s-pay" type="number" value="${settings.payment_approval_threshold || 500000}"></div>
          <p class="hint">Invoices above the threshold route through level-2 CFO approval. Payments above the payment threshold require CFO sign-off before dispatch.</p>
          <button class="btn primary" id="s-save">Save rules</button>
        </div>
        <div class="card">
          <h3>Role-based access</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Capability</th><th>CFO</th><th>Manager</th><th>Executive</th></tr></thead>
            <tbody>
              <tr><td>Capture invoices</td><td>✓</td><td>✓</td><td>✓</td></tr>
              <tr><td>Approve invoices ≤ ₹1L</td><td>✓</td><td>✓</td><td>—</td></tr>
              <tr><td>Approve invoices > ₹1L</td><td>✓</td><td>—</td><td>—</td></tr>
              <tr><td>Create / schedule payments</td><td>✓</td><td>✓</td><td>✓</td></tr>
              <tr><td>Approve payments > ₹5L</td><td>✓</td><td>—</td><td>—</td></tr>
              <tr><td>Manual reconciliation</td><td>✓</td><td>✓</td><td>—</td></tr>
              <tr><td>Change settings</td><td>✓</td><td>—</td><td>—</td></tr>
            </tbody>
          </table></div>
          <div class="small muted" style="margin-top:8px">Team: ${users.map(u => `${UI.esc(u.name)} (${UI.roleLabel(u.role)})`).join(' · ') || '—'}</div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>Audit trail</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
          <tbody>${audit.slice(0, 30).map(a => `
            <tr>
              <td class="muted small">${UI.date(a.at)}</td>
              <td>${UI.esc(a.user_name)}</td>
              <td><span class="badge">${UI.esc(a.action)}</span></td>
              <td class="small">${UI.esc(a.entity)}${a.entity_id ? ' · ' + UI.esc(String(a.entity_id).slice(0, 18)) : ''}</td>
              <td class="muted small">${UI.esc(a.details || '')}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    document.getElementById('s-save').onclick = async () => {
      try {
        await API.put('/api/settings', {
          cfo_approval_threshold: parseFloat(document.getElementById('s-cfo').value),
          payment_approval_threshold: parseFloat(document.getElementById('s-pay').value),
        });
        UI.toast('Approval rules updated');
      } catch (err) { UI.toast(err.message, 'err'); }
    };
  },
};

/* ====================================================================
   System Health — databases, event queue, and integrations at a glance
   ==================================================================== */
App.VIEWS.system = {
  title: 'System Health',
  sub: 'Every subsystem this platform runs on — live from the running instance',
  async render(el) {
    const h = await API.get('/api/system/health');
    const engineLabel = { sqlite: 'SQLite (dev / zero-setup)', pglite: 'PostgreSQL — in-process (pglite)', postgres: 'PostgreSQL — server (AWS Mumbai in production)' }[h.database.engine] || h.database.engine;
    const dbUp = h.database.tables > 0;
    const queueOk = (h.queue.pending || 0) < 50;
    const tallyOk = h.integrations.tally && h.integrations.tally.status === 'connected';
    const decentroOk = h.integrations.decentro.enabled;
    const overall = dbUp && queueOk ? 'operational' : 'attention';
    el.innerHTML = `
      <div class="grid kpis">
        ${UI.kpiCard({ icon: 'activity', label: 'Platform status', value: overall === 'operational' ? 'Operational' : 'Needs attention', sub: `uptime ${Math.floor(h.app.uptime_seconds / 60)} min · Node ${UI.esc(h.app.node)}`, alert: overall !== 'operational' })}
        ${UI.kpiCard({ icon: 'database', label: 'Database', value: h.database.engine === 'sqlite' ? 'SQLite' : 'PostgreSQL', sub: `${h.database.tables} tables · ${engineLabel}`, alert: !dbUp })}
        ${UI.kpiCard({ icon: 'cpu', label: 'Event queue', value: `${h.queue.pending} pending`, sub: `${h.queue.processed} processed · ${h.queue.failed} failed`, alert: !queueOk })}
        ${UI.kpiCard({ icon: 'plug', label: 'Tally connector', value: h.integrations.tally ? (h.integrations.tally.status || '—') : '—', sub: `uptime ${h.integrations.tally ? h.integrations.tally.uptime_30d + '%' : '—'}`, alert: !tallyOk })}
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h3>${UI.svgIcon(UI.ICONS.database)} Database</h3>
          <div class="stat-row"><span class="k">Engine</span><span class="v">${engineLabel}</span></div>
          <div class="stat-row"><span class="k">Location</span><span class="v small">${UI.esc(h.database.location)}</span></div>
          <div class="stat-row"><span class="k">Tables</span><span class="v">${h.database.tables}</span></div>
          <div class="stat-row"><span class="k">Started</span><span class="v small">${UI.date(h.app.started_at)} ${new Date(h.app.started_at).toLocaleTimeString('en-IN')}</span></div>
          <div class="kv" style="margin-top:12px">
            ${Object.entries(h.database.row_counts).slice(0, 8).map(([t, c]) => `<div class="item"><div class="k">${UI.esc(t)}</div><div class="v">${c.toLocaleString('en-IN')}</div></div>`).join('')}
          </div>
          <p class="hint" style="margin-top:10px">In production this is Aurora PostgreSQL in ap-south-1 (RBI data-localized), with ClickHouse for analytics. Set <span class="mono">KHATAOS_DATABASE_URL</span> to switch engines — the API surface stays identical.</p>
        </div>
        <div class="card">
          <h3>${UI.svgIcon(UI.ICONS.cpu)} Event queue & jobs</h3>
          <div class="stat-row"><span class="k">Pending / running</span><span class="v">${h.queue.pending}</span></div>
          <div class="stat-row"><span class="k">Processed</span><span class="v">${h.queue.processed}</span></div>
          <div class="stat-row"><span class="k">Failed</span><span class="v" style="color:${h.queue.failed ? 'var(--danger)' : 'var(--ok)'}">${h.queue.failed}</span></div>
          <p class="hint" style="margin-top:10px">Bank ingestion, Tally sync and gateway execution run asynchronously so slow providers never block the UI. In production this is SQS with a DLQ.</p>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>${UI.svgIcon(UI.ICONS.plug)} Integrations</h3>
        <div class="kv">
          <div class="item"><div class="k">Banks supported</div><div class="v">${h.integrations.banks_supported}</div></div>
          ${h.integrations.bank_accounts.map(b => `<div class="item"><div class="k">Accounts — ${UI.esc(b.source)}</div><div class="v">${b.count}</div></div>`).join('')}
          <div class="item"><div class="k">Decentro Connected Banking</div><div class="v">${h.integrations.decentro.enabled ? 'configured · live API' : 'not configured (simulated feed)'}</div></div>
          <div class="item"><div class="k">Tally connector</div><div class="v">${h.integrations.tally ? `${UI.esc(h.integrations.tally.version)} · ${UI.freshPill(h.integrations.tally.last_sync_at, { freshMin: 5, warnMin: 30 })}` : '—'}</div></div>
          <div class="item"><div class="k">GSTN / GSTR-2B</div><div class="v">${h.integrations.gstn ? `${UI.esc(h.integrations.gstn.period)} · ${UI.freshPill(h.integrations.gstn.fetched_at, { freshMin: 60, warnMin: 1440 })}` : 'not fetched'}</div></div>
          <div class="item"><div class="k">AI assistant</div><div class="v">${h.integrations.ai.generative_configured ? 'deterministic + generative' : 'deterministic engine'}</div></div>
        </div>
      </div>`;
  },
};

/* ====================================================================
   KhataOS Assistant — Monday.com-style, data-aware copilot
   ==================================================================== */
const AssistantUI = {
  inited: false,
  open: false,
  greeted: false,
  prompts: [],

  init() {
    if (this.inited) return;
    this.inited = true;
    const root = document.getElementById('assistant-root');
    root.innerHTML = `
      <button class="ai-fab" id="ai-fab" title="Ask KhataOS Assistant">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>
        <span>Ask KhataOS</span>
      </button>
      <div class="ai-panel hidden" id="ai-panel" role="dialog" aria-label="KhataOS Assistant">
        <div class="ai-head">
          <div class="ai-title">
            <span class="ai-logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/></svg></span>
            <div><div class="ai-name">KhataOS Assistant</div><div class="ai-sub"><span class="ai-dot"></span> live platform data · role-aware</div></div>
          </div>
          <button class="close-x" id="ai-close" aria-label="Close assistant">×</button>
        </div>
        <div class="ai-suggest-wrap" id="ai-suggest-wrap">
          <div class="ai-suggest-label">Suggested actions</div>
          <div class="ai-suggest" id="ai-suggest"></div>
        </div>
        <div class="ai-messages" id="ai-messages"></div>
        <form class="ai-input-row" id="ai-form">
          <input id="ai-text" placeholder="Ask about cash, payments, GST, Tally…" autocomplete="off" aria-label="Ask a question">
          <button class="ai-send" type="submit" aria-label="Send question">➤</button>
        </form>
        <div class="ai-foot" id="ai-foot">Answers come from your live platform data</div>
      </div>`;
    document.getElementById('ai-fab').onclick = () => this.toggle();
    document.getElementById('ai-close').onclick = () => this.close();
    document.getElementById('ai-form').addEventListener('submit', (e) => { e.preventDefault(); this.send(); });
    API.get('/api/assistant/prompts')
      .then(r => {
        this.prompts = r.prompts || [];
        const foot = document.getElementById('ai-foot');
        if (foot && r.status && r.status.generative_configured) foot.textContent = 'Deterministic engine + generative AI configured';
      })
      .catch(() => {});
  },

  toggle() { this.open ? this.close() : this.openPanel(); },

  openPanel() {
    this.open = true;
    const panel = document.getElementById('ai-panel');
    panel.classList.remove('hidden');
    const fab = document.getElementById('ai-fab');
    if (fab) fab.classList.add('hidden');
    if (!this.greeted) {
      this.greeted = true;
      this.addMsg('ai', `<div class="ai-greet">Namaste! I'm KhataOS Assistant — I can see your live cash, payables, payments, GST, reconciliation and Tally data, and I'll suggest what to do next.</div>`);
      if (this.prompts.length) this.addPromptChips(this.prompts);
    }
    this.refreshSuggestions();
    this.scrollBottom();
    const input = document.getElementById('ai-text');
    if (input) setTimeout(() => input.focus(), 120);
  },

  close() {
    this.open = false;
    document.getElementById('ai-panel').classList.add('hidden');
    const fab = document.getElementById('ai-fab');
    if (fab) fab.classList.remove('hidden');
  },

  async refreshSuggestions() {
    try {
      const s = await API.get('/api/assistant/suggestions');
      const wrap = document.getElementById('ai-suggest-wrap');
      const box = document.getElementById('ai-suggest');
      if (!wrap || !box) return;
      if (!s.length) { wrap.classList.add('hidden'); return; }
      wrap.classList.remove('hidden');
      box.innerHTML = s.map(x => `<button class="ai-chip" data-view="${UI.esc(x.action && x.action.view || 'dashboard')}">${UI.esc(x.label)}</button>`).join('');
      box.querySelectorAll('.ai-chip').forEach(c => c.addEventListener('click', () => { App.navigate(c.dataset.view); }));
    } catch { /* non-fatal */ }
  },

  addMsg(role, html) {
    const box = document.getElementById('ai-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = `ai-msg ${role}`;
    div.innerHTML = html;
    box.appendChild(div);
    this.scrollBottom();
  },

  addPromptChips(prompts) {
    const chips = prompts.map(p => `<button class="ai-chip ai-prompt" data-q="${UI.esc(p.q)}">${UI.esc(p.label)}</button>`).join('');
    this.addMsg('ai', `<div class="ai-prompts">${chips}</div>`);
    document.querySelectorAll('.ai-prompt').forEach(c => c.addEventListener('click', () => {
      const input = document.getElementById('ai-text');
      input.value = c.dataset.q;
      this.send();
    }));
  },

  showTyping() {
    const box = document.getElementById('ai-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'ai-msg ai typing';
    div.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    box.appendChild(div);
    this.scrollBottom();
  },
  hideTyping() {
    const t = document.querySelector('.ai-msg.typing');
    if (t) t.remove();
  },

  scrollBottom() {
    const box = document.getElementById('ai-messages');
    if (box) box.scrollTop = box.scrollHeight;
  },

  async send() {
    const input = document.getElementById('ai-text');
    const q = (input.value || '').trim();
    if (!q) return;
    input.value = '';
    this.addMsg('user', UI.esc(q));
    this.showTyping();
    try {
      const r = await API.post('/api/assistant/ask', { question: q });
      this.hideTyping();
      const html = [`<p>${UI.esc(r.answer)}</p>`, this.renderAiData(r.intent, r.data), this.renderSuggestions(r.suggestions)].filter(Boolean).join('');
      this.addMsg('ai', html);
      this.refreshSuggestions();
    } catch (err) {
      this.hideTyping();
      this.addMsg('ai', `<p class="ai-err">Sorry — ${UI.esc(err.message)}</p>`);
    }
  },

  renderSuggestions(list) {
    if (!list || !list.length) return '';
    return `<div class="ai-actions"><div class="ai-actions-label">Suggested next steps</div>${list.map(x =>
      `<button class="ai-chip" data-view="${UI.esc(x.action && x.action.view || 'dashboard')}">${UI.esc(x.label)}</button>`).join('')}</div>`;
  },

  aiTable(headers, rows) {
    if (!rows || !rows.length) return '';
    return `<div class="ai-table"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  },

  renderAiData(intent, data) {
    if (!data) return '';
    const kv = (items) => `<div class="kv ai-kv">${items.map(([k, v]) => `<div class="item"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>`;
    switch (intent) {
      case 'cash': {
        const mins = data.last_synced_at ? Math.max(0, Math.floor((Date.now() - new Date(data.last_synced_at).getTime()) / 60000)) : null;
        return kv([['Available cash', UI.inr(data.available)], ['Uncleared', UI.inr(data.uncleared)], ['Accounts', data.accounts], ['Synced', mins != null ? UI.relTime(mins) + ' ago' : '—']]);
      }
      case 'runway':
        return kv([['Available cash', UI.inr(data.available)], ['Monthly burn', UI.inr(data.monthly_burn)], ['Runway', data.runway_months != null ? data.runway_months + ' months' : '—']]);
      case 'due':
        return (data.rows && data.rows.length ? this.aiTable(['Invoice', 'Vendor', 'Due', 'Net payable'], data.rows.slice(0, 6).map(i => [UI.esc(i.invoice_no), UI.esc(i.vendor_name || '—'), UI.date(i.due_date), UI.inr(i.net_payable)])) : '') +
          (data.overdue && data.overdue.length ? `<div class="ai-note">⚠ ${data.overdue.length} overdue · ${UI.inr(data.overdue_amount)}</div>` : '');
      case 'gst':
        return kv([['ITC available', UI.inr(data.itc)], ['Pending liability', UI.inr(data.liability)], ['Open mismatches', data.mismatches.length]]);
      case 'recon':
        return kv([['Accuracy', data.accuracy + '%'], ['Auto-matched', data.auto_matched + ' / ' + data.total], ['Unmatched (recent)', data.unmatched.length]]);
      case 'tally':
        return kv([['Status', UI.statusPill(data.status || 'disconnected')], ['Uptime (30d)', (data.uptime_30d != null ? data.uptime_30d + '%' : '—')], ['Queue', data.queue_depth]]);
      case 'approvals':
        return this.aiTable(['Invoice', 'Vendor', 'Gross', 'Level'], (data.rows || []).map(r => [UI.esc(r.invoice_no), UI.esc(r.vendor_name || '—'), UI.inr(r.gross_amount), 'L' + r.level]));
      case 'failed':
        return this.aiTable(['Reference', 'Vendor', 'Mode', 'Net', 'Reason'], (data.rows || []).map(p => [UI.esc(p.reference), UI.esc(p.vendor_name || '—'), p.mode, UI.inr(p.net_amount), UI.esc(p.failure_reason || '—')]));
      case 'vendors':
        return this.aiTable(['Vendor', 'Outstanding', 'Invoices'], (data.rows || []).map(v => [UI.esc(v.name), UI.inr(v.amount), v.invoices]));
      case 'spend':
        return this.aiTable(['Category', 'Amount', 'Share'], (data.rows || []).map(r => [UI.esc(r.category), UI.inr(r.amount), r.share + '%']));
      case 'suggestions':
        return this.renderSuggestions(data.suggestions);
      default:
        return '';
    }
  },
};

// wire up suggestion chips rendered inside messages
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.ai-msg .ai-chip');
  if (chip && chip.dataset.view) { App.navigate(chip.dataset.view); }
});

document.addEventListener('DOMContentLoaded', () => App.init());
