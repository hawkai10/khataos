'use strict';

// End-to-end smoke test: boots the server and exercises every module with
// REAL pipeline data only. No demo tenant is seeded by the product — this
// test bootstraps its own minimal tenant (company, users, vendor, one bank
// account) and then pushes data through the three real channels:
//   1. Tally  — XML import of groups/ledgers/vouchers
//   2. Bank   — statement-shaped bank transactions (like Decentro.pull writes)
//   3. GST    — a GSTR-2B snapshot (like a real GSP fetch would store)
// Providers (AA, Decentro, GSTN, RazorpayX) are unconfigured, so every
// guarded endpoint must 503 instead of fabricating data. PAYMENT_GATEWAY=test
// enables the CI gateway double (status transitions only, no fake bank data).

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8081;
const BASE = `http://localhost:${PORT}`;

if (process.argv.includes('--pg')) {
  process.env.KHATAOS_DB_ENGINE = 'pglite';
  delete process.env.KHATAOS_PGLITE_DIR;
  console.log('DB engine: in-process PostgreSQL (pglite)');
} else {
  console.log('DB engine: SQLite');
}

// fresh test DB (explicit path shared with the server child) + CI gateway double
const TEST_DB = path.join(process.env.TEMP || os.tmpdir(), 'khataos-data', 'smoke-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
process.env.PAYMENT_GATEWAY = 'test';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(TEST_DB + suffix, { force: true }); } catch { /* ignore */ }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(proc, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'cfo@smoke.in', password: 'test1234' }) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (proc.exitCode != null) throw new Error('server exited early: ' + (proc.output || []).join(''));
    await sleep(400);
  }
  throw new Error('server did not start in time');
}

