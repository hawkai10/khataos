'use strict';

// Admin & platform domain (Fastify plugin): auth, users/audit, the finance
// dashboard, AI assistant, onboarding, settings, metrics and system health.

const { all, get, insert, run, update } = require('../db');
const dbModule = require('../db');
const { nowIso, todayStr, round2, formatINR } = require('../util');
const { ApiError, login, logout, tokenFrom, requireRole, audit, recentAudit, publicUser, sessionCookie, clearSessionCookie } = require('../auth');
const { TallyConnector } = require('../adapters');
const Decentro = require('../decentro');
const Gstn = require('../gstn');
const recon = require('../recon');
const Assistant = require('../ai');
const Cash = require('../services/cash');
const Company = require('../services/company');
const Gst = require('../services/gst');
const Invoices = require('../services/invoices');
const { bodyOf, requireNonEmptyString } = require('./validators');
const { companyOf, rupees, publicizeRows } = require('./helpers');

async function register(fastify) {
  // ===================== AUTH =====================
  fastify.post('/api/auth/login', async (request, reply) => {
    const { email, password } = bodyOf(request);
    if (!email || !password) throw new ApiError(400, 'email and password required');
    const data = await login(email, password);
    reply.header('Set-Cookie', sessionCookie(data.token));
    reply.ok(data);
  });

  fastify.post('/api/auth/logout', async (request, reply) => {
    const token = tokenFrom(request);
    if (token) await logout(token);
    reply.header('Set-Cookie', clearSessionCookie());
    reply.ok({ loggedOut: true });
  });

  fastify.get('/api/me', async (request, reply) => {
    reply.ok(publicUser(request.user));
  });

  fastify.get('/api/users', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo']);
    reply.ok(await all('SELECT id, name, email, role, department, last_login_at FROM users WHERE company_id = ? ORDER BY role', [companyOf(user)]));
  });

  fastify.get('/api/audit', async (request, reply) => {
    reply.ok(await recentAudit(companyOf(request.user), 100));
  });

  // ===================== DASHBOARD =====================
  fastify.get('/api/dashboard', async (request, reply) => {
    const coId = companyOf(request.user);
    const rw = await Cash.runway(coId);
    const available = rw.available;
    const accounts = rw.accounts;
    const monthlyBurn = rw.monthly_burn;
    const runwayMonths = rw.runway_months;
    const uncleared = await Cash.totalUncleared(coId);
    const { rows: due, overdue, due_amount: dueAmount, overdue_amount: overdueAmount } = await Invoices.dueAndOverdue(coId);
    const g = await Gst.position(coId);
    const gstLiability = g.liability;
    const mismatches = g.mismatches.length;

    const reconScore = await recon.score(coId);
    const tally = await TallyConnector.health(coId);
    const trend = await Cash.cashTrend(coId, 30);
    const lastBankSync = await Cash.lastBankSync(coId);

    reply.ok({
      cash: { available: rupees(available), uncleared: rupees(uncleared), accounts, runway_months: runwayMonths, monthly_burn: rupees(monthlyBurn), last_synced_at: lastBankSync },
      payments: { due_this_week: { count: due.length, amount: rupees(dueAmount) }, overdue: { count: overdue.length, amount: rupees(overdueAmount) } },
      gst: { itc: rupees(g.itc), liability: rupees(gstLiability), open_mismatches: mismatches, period: g.period, fetched_at: g.fetched_at },
      recon: { ...reconScore, as_of: lastBankSync },
      tally,
      trend: publicizeRows(trend, 'cash_daily'),
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
  fastify.get('/api/assistant/prompts', async (request, reply) => {
    reply.ok({ prompts: Assistant.PROMPTS, status: Assistant.intent_status() });
  });

  fastify.get('/api/assistant/suggestions', async (request, reply) => {
    const user = request.user;
    reply.ok(await Assistant.buildSuggestions(companyOf(user), user.role));
  });

  fastify.post('/api/assistant/ask', async (request, reply) => {
    const user = request.user;
    const question = requireNonEmptyString(bodyOf(request).question, 'question');
    await audit(companyOf(user), user, 'assistant.ask', 'assistant', null, { question: question.slice(0, 200) });
    reply.ok(await Assistant.ask(user, question));
  });

  // ===================== ONBOARDING =====================
  fastify.get('/api/onboarding', async (request, reply) => {
    const coId = companyOf(request.user);
    const rows = await all('SELECT * FROM onboarding_steps WHERE company_id = ?', [coId]);
    const order = ['connect_bank', 'install_tally', 'email_routing', 'vendor_import'];
    const steps = rows.sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
    reply.ok(steps);
  });

  fastify.post('/api/onboarding/:step/complete', async (request, reply) => {
    const coId = companyOf(request.user);
    const step = request.params.step;
    const existing = await get('SELECT * FROM onboarding_steps WHERE company_id = ? AND step = ?', [coId, step]);
    if (existing) await run(`UPDATE onboarding_steps SET status = 'done', detail = ?, at = ? WHERE company_id = ? AND step = ?`,
      [(request.body || {}).detail || existing.detail, nowIso(), coId, step]);
    else await insert('onboarding_steps', { company_id: coId, step, status: 'done', detail: (request.body || {}).detail || null, at: nowIso() });
    reply.ok({ step, status: 'done' });
  });

  // ===================== SETTINGS & METRICS =====================
  fastify.get('/api/settings', async (request, reply) => {
    reply.ok(await Company.getSettings(companyOf(request.user)));
  });

  fastify.put('/api/settings', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo']);
    const coId = companyOf(user);
    const next = await Company.saveSettings(coId, bodyOf(request));
    await audit(coId, user, 'settings.updated', 'company', coId, next);
    reply.ok(next);
  });

  fastify.get('/api/metrics', async (request, reply) => {
    const coId = companyOf(request.user);
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
    const cycleDays = completed.length ? round2(completed.reduce((s, p) => {
      const received = p.invoice_date || p.initiated_at.slice(0, 10);
      const processed = p.processed_at.slice(0, 10);
      return s + Math.max(0, Math.round((new Date(processed) - new Date(received)) / 86400000));
    }, 0) / completed.length) : null;
    // Real engagement: distinct users with a login session today / in the last
    // 30 days — computed from the sessions table, never a hardcoded figure.
    const since = (ms) => new Date(Date.now() - ms).toISOString();
    const dauRow = await get(`SELECT COUNT(DISTINCT s.user_id) AS c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.company_id = ? AND s.created_at >= ?`, [coId, todayStr() + 'T00:00:00.000Z']);
    const mauRow = await get(`SELECT COUNT(DISTINCT s.user_id) AS c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.company_id = ? AND s.created_at >= ?`, [coId, since(30 * 24 * 3600 * 1000)]);
    const dau = Number(dauRow ? dauRow.c : 0);
    const mau = Number(mauRow ? mauRow.c : 0);
    const daumau = mau > 0 ? round2((dau / mau) * 100) : null;
    const banksConnected = (await get('SELECT COUNT(*) AS c FROM bank_accounts WHERE company_id = ? AND status = ?', [coId, 'active'])).c;
    const tally = await TallyConnector.health(coId);
    reply.ok({
      // Commercial metrics need a sales/CRM source this build does not have —
      // surface that explicitly instead of showing invented pipeline numbers.
      customers: { status: 'unavailable', detail: 'customer and subscription data is not collected by this build' },
      banks: { connected: Number(banksConnected), target: 15 },
      // No live Tally connection -> no observed uptime; null means "not
      // computed", and the UI renders it as unavailable.
      tally_uptime: tally.uptime_30d != null ? Number(tally.uptime_30d) : null, target_uptime: 99.5,
      recon: { accuracy: score.accuracy, target: 70 },
      // Cycle time is real; the "improvement vs a manual baseline" comparison
      // was invented (11.2 days) and is removed.
      cycle: { avg_days: cycleDays },
      engagement: { dau, mau, daumau_pct: daumau, target_pct: 60 },
    });
  });

  // ===================== SYSTEM HEALTH =====================
  fastify.get('/api/system/health', async (request, reply) => {
    const coId = companyOf(request.user);
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
    reply.ok({
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
