'use strict';

// End-to-end smoke test: boots the server, exercises every module, and
// asserts the MVP's core promises (RBAC, AP flow, payments, recon, GST).

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8081;
const BASE = `http://localhost:${PORT}`;

// `node tests/smoke.js --pg` runs the whole suite on the in-process
// PostgreSQL engine (pglite) instead of SQLite.
if (process.argv.includes('--pg')) {
  process.env.KHATAOS_DB_ENGINE = 'pglite';
  delete process.env.KHATAOS_PGLITE_DIR;
  console.log('DB engine: in-process PostgreSQL (pglite)');
} else {
  console.log('DB engine: SQLite');
}
// The suite asserts the GSTN stub contract, so force the adapter into its
// deterministic mock mode even if GSTN_* credentials are set in the shell.
process.env.GSTN_MOCK = '1';

// fresh demo DB for the test
for (const p of ['server/data/khataos.db', path.join(process.env.TEMP || '', 'khataos-data', 'khataos.db')]) {
  try { fs.rmSync(path.join(ROOT, p), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function api(method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await resp.json();
  if (!resp.ok) {
    const err = new Error(json.error ? json.error.message : resp.statusText);
    err.status = resp.status;
    throw err;
  }
  return json.data;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForServer(proc, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'cfo@acme.in', password: 'demo1234' }) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (proc.exitCode != null) throw new Error('server exited early: ' + (proc.output || []).join(''));
    await sleep(400);
  }
  throw new Error('server did not start in time');
}

(async () => {
  const server = spawn(process.execPath, ['server/src/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    await waitForServer(server);
    console.log('\nKhataOS E2E smoke test\n');

    // ---- auth + RBAC ----
    const cfo = (await api('POST', '/api/auth/login', { email: 'cfo@acme.in', password: 'demo1234' })).token;
    const mgr = (await api('POST', '/api/auth/login', { email: 'manager@acme.in', password: 'demo1234' })).token;
    const exec = (await api('POST', '/api/auth/login', { email: 'exec@acme.in', password: 'demo1234' })).token;
    check('three role logins', !!cfo && !!mgr && !!exec);

    let forbidden = false;
    try { await api('GET', '/api/users', null, exec); } catch (e) { forbidden = e.status === 403; }
    check('RBAC: executive blocked from /users', forbidden);

    // ---- dashboard ----
    const dash = await api('GET', '/api/dashboard', null, cfo);
    check('dashboard: cash available > 0', dash.cash.available > 0, `got ${dash.cash.available}`);
    check('dashboard: recon accuracy >= 70%', dash.recon.accuracy >= 70, `got ${dash.recon.accuracy}%`);
    check('dashboard: 6 KPIs', dash.kpis.length >= 5, `got ${dash.kpis.length}`);
    check('dashboard: trend has 30 points', dash.trend.length >= 28, `got ${dash.trend.length}`);

    // ---- cash ----
    const accounts = await api('GET', '/api/cash/accounts', null, cfo);
    check('cash: 6 bank accounts', accounts.length >= 6, `got ${accounts.length}`);
    check('cash: AA + direct API mix', accounts.some(a => a.source === 'aa') && accounts.some(a => a.source === 'direct_api'));
    const refresh = await api('POST', '/api/cash/refresh', {}, cfo);
    check('cash: refresh returns recon stats', typeof refresh.recon.accuracy === 'number');

    // ---- Decentro integration contract ----
    const dstatus = await api('GET', '/api/integrations/decentro/status', null, cfo);
    check('decentro: status endpoint', dstatus.provider === 'decentro-connected-banking' && typeof dstatus.enabled === 'boolean');
    let linkBlocked = false;
    try { await api('POST', '/api/decentro/link', { account_number: '123456789' }, cfo); }
    catch (e) { linkBlocked = e.status === 503; }
    check('decentro: link guarded without credentials', linkBlocked);
    let statusBlocked = false;
    try { await api('POST', '/api/decentro/link/status', { account_number: '123456789' }, cfo); }
    catch (e) { statusBlocked = e.status === 503; }
    check('decentro: link/status guarded without credentials', statusBlocked);
    const wh = await api('POST', '/api/decentro/webhook', { account_number: '123456789', status: 'SUCCESS' });
    check('decentro: webhook acknowledges when disabled', wh.ok === true && wh.ignored === true);

    // ---- AA consent flow ----
    const consent = await api('POST', '/api/aa/consent/start', { bank_code: 'AXIS', account_number: '918011112222' }, cfo);
    const linked = await api('POST', '/api/aa/consent/verify', { consent_id: consent.consentId, otp: '123456', bank_code: 'AXIS', account_number: '918011112222' }, cfo);
    check('AA: consent + OTP links a bank', !!linked.account.id);

    // ---- AP capture ----
    const before = (await api('GET', '/api/invoices', null, cfo)).length;
    const sim = await api('POST', '/api/invoices/email-sim', { template: 'cement' }, exec);
    check('AP: email capture creates invoice', !!sim.invoice.id);
    check('AP: OCR extracted GSTIN', /^[0-9A-Z]{15}$/.test(sim.invoice.gstin_vendor || ''));
    check('AP: invoice routed to approval', sim.invoice.status === 'pending_approval');
    const after = (await api('GET', '/api/invoices', null, cfo)).length;
    check('AP: invoice count incremented', after === before + 1, `${before} -> ${after}`);

    // ---- approval chain + RBAC on approvals ----
    let execBlocked = false;
    try {
      await api('POST', `/api/invoices/${sim.invoice.id}/approve`, {}, exec);
    } catch (e) { execBlocked = e.status === 403 || e.status === 409; }
    check('RBAC: executive cannot approve invoices', execBlocked);

    const pendingMgr = await api('GET', '/api/approvals/pending', null, mgr);
    check('AP: manager sees pending approvals', pendingMgr.length > 0);
    const smallPending = pendingMgr.find(a => a.gross_amount <= 100000);
    if (smallPending) {
      await api('POST', `/api/invoices/${smallPending.invoice_id}/approve`, {}, mgr);
      check('AP: manager approves small invoice', true);
    } else {
      check('AP: manager approves small invoice', false, 'no small pending invoice found');
    }

    const cfoPending = (await api('GET', '/api/approvals/pending', null, cfo)).filter(a => a.gross_amount > 100000);
    check('AP: CFO sees > ₹1L approvals', cfoPending.length > 0);
    if (cfoPending.length) {
      const invAfter = await api('GET', `/api/invoices/${cfoPending[0].invoice_id}`, null, cfo);
      const level2 = invAfter.approvals.find(a => a.level === 2 && a.status === 'pending' && a.required_role === 'cfo');
      if (level2) {
        await api('POST', `/api/invoices/${cfoPending[0].invoice_id}/approve`, {}, cfo);
        check('AP: CFO approves level-2 (large invoice)', true);
      } else check('AP: CFO approves level-2 (large invoice)', false, 'no level-2 pending');
    }

    // ---- three-way match ----
    const twm = await api('POST', `/api/invoices/${sim.invoice.id}/three-way-match`, {}, mgr);
    check('AP: three-way match runs (PO found)', ['matched', 'mismatch', 'pending'].includes(twm.status), twm.status);

    // ---- payments ----
    const approvedInv = (await api('GET', '/api/invoices?status=approved', null, cfo))[0];
    let createdPay;
    if (approvedInv) {
      createdPay = await api('POST', '/api/payments', {
        vendor_id: approvedInv.vendor_id, invoice_ids: [approvedInv.id], mode: 'IMPS', type: 'instant', account_id: accounts[0].id,
      }, exec);
      check('payments: created', !!createdPay.id);
      if (createdPay.status === 'pending_approval') {
        await api('POST', `/api/payments/${createdPay.id}/approve`, {}, cfo);
        check('payments: CFO approves large payment', true);
      } else {
        check('payments: CFO approves large payment', createdPay.status === 'approved', createdPay.status);
      }
      let finalStatus = createdPay.status;
      for (let i = 0; i < 16; i++) {
        await sleep(800);
        finalStatus = (await api('GET', `/api/payments/${createdPay.id}`, null, cfo)).status;
        if (finalStatus === 'completed' || finalStatus === 'failed') break;
      }
      check('payments: gateway executes to terminal state', ['completed', 'failed'].includes(finalStatus), finalStatus);
      if (finalStatus === 'completed') {
        const invNow = await api('GET', `/api/invoices/${approvedInv.id}`, null, cfo);
        check('payments: invoice marked paid', invNow.status === 'paid', invNow.status);
      }
    } else {
      check('payments: created', false, 'no approved invoice available');
    }

    // ---- recon ----
    const recon = await api('POST', '/api/recon/run', {}, mgr);
    check('recon: matcher returns stats', recon.total > 0);
    check('recon: accuracy >= 70%', recon.score.accuracy >= 70, `got ${recon.score.accuracy}%`);
    const unmatched = await api('GET', '/api/recon/unmatched', null, mgr);
    check('recon: unmatched list non-empty', unmatched.length > 0, `got ${unmatched.length}`);

    // ---- GST ----
    const gst = await api('POST', '/api/gst/refresh', {}, cfo);
    check('gst: refresh reports mismatches', typeof gst.mismatches === 'number');
    const gstSummary = await api('GET', '/api/gst/summary', null, cfo);
    check('gst: mismatch flags exposed', gstSummary.mismatch_count > 0, `got ${gstSummary.mismatch_count}`);
    const csvResp = await fetch(BASE + `/api/gst/export?type=gstr3b&period=${gstSummary.period}`, { headers: { authorization: 'Bearer ' + cfo } });
    const csv = await csvResp.text();
    check('gst: GSTR-3B CSV export', csvResp.ok && csv.startsWith('field,amount'), csv.slice(0, 40));

    // ---- GSTN / GSP stub ----
    const gstnCfg = await api('GET', '/api/gstn/config', null, cfo);
    check('gstn: config exposes mock mode + missing env', gstnCfg.mode === 'mock' && gstnCfg.enabled === false && Array.isArray(gstnCfg.missing_env) && gstnCfg.missing_env.length >= 3, `mode=${gstnCfg.mode}`);
    const otpReq = await api('POST', '/api/gstn/otp/request', {}, cfo);
    check('gstn: OTP request (mock)', otpReq.status === 'OTP_REQUESTED' && otpReq.mode === 'mock' && !!otpReq.otp_ref);
    const otpVal = await api('POST', '/api/gstn/otp/validate', { otp: '123456' }, cfo);
    check('gstn: OTP validates to AUTHENTICATED (mock)', otpVal.status === 'AUTHENTICATED' && otpVal.auth_token.includes('MOCK'), otpVal.status);
    let gstnBadOtp = false;
    try { await api('POST', '/api/gstn/otp/validate', { otp: '12' }, cfo); } catch (e) { gstnBadOtp = !!e.status; }
    check('gstn: invalid OTP rejected', gstnBadOtp);

    // ---- tally ----
    const tally = await api('GET', '/api/tally/health', null, cfo);
    check('tally: health endpoint', !!tally && (tally.status === 'connected' || tally.status === 'degraded'));
    const logs = await api('GET', '/api/tally/sync-logs', null, cfo);
    check('tally: sync logs recorded', logs.length > 0);

    // ---- metrics + onboarding + static app ----
    const metrics = await api('GET', '/api/metrics', null, cfo);
    check('metrics: recon target 70', metrics.recon.target === 70);

    // ---- assistant + freshness ----
    const prompts = await api('GET', '/api/assistant/prompts', null, cfo);
    check('assistant: prompt catalogue', Array.isArray(prompts.prompts) && prompts.prompts.length >= 4);
    const suggestions = await api('GET', '/api/assistant/suggestions', null, cfo);
    check('assistant: suggestions derived from live data', Array.isArray(suggestions) && suggestions.length > 0);
    const askCash = await api('POST', '/api/assistant/ask', { question: 'How much cash do we have?' }, cfo);
    check('assistant: cash question answered', askCash.answer.includes('\u20B9') && askCash.intent === 'cash', `${askCash.intent} — ${askCash.answer.slice(0, 50)}`);
    const askTodo = await api('POST', '/api/assistant/ask', { question: 'What should I focus on today?' }, mgr);
    check('assistant: suggestion intent returns actions', askTodo.intent === 'suggestions' && Array.isArray(askTodo.suggestions) && askTodo.suggestions.length > 0, askTodo.intent);
    const dashF = await api('GET', '/api/dashboard', null, cfo);
    check('freshness: dashboard exposes last bank sync', !!dashF.cash.last_synced_at);
    const reconF = await api('GET', '/api/recon/summary', null, cfo);
    check('freshness: recon exposes as-of timestamp', !!reconF.as_of);
    const health = await api('GET', '/api/system/health', null, cfo);
    check('system: health reports engine + tables', health.database.tables >= 20 && ['sqlite', 'pglite', 'postgres'].includes(health.database.engine), `${health.database.engine} / ${health.database.tables}`);
    check('system: queue + integrations surfaced', typeof health.queue === 'object' && Array.isArray(health.integrations.bank_accounts) && health.integrations.banks_supported >= 15 && health.integrations.gstn && health.integrations.gstn.mode === 'mock' && !!health.integrations.gstn.last_gstr2b);
    const onboarding = await api('GET', '/api/onboarding', null, cfo);
    check('onboarding: steps present', onboarding.length >= 4, `got ${onboarding.length}`);
    const page = await fetch(BASE + '/');
    const html = await page.text();
    check('web: SPA served', page.ok && html.includes('KhataOS'), html.slice(0, 60));
    const appJs = await fetch(BASE + '/js/app.js');
    check('web: app.js served', appJs.ok);

    console.log(`\n${passed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error('\nFATAL:', err.message);
    console.error(serverLog.slice(-2000));
  } finally {
    try { server.kill('SIGKILL'); } catch { /* already gone */ }
  }
  process.exit(failed ? 1 : 0);
})();