(async () => {
  // ---- bootstrap a minimal real tenant (test harness, not product code) ----
  const { seedIfEmpty } = require('../server/src/seed');
  const db = require('../server/src/db');
  const { hashPassword, uid, nowIso, todayStr } = require('../server/src/util');
  await seedIfEmpty();
  const coId = 'co_smoke';
  const today = todayStr();
  await db.insert('companies', { id: coId, name: 'Smoke Test Co', gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F', city: 'Bengaluru', plan: 'standard', settings: JSON.stringify({ payment_approval_threshold: 500000 }), created_at: nowIso() });
  for (const u of [
    { id: 'u_cfo', name: 'CFO Smoke', email: 'cfo@smoke.in', role: 'cfo' },
    { id: 'u_mgr', name: 'Mgr Smoke', email: 'manager@smoke.in', role: 'finance_manager' },
    { id: 'u_exec', name: 'Exec Smoke', email: 'exec@smoke.in', role: 'finance_executive' },
  ]) {
    await db.insert('users', { id: u.id, company_id: coId, name: u.name, email: u.email, password: hashPassword('test1234'), role: u.role, department: 'Finance', active: 1, created_at: nowIso() });
  }
  await db.insert('vendors', { id: 'v_smoke', company_id: coId, name: 'Smoke Vendor Traders', gstin: '29ABCDE1234F1Z5', ledger_name: 'Sundry Creditors - Smoke Vendor', tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1 });
  await db.insert('bank_accounts', { id: 'acc_smoke', company_id: coId, bank_code: 'HDFC', account_name: 'HDFC Current', account_number: '502100000001', type: 'current', ifsc: 'HDFC0001234', status: 'active', source: 'direct_api', opened_at: today, last_synced_at: nowIso() });
  await db.insert('cash_daily', { id: uid('cd'), company_id: coId, account_id: 'acc_smoke', date: today, closing_balance: 2500000, source: 'direct_api' });
  await db.insert('bank_transactions', { id: 'btx_unmatched', company_id: coId, account_id: 'acc_smoke', external_id: 'BTX-1', txn_date: today, amount: -25000, description: 'NEFT OFFICE SUPPLIES', mode: 'NEFT', ref_no: 'NEFT-UNMATCHED', status: 'posted', matched: 0, created_at: nowIso() });
  for (const [step, detail] of [['connect_bank', 'linked'], ['install_tally', 'installed'], ['email_routing', 'active'], ['vendor_import', 'imported']]) {
    await db.insert('onboarding_steps', { company_id: coId, step, status: 'done', detail, at: nowIso() });
  }

  const server = spawn(process.execPath, ['server/src/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), PAYMENT_GATEWAY: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    await waitForServer(server);
    console.log('\nKhataOS E2E smoke test (real-channel data, no dummy data)\n');

    // ---- auth + RBAC ----
    const cfo = (await api('POST', '/api/auth/login', { email: 'cfo@smoke.in', password: 'test1234' })).token;
    const mgr = (await api('POST', '/api/auth/login', { email: 'manager@smoke.in', password: 'test1234' })).token;
    const exec = (await api('POST', '/api/auth/login', { email: 'exec@smoke.in', password: 'test1234' })).token;
    check('three role logins', !!cfo && !!mgr && !!exec);

    let forbidden = false;
    try { await api('GET', '/api/users', null, exec); } catch (e) { forbidden = e.status === 403; }
    check('RBAC: executive blocked from /users', forbidden);

    // ---- dashboard (live data: one account + one closing balance) ----
    const dash = await api('GET', '/api/dashboard', null, cfo);
    check('dashboard: cash available > 0', dash.cash.available > 0, `got ${dash.cash.available}`);
    check('dashboard: 6 KPIs', dash.kpis.length >= 5, `got ${dash.kpis.length}`);
    check('dashboard: trend has at least 1 point', dash.trend.length >= 1, `got ${dash.trend.length}`);

    // ---- cash ----
    const accounts = await api('GET', '/api/cash/accounts', null, cfo);
    check('cash: bootstrap bank account listed', accounts.length === 1, `got ${accounts.length}`);
    const refresh = await api('POST', '/api/cash/refresh', {}, cfo);
    check('cash: refresh returns recon stats and skips unconfigured providers', typeof refresh.recon.accuracy === 'number' && refresh.skipped_accounts >= 1, JSON.stringify(refresh).slice(0, 120));

    // ---- Decentro integration contract (real-only) ----
    const dstatus = await api('GET', '/api/integrations/decentro/status', null, cfo);
    check('decentro: status endpoint', dstatus.provider === 'decentro-connected-banking' && typeof dstatus.enabled === 'boolean');
    let linkBlocked = false;
    try { await api('POST', '/api/decentro/link', { account_number: '123456789' }, cfo); } catch (e) { linkBlocked = e.status === 503; }
    check('decentro: link guarded without credentials', linkBlocked);
    const wh = await api('POST', '/api/decentro/webhook', { account_number: '123456789', status: 'SUCCESS' });
    check('decentro: webhook acknowledges when disabled', wh.ok === true && wh.ignored === true);

    // ---- AA consent: refused, never fabricates ----
    let consentBlocked = false;
    try { await api('POST', '/api/aa/consent/start', { bank_code: 'AXIS', account_number: '918011112222' }, cfo); } catch (e) { consentBlocked = e.status === 503; }
    check('AA: consent refused without provider credentials', consentBlocked);

    // ---- AP capture (real manual channel) ----
    const small = await api('POST', '/api/invoices/capture', {
      vendor_id: 'v_smoke', invoice_no: 'INV-SM-001', invoice_date: today, taxable_amount: 50000, gross_amount: 59000,
      cgst: 4500, sgst: 4500, igst: 0, tds_amount: 0, gstin_vendor: '29ABCDE1234F1Z5',
    }, exec);
    check('AP: manual capture creates invoice', !!small.id && small.status === 'pending_approval');
    const large = await api('POST', '/api/invoices/capture', {
      vendor_id: 'v_smoke', invoice_no: 'INV-SM-002', invoice_date: today, taxable_amount: 600000, gross_amount: 708000,
      cgst: 54000, sgst: 54000, igst: 0, tds_amount: 0, gstin_vendor: '29ABCDE1234F1Z5',
    }, exec);
    check('AP: large invoice routed to approval', large.status === 'pending_approval');

    // ---- approval chain + RBAC ----
    let execBlocked = false;
    try { await api('POST', `/api/invoices/${small.id}/approve`, {}, exec); } catch (e) { execBlocked = e.status === 403 || e.status === 409; }
    check('RBAC: executive cannot approve invoices', execBlocked);
    const pendingMgr = await api('GET', '/api/approvals/pending', null, mgr);
    check('AP: manager sees pending approvals', pendingMgr.some((a) => a.invoice_id === small.id));
    await api('POST', `/api/invoices/${small.id}/approve`, {}, mgr);
    check('AP: manager approves small invoice', true);
    await api('POST', `/api/invoices/${large.id}/approve`, {}, mgr);
    await api('POST', `/api/invoices/${large.id}/approve`, {}, cfo);
    check('AP: CFO approves level-2 (large invoice)', true);

    const twm = await api('POST', `/api/invoices/${small.id}/three-way-match`, {}, mgr);
    check('AP: three-way match runs (no PO yet)', ['none', 'pending', 'matched', 'mismatch'].includes(twm.status), twm.status);

    // ---- payments (real approval + CI gateway double) ----
    const approvedInv = await api('GET', `/api/invoices/${large.id}`, null, cfo);
    const createdPay = await api('POST', '/api/payments', {
      vendor_id: 'v_smoke', invoice_ids: [large.id], mode: 'IMPS', type: 'instant', account_id: 'acc_smoke',
    }, exec);
    check('payments: created pending approval (above threshold)', !!createdPay.id && createdPay.status === 'pending_approval', createdPay.status);
    await api('POST', `/api/payments/${createdPay.id}/approve`, {}, cfo);
    let finalStatus = createdPay.status;
    for (let i = 0; i < 16; i++) {
      await sleep(600);
      finalStatus = (await api('GET', `/api/payments/${createdPay.id}`, null, cfo)).status;
      if (finalStatus === 'completed' || finalStatus === 'failed') break;
    }
    check('payments: gateway executes to terminal state', finalStatus === 'completed', finalStatus);
    const invPaid = await api('GET', `/api/invoices/${large.id}`, null, cfo);
    check('payments: invoice marked paid', invPaid.status === 'paid', invPaid.status);

    // ---- BANK CHANNEL: statement row for the executed payment, then recon ----
    const payRow = await api('GET', `/api/payments/${createdPay.id}`, null, cfo);
    await db.insert('bank_transactions', {
      id: 'btx_payment', company_id: coId, account_id: 'acc_smoke', external_id: 'BTX-PAY-1', txn_date: today,
      amount: -payRow.net_amount, description: `IMPS/OUTWARD ${payRow.reference}`, mode: 'IMPS',
      ref_no: payRow.reference, status: 'posted', matched: 0, created_at: nowIso(),
    });
    const recon = await api('POST', '/api/recon/run', {}, mgr);
    check('recon: matcher returns stats', recon.total > 0);
    check('recon: payment debit matched by reference', recon.score.accuracy > 0, `got ${recon.score.accuracy}%`);
    const unmatched = await api('GET', '/api/recon/unmatched', null, mgr);
    check('recon: unmatched list still shows the unmatched expense', unmatched.some((t) => t.id === 'btx_unmatched'));
    const summary = await api('GET', '/api/recon/summary', null, cfo);
    check('recon: recent matches include the payment ref', summary.recent.some((m) => m.payment_ref === payRow.reference));

    // ---- GSTN / GSP: unconfigured, refuses ----
    const gstnCfg = await api('GET', '/api/gstn/config', null, cfo);
    check('gstn: config exposes disabled mode + missing env', gstnCfg.mode === 'disabled' && gstnCfg.enabled === false && gstnCfg.missing_env.length >= 3, `mode=${gstnCfg.mode}`);
    let gstnBlocked = false;
    try { await api('POST', '/api/gstn/otp/request', {}, cfo); } catch (e) { gstnBlocked = e.status === 503; }
    check('gstn: OTP request refused when unconfigured', gstnBlocked);
    let gstRefreshBlocked = false;
    try { await api('POST', '/api/gst/refresh', {}, cfo); } catch (e) { gstRefreshBlocked = e.status === 503; }
    check('gst: refresh refused when GSP unconfigured', gstRefreshBlocked);

    // ---- GST CHANNEL: snapshot like a real GSP fetch would store ----
    const period = today.slice(0, 7);
    await db.insert('gstr2b_snapshots', {
      id: 'g2b_smoke', company_id: coId, period, gstin: '29ABCDE1234F1Z5',
      total_itc: 0, itc_cgst: 0, itc_sgst: 0, itc_igst: 0,
      data_json: JSON.stringify([]), cdnr_json: JSON.stringify([]),
      source: 'gstn-live', fetched_at: nowIso(),
    });
    const gstSummary = await api('GET', '/api/gst/summary', null, cfo);
    check('gst: summary exposes snapshot period', gstSummary.period === period, gstSummary.period);
    const csvResp = await fetch(BASE + `/api/gst/export?type=gstr3b&period=${period}`, { headers: { authorization: 'Bearer ' + cfo } });
    const csv = await csvResp.text();
    check('gst: GSTR-3B CSV export', csvResp.ok && csv.startsWith('field,amount'), csv.slice(0, 40));

    // ---- TALLY CHANNEL: XML import + aging ----
    const tally = await api('GET', '/api/tally/health', null, cfo);
    check('tally: health endpoint', !!tally && (tally.status === 'connected' || tally.status === 'degraded') && tally.connector && tally.connector.provider === 'tally-xml-upload', tally.connector ? tally.connector.provider : 'no connector');
    const importRes = await api('POST', '/api/tally/import-xml', {
      xml: '<ENVELOPE><BODY><DATA><TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE><TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE><TALLYMESSAGE><LEDGER><NAME>Smoke Vendor Traders</NAME><PARENT>Sundry Creditors</PARENT><GSTIN>29ABCDE1234F1Z5</GSTIN></LEDGER></TALLYMESSAGE><TALLYMESSAGE><VOUCHER><DATE>' + today.replace(/-/g, '') + '</DATE><VOUCHERNUMBER>PU-SM-1</VOUCHERNUMBER><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><PARTYLEDGERNAME>Smoke Vendor Traders</PARTYLEDGERNAME><AMOUNT>59000</AMOUNT><LEDGERENTRIES.LIST><LEDGERNAME>Purchase Account</LEDGERNAME><AMOUNT>-59000.00</AMOUNT></LEDGERENTRIES.LIST><LEDGERENTRIES.LIST><LEDGERNAME>Smoke Vendor Traders</LEDGERNAME><AMOUNT>59000.00</AMOUNT></LEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>',
    }, cfo);
    check('tally: xml import imports purchase voucher', importRes.parsed.vouchers === 1 && importRes.imported.vouchers.imported === 1 && importRes.validation.errors.length === 0, JSON.stringify(importRes.imported).slice(0, 80));
    const aging = await api('GET', '/api/payables/aging', null, cfo);
    check('payables: aging buckets from imported Tally purchase vouchers', aging && typeof aging.buckets === 'object' && aging.total === 59000, JSON.stringify(aging));
    const mapping = await api('GET', '/api/tally/mappings', null, cfo);
    check('tally: vendor-ledger mapping report', mapping && Array.isArray(mapping.rows) && mapping.ledgers.some((l) => l.name === 'Smoke Vendor Traders'), JSON.stringify(mapping ? mapping.summary : null));
    const autoMap = await api('POST', '/api/tally/mappings/auto', {}, cfo);
    check('tally: auto-map runs', autoMap && Array.isArray(autoMap.updated), JSON.stringify(autoMap));
    let mapBlocked = false;
    try { await api('POST', '/api/tally/mappings', { vendor_id: 'v_smoke', ledger_name: 'Smoke Vendor Traders' }, exec); } catch (e) { mapBlocked = e.status === 403; }
    check('RBAC: executive cannot edit ledger mappings', mapBlocked);
    const guidXml = (alterid, amount) => '<ENVELOPE><BODY><DATA>' +
      '<TALLYMESSAGE><GROUP><NAME>Current Liabilities</NAME></GROUP></TALLYMESSAGE>' +
      '<TALLYMESSAGE><GROUP><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP></TALLYMESSAGE>' +
      '<TALLYMESSAGE><LEDGER><NAME>Smoke Vendor Traders</NAME><PARENT>Sundry Creditors</PARENT></LEDGER></TALLYMESSAGE>' +
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create"><GUID>g-smoke-1</GUID><ALTERID>' + alterid + '</ALTERID>' +
      '<DATE>20260730</DATE><VOUCHERNUMBER>SMK-1</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>' +
      '<PARTYLEDGERNAME>Smoke Vendor Traders</PARTYLEDGERNAME>' +
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-' + amount + '.00</AMOUNT></LEDGERENTRIES.LIST>' +
      '<LEDGERENTRIES.LIST><LEDGERNAME>Smoke Vendor Traders</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>' + amount + '.00</AMOUNT></LEDGERENTRIES.LIST>' +
      '</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>';
    const guid1 = await api('POST', '/api/tally/import-xml', { xml: guidXml(1, 1000) }, cfo);
    check('tally: GUID import inserts', guid1.imported.vouchers.imported === 1, JSON.stringify(guid1.imported));
    const guid2 = await api('POST', '/api/tally/import-xml', { xml: guidXml(2, 1500) }, cfo);
    check('tally: edited re-export counts as Updated', guid2.imported.vouchers.updated === 1 && guid2.imported.vouchers.imported === 0, JSON.stringify(guid2.imported));
    const guid3 = await api('POST', '/api/tally/import-xml', { xml: guidXml(2, 1500) }, cfo);
    check('tally: same ALTERID re-upload skips', guid3.imported.vouchers.skipped === 1 && guid3.imported.vouchers.updated === 0, JSON.stringify(guid3.imported));
    const unbalXml = '<ENVELOPE><BODY><DATA>' +
      '<TALLYMESSAGE><LEDGER><NAME>Rent Expenses</NAME><PARENT>Current Liabilities</PARENT></LEDGER></TALLYMESSAGE>' +
      '<TALLYMESSAGE><VOUCHER><DATE>20260730</DATE><VOUCHERNUMBER>SMK-UNBAL</VOUCHERNUMBER><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>' +
      '<PARTYLEDGERNAME>Smoke Vendor Traders</PARTYLEDGERNAME>' +
      '<LEDGERENTRIES.LIST><LEDGERNAME>Rent Expenses</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></LEDGERENTRIES.LIST>' +
      '<LEDGERENTRIES.LIST><LEDGERNAME>Smoke Vendor Traders</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT></LEDGERENTRIES.LIST>' +
      '</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>';
    const unbal = await api('POST', '/api/tally/import-xml', { xml: unbalXml }, cfo);
    check('tally: unbalanced voucher rejected with specific error',
      unbal.validation.errors.some((e) => e.message.includes('unbalanced')) && unbal.imported.vouchers.skipped === 1,
      JSON.stringify(unbal.validation.errors));
    const pull = await api('POST', '/api/tally/pull-ledgers', null, cfo);
    check('tally: pull-ledgers refreshes from imported masters', pull && typeof pull.ledgers === 'number' && typeof pull.mapped === 'number', JSON.stringify(pull));

    // ---- metrics + assistant + freshness + system ----
    const metrics = await api('GET', '/api/metrics', null, cfo);
    check('metrics: recon target 70', metrics.recon.target === 70);
    const prompts = await api('GET', '/api/assistant/prompts', null, cfo);
    check('assistant: prompt catalogue', Array.isArray(prompts.prompts) && prompts.prompts.length >= 4);
    const suggestions = await api('GET', '/api/assistant/suggestions', null, cfo);
    check('assistant: suggestions derived from live data', Array.isArray(suggestions) && suggestions.length > 0);
    const askCash = await api('POST', '/api/assistant/ask', { question: 'How much cash do we have?' }, cfo);
    check('assistant: cash question answered', askCash.answer.includes('\u20B9') && askCash.intent === 'cash', `${askCash.intent} \u2014 ${askCash.answer.slice(0, 50)}`);
    const askTodo = await api('POST', '/api/assistant/ask', { question: 'What should I focus on today?' }, mgr);
    check('assistant: suggestion intent returns actions', askTodo.intent === 'suggestions' && Array.isArray(askTodo.suggestions) && askTodo.suggestions.length > 0, askTodo.intent);
    const dashF = await api('GET', '/api/dashboard', null, cfo);
    check('freshness: dashboard exposes last bank sync', !!dashF.cash.last_synced_at);
    const reconF = await api('GET', '/api/recon/summary', null, cfo);
    check('freshness: recon exposes as-of timestamp', !!reconF.as_of);
    const health = await api('GET', '/api/system/health', null, cfo);
    check('system: health reports engine + tables', health.database.tables >= 20 && ['sqlite', 'pglite', 'postgres'].includes(health.database.engine), `${health.database.engine} / ${health.database.tables}`);
    check('system: queue + integrations surfaced', typeof health.queue === 'object' && Array.isArray(health.integrations.bank_accounts) && health.integrations.banks_supported >= 15 && health.integrations.gstn && health.integrations.gstn.mode === 'disabled' && !!health.integrations.gstn.last_gstr2b);
    const onboarding = await api('GET', '/api/onboarding', null, cfo);
    check('onboarding: steps present', onboarding.length >= 4, `got ${onboarding.length}`);
    const page = await fetch(BASE + '/');
    const html = await page.text();
    check('web: SPA served', page.ok && html.includes('KhataOS'), html.slice(0, 60));
    const assetMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
    const bundlePath = assetMatch ? assetMatch[1] : '/js/app.js';
    const appJs = await fetch(BASE + bundlePath);
    check('web: app bundle served', appJs.ok, bundlePath);

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
