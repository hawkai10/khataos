'use strict';

// Admin & platform domain: auth, users/audit, the finance dashboard, AI
// assistant, onboarding, settings, metrics and system health.

const { all, get, insert, run, update } = require('../db');
const dbModule = require('../db');
const { nowIso, todayStr, daysAgo, daysAhead, inr, formatINR } = require('../util');
const { ApiError, login, logout, requireRole, audit, recentAudit, publicUser } = require('../auth');
const { TallyConnector } = require('../adapters');
const Decentro = require('../decentro');
const Gstn = require('../gstn');
const recon = require('../recon');
const Assistant = require('../ai');
const Cash = require('../services/cash');
const Company = require('../services/company');
const Gst = require('../services/gst');
const { bodyOf, requireNonEmptyString } = require('./validators');
const { companyOf } = require('./helpers');

function register(r, deps) {
  const { ok } = deps;

  // ===================== AUTH =====================
  r.post('/api/auth/login', async (req, res) => {
    const { email, password } = bodyOf(req);
    if (!email || !password) throw new ApiError(400, 'email and password required');
    ok(res, await login(email, password));
  });

  r.post('/api/auth/logout', async (req, res) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (token) await logout(token);
    ok(res, { loggedOut: true });
  });

  r.get('/api/me', async (req, res, p, user) => {
    ok(res, publicUser(user));
  });

  r.get('/api/users', async (req, res, p, user) => {
    requireRole(user, ['cfo']);
    ok(res, await all('SELECT id, name, email, role, department, last_login_at FROM users WHERE company_id = ? ORDER BY role', [companyOf(user)]));
  });

  r.get('/api/audit', async (req, res, p, user) => {
    ok(res, await recentAudit(companyOf(user), 100));
  });

  // ===================== DASHBOARD =====================
  r.get('/api/dashboard', async (req, res, p, user) => {
    const coId = companyOf(user);
    const { accounts, available } = await Cash.availableCash(coId);
    const uncleared = await Cash.totalUncleared(coId);

    const today = todayStr();
    const due = await all(`SELECT * FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled','pending_approval') AND due_date >= ? AND due_date <= ? ORDER BY due_date`, [coId, today, daysAhead(7)]);
    const overdue = await all(`SELECT * FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled') AND due_date < ? ORDER BY due_date`, [coId, today]);
    const dueAmount = inr(due.reduce((s, i) => s + i.net_payable, 0));
    const overdueAmount = inr(overdue.reduce((s, i) => s + i.net_payable, 0));

    const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
    const gstLiability = await Gst.netPayableSum(coId, ['approved', 'scheduled']);
    const mismatches = (await get(`SELECT COUNT(*) AS c FROM gst_mismatches WHERE company_id = ? AND status = 'open'`, [coId])).c;

    const outflows = await all(`SELECT COALESCE(SUM(amount),0) AS s FROM bank_transactions WHERE company_id = ? AND amount < 0 AND txn_date >= ?`, [coId, daysAgo(89)]);
    const monthlyBurn = inr(Math.abs(outflows[0].s) / 3);
    const runwayMonths = monthlyBurn > 0 ? inr(available / monthlyBurn) : null;

    const reconScore = await recon.score(coId);
    const tally = await TallyConnector.health(coId);
    const trend = await Cash.cashTrend(coId, 30);
    const lastBankSync = await Cash.lastBankSync(coId);

    ok(res, {
      cash: { available, uncleared, accounts: accounts.length, runway_months: runwayMonths, monthly_burn: monthlyBurn, last_synced_at: lastBankSync },
      payments: { due_this_week: { count: due.length, amount: dueAmount }, overdue: { count: overdue.length, amount: overdueAmount } },
      gst: { itc: snap ? snap.total_itc : 0, liability: gstLiability, open_mismatches: mismatches, period: snap ? snap.period : null, fetched_at: snap ? snap.fetched_at : null },
      recon: { ...reconScore, as_of: lastBankSync },
      tally,
      trend,
      kpis: [
        { key: 'cash', label: 'Available cash', value: formatINR(available), sub: `+ ₹${formatINR(uncleared)} uncleared` },
        { key: 'due', label: 'Due this week', value: `${due.length} payments`, sub: formatINR(dueAmount), alert: dueAmount > 0 },
        { key: 'gst', label: 'GST liability', value: formatINR(gstLiability), sub: `${mismatches} mismatch${mismatches === 1 ? '' : 'es'} open`, alert: mismatches > 0 },
        { key: 'runway', label: 'Cash runway', value: runwayMonths != null ? `${runwayMonths} mo` : '—', sub: `burn ${formatINR(monthlyBurn)}/mo` },
        { key: 'recon', label: 'Recon accuracy', value: `${reconScore.accuracy}%`, sub: `${reconScore.auto_matched}/${reconScore.total} auto-matched`, alert: reconScore.accuracy < reconScore.target },
        { key: 'overdue', label: 'Overdue invoices', value: `${overdue.length}`, sub: formatINR(overdueAmount), alert: overdue.length > 0 },
      ],
    });
  });

  // ===================== AI ASSISTANT =====================
  r.get('/api/assistant/prompts', async (req, res) => {
    ok(res, { prompts: Assistant.PROMPTS, status: Assistant.intent_status() });
  });

  r.get('/api/assistant/suggestions', async (req, res, p, user) => {
    ok(res, await Assistant.buildSuggestions(companyOf(user), user.role));
  });

  r.post('/api/assistant/ask', async (req, res, p, user) => {
    const question = requireNonEmptyString(bodyOf(req).question, 'question');
    await audit(companyOf(user), user, 'assistant.ask', 'assistant', null, { question: question.slice(0, 200) });
    const answer = await Assistant.ask(user, question);
    ok(res, answer);
  });

  // ===================== ONBOARDING =====================
  r.get('/api/onboarding', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = await all('SELECT * FROM onboarding_steps WHERE company_id = ?', [coId]);
    const order = ['connect_bank', 'install_tally', 'email_routing', 'vendor_import'];
    const steps = rows.sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
    ok(res, steps);
  });

  r.post('/api/onboarding/:step/complete', async (req, res, p, user) => {
    const coId = companyOf(user);
    const existing = await get('SELECT * FROM onboarding_steps WHERE company_id = ? AND step = ?', [coId, p.step]);
    if (existing) await run(`UPDATE onboarding_steps SET status = 'done', detail = ?, at = ? WHERE company_id = ? AND step = ?`,
      [(req.body || {}).detail || existing.detail, nowIso(), coId, p.step]);
    else await insert('onboarding_steps', { company_id: coId, step: p.step, status: 'done', detail: (req.body || {}).detail || null, at: nowIso() });
    ok(res, { step: p.step, status: 'done' });
  });

  // ===================== SETTINGS & METRICS =====================
  r.get('/api/settings', async (req, res, p, user) => {
    ok(res, await Company.getSettings(companyOf(user)));
  });

  r.put('/api/settings', async (req, res, p, user) => {
    requireRole(user, ['cfo']);
    const coId = companyOf(user);
    const next = await Company.saveSettings(coId, bodyOf(req));
    await audit(coId, user, 'settings.updated', 'company', coId, next);
    ok(res, next);
  });

  r.get('/api/metrics', async (req, res, p, user) => {
    const coId = companyOf(user);
    const score = await recon.score(coId);
    const completedPayments = await all(`SELECT * FROM payments WHERE company_id = ? AND status = 'completed' AND processed_at IS NOT NULL ORDER BY processed_at DESC LIMIT 30`, [coId]);
    // engine-agnostic: first invoice id per payment -> received date
    const firstInvIds = completedPayments.map((p) => { try { return JSON.parse(p.invoice_ids || '[]')[0] || null; } catch { return null; } }).filter(Boolean);
    let invDateMap = {};
    if (firstInvIds.length) {
      invDateMap = Object.fromEntries((await all(`SELECT id, invoice_date FROM invoices WHERE id IN (${firstInvIds.map(() => '?').join(',')})`, firstInvIds)).map((i) => [i.id, i.invoice_date]));
    }
    const completed = completedPayments.map((p) => {
      let firstId = null;
      try { firstId = JSON.parse(p.invoice_ids || '[]')[0]; } catch { /* ignore */ }
      return { ...p, invoice_date: invDateMap[firstId] || p.initiated_at.slice(0, 10) };
    });
    const cycleDays = completed.length ? inr(completed.reduce((s, p) => {
      const received = p.invoice_date || p.initiated_at.slice(0, 10);
      const processed = p.processed_at.slice(0, 10);
      return s + Math.max(0, Math.round((new Date(processed) - new Date(received)) / 86400000));
    }, 0) / completed.length) : null;
    const baseline = 11.2;
    const improvement = cycleDays != null ? inr(((baseline - cycleDays) / baseline) * 100) : null;
    const today = todayStr();
    const usage = await get('SELECT * FROM usage_daily WHERE company_id = ? AND date = ?', [coId, today]);
    const dau = usage ? usage.dau : 0;
    const tally = await TallyConnector.health(coId);
    ok(res, {
      customers: { paying: 12, pipeline: 21, target: 100, acv_inr: 300000, retention_6m: 92 },
      banks: { connected: 17, target: 15 },
      tally_uptime: tally.uptime_30d, target_uptime: 99.5,
      recon: { accuracy: score.accuracy, target: 70 },
      cycle: { avg_days: cycleDays, baseline_days: baseline, improvement_pct: improvement, target_pct: 50 },
      engagement: { dau, mau: 3, daumau_pct: inr((dau / 3) * 100), target_pct: 60 },
    });
  });

  // ===================== SYSTEM HEALTH =====================
  r.get('/api/system/health', async (req, res, p, user) => {
    const coId = companyOf(user);
    const startedAt = process.env.KHATAOS_STARTED_AT || new Date(Date.now() - process.uptime() * 1000).toISOString();
    const tables = await dbModule.listTables();
    const rowCounts = {};
    const countTargets = ['companies', 'users', 'bank_accounts', 'bank_transactions', 'invoices', 'payments', 'recon_matches', 'gstr2b_snapshots', 'gst_mismatches', 'tally_sync_logs', 'jobs', 'vendors', 'approvals', 'cash_daily'];
    for (const t of tables) {
      if (countTargets.includes(t)) rowCounts[t] = await dbModule.countRows(t);
    }
    const queue = await get(`SELECT
        COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END),0) AS pending,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),0) AS failed,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END),0) AS processed
      FROM jobs`);
    const decentro = Decentro.config();
    const tally = await TallyConnector.health(coId);
    const gstSnap = await get('SELECT period, fetched_at FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
    const bankAccounts = (await all('SELECT source, COUNT(*) AS c FROM bank_accounts WHERE company_id = ? GROUP BY source', [coId])).map((r) => ({ source: r.source, count: r.c }));
    ok(res, {
      app: { name: 'KhataOS', version: '0.1.0 (MVP)', started_at: startedAt, uptime_seconds: Math.round(process.uptime()), node: process.version },
      database: {
        engine: dbModule.DB_ENGINE,
        location: dbModule.DB_ENGINE === 'postgres' ? 'KHATAOS_DATABASE_URL (AWS Mumbai in production)' : dbModule.DB_PATH,
        tables: tables.length,
        row_counts: rowCounts,
      },
      queue,
      integrations: {
        bank_accounts: bankAccounts,
        banks_supported: (await all('SELECT COUNT(*) AS c FROM banks'))[0].c,
        decentro,
        tally: { status: tally.status, version: tally.version, uptime_30d: tally.uptime_30d, last_sync_at: tally.last_sync_at },
        gstn: { ...Gstn.config(), last_gstr2b: gstSnap || null },
        ai: Assistant.intent_status(),
      },
    });
  });
}

module.exports = { register };
