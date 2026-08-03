'use strict';

const { all, get, insert, run, update } = require('./db');
const dbModule = require('./db');
const { uid, nowIso, todayStr, daysAgo, daysAhead, addDays, inr, formatINR } = require('./util');
const { ApiError, login, logout, requireAuth, requireRole, audit, recentAudit, publicUser } = require('./auth');
const { queue, BankDataProvider, PaymentGateway, TallyConnector, OcrEngine, GstDataProvider, EmailInbox, createApprovalChain } = require('./adapters');
const Decentro = require('./decentro');
const Gstn = require('./gstn');
const TallyImport = require('./tally-import');
const TallyMapping = require('./tally-mapping');
const recon = require('./recon');
const Assistant = require('./ai');

// ---- tiny router ----
class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    this.routes.push({ method, rx, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  find(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.rx);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function ok(res, data) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); }

function companyOf(user) { return user.company_id; }

function createRouter() {
  const r = new Router();

  // ===================== AUTH =====================
  r.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
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

  // ===================== CASH & BANKS =====================
  r.get('/api/banks', async (req, res, p, user) => {
    ok(res, await all('SELECT code, name, kind, aa_supported FROM banks ORDER BY name'));
  });

  r.get('/api/cash/accounts', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = await all(`SELECT ba.*, b.name AS bank_name FROM bank_accounts ba JOIN banks b ON b.code = ba.bank_code WHERE ba.company_id = ? ORDER BY ba.account_name`, [coId]);
    const out = [];
    for (const a of rows) {
      const last = await get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [a.id]);
      const unc = await get(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE account_id = ? AND status = 'uncleared' AND amount > 0`, [a.id]);
      out.push({ ...a, balance: last ? last.closing_balance : 0, uncleared: unc.u || 0, source_label: a.source === 'aa' ? 'Account Aggregator' : 'Direct API' });
    }
    ok(res, out);
  });

  r.get('/api/cash/overview', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = await all(`SELECT ba.*, b.name AS bank_name FROM bank_accounts ba JOIN banks b ON b.code = ba.bank_code WHERE ba.company_id = ?`, [coId]);
    const accounts = await Promise.all(rows.map(async (a) => {
        const last = await get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [a.id]);
        return { id: a.id, account_name: a.account_name, bank_name: a.bank_name, account_number: a.account_number, balance: last ? last.closing_balance : 0, source: a.source };
      }));
    const total = inr(accounts.reduce((s, a) => s + a.balance, 0));
    const uncleared = inr((await all(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE company_id = ? AND status='uncleared' AND amount > 0`, [coId]))[0].u);
    const week = await all(`SELECT * FROM bank_transactions WHERE company_id = ? AND txn_date >= ? ORDER BY txn_date DESC, id DESC`, [coId, daysAgo(6)]);
    ok(res, { accounts, total_available: total, uncleared, last_synced_at: (await get('SELECT MAX(last_synced_at) AS t FROM bank_accounts WHERE company_id = ?', [coId])).t });
  });

  r.get('/api/cash/transactions', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const account = u.searchParams.get('account') || '';
    const days = parseInt(u.searchParams.get('days') || '7', 10);
    const rows = account
      ? await all(`SELECT t.*, a.account_name, b.name AS bank_name FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code WHERE t.company_id = ? AND t.account_id = ? AND t.txn_date >= ? ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, [coId, account, daysAgo(days - 1)])
      : await all(`SELECT t.*, a.account_name, b.name AS bank_name FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code WHERE t.company_id = ? AND t.txn_date >= ? ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, [coId, daysAgo(days - 1)]);
    ok(res, rows);
  });

  r.get('/api/cash/trend', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const days = parseInt(u.searchParams.get('days') || '30', 10);
    const rows = await all(`SELECT date, SUM(closing_balance) AS balance FROM cash_daily WHERE company_id = ? AND date >= ? GROUP BY date ORDER BY date`, [coId, daysAgo(days - 1)]);
    ok(res, rows);
  });

  r.post('/api/aa/consent/start', async (req, res, p, user) => {
    const { bank_code, account_number } = req.body || {};
    if (!bank_code || !account_number) throw new ApiError(400, 'bank_code and account_number required');
    const bank = await get('SELECT * FROM banks WHERE code = ?', [bank_code]);
    if (!bank) throw new ApiError(400, 'unknown bank');
    const consent = BankDataProvider.startConsent(companyOf(user), bank_code, account_number);
    await audit(companyOf(user), user, 'aa.consent_start', 'bank', bank_code, { bank: bank.name });
    ok(res, consent);
  });

  r.post('/api/aa/consent/verify', async (req, res, p, user) => {
    const { consent_id, otp } = req.body || {};
    const approved = BankDataProvider.verifyConsent(consent_id, otp);
    const c = approved; // {consentId, status...}
    const consentMeta = await get('SELECT * FROM banks WHERE code = ?', [req.body.bank_code || '']);
    const accountId = uid('acc');
    const accNum = req.body.account_number || String(Math.floor(Math.random() * 90000000000) + 10000000000);
    await insert('bank_accounts', {
      id: accountId, company_id: companyOf(user), bank_code: req.body.bank_code || 'ICIC',
      account_name: `${consentMeta ? consentMeta.name : 'New Bank'} Current - New`, account_number: accNum,
      type: 'current', ifsc: consentMeta && consentMeta.code === 'ICIC' ? 'ICIC0000022' : 'HDFC0001234',
      status: 'active', source: 'aa', consent_id: consent_id,
      opened_at: todayStr(),
    });
    const account = await get('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
    await BankDataProvider.fetchTransactions(companyOf(user), { ...account, opening_balance: 1500000 + Math.floor(Math.random() * 500000) });
    await run(`UPDATE onboarding_steps SET status='done', at=? WHERE company_id=? AND step='connect_bank'`, [nowIso(), companyOf(user)]);
    await audit(companyOf(user), user, 'aa.consent_approved', 'bank_account', accountId, { consent: consent_id });
    ok(res, { consent: approved, account });
  });

  r.post('/api/cash/refresh', async (req, res, p, user) => {
    const coId = companyOf(user);
    const accounts = await all('SELECT * FROM bank_accounts WHERE company_id = ? AND status = \'active\'', [coId]);
    let added = 0, decentroAdded = 0;
    const decentroAccounts = [];
    for (const a of accounts) {
      if (a.source === 'decentro') {
        if (Decentro.enabled()) {
          decentroAccounts.push(a);
          const r = await Decentro.pull(coId, a, { recentOnly: true });
          decentroAdded += r.inserted;
        }
        continue;
      }
      const txns = await BankDataProvider.refresh(coId, a);
      for (const t of txns) {
        const exists = await get('SELECT id FROM bank_transactions WHERE account_id = ? AND external_id = ?', [a.id, t.external_id]);
        if (exists) continue;
        await insert('bank_transactions', {
          id: uid('btx'), company_id: coId, account_id: a.id, external_id: t.external_id,
          txn_date: t.txn_date, value_date: t.value_date, amount: t.amount,
          balance_after: t.balance_after, description: t.description, mode: t.mode,
          ref_no: t.ref_no, status: t.status, raw_json: JSON.stringify(t), created_at: nowIso(),
        });
        added++;
      }
    }
    const stats = await recon.matchAll(coId);
    const voucherMatched = await recon.autoVoucherMatch(coId, 7);
    await TallyConnector.heartbeat(coId);
    ok(res, { added_transactions: added, decentro_transactions: decentroAdded, decentro_accounts: decentroAccounts.length, voucher_matched: voucherMatched, recon: stats });
  });

  // ---- Decentro Connected Banking (real bank data API) ----
  r.get('/api/integrations/decentro/status', async (req, res) => {
    ok(res, Decentro.config());
  });

  r.post('/api/decentro/link', async (req, res, p, user) => {
    const coId = companyOf(user);
    const b = req.body || {};
    if (!b.account_number) throw new ApiError(400, 'account_number required');
    if (!Decentro.enabled()) throw new ApiError(503, 'Decentro not configured — set DECENTRO_CLIENT_ID, DECENTRO_CLIENT_SECRET and DECENTRO_MODULE_SECRET (see docs/decentro.md)');

    // Build provider_params from the request (ICICI: corp_id/user_id/alias_id;
    // other banks follow Decentro's provider parameter tables).
    const providerParams = {};
    for (const k of ['corp_id', 'user_id', 'alias_id']) {
      if (b[k]) providerParams[k] = String(b[k]);
    }
    if (b.provider_params && typeof b.provider_params === 'object') Object.assign(providerParams, b.provider_params);

    const result = await Decentro.createLink(b.account_number, {
      name: b.name, pan: b.pan, email: b.email, mobile: b.mobile, address: b.address,
      ifsc: b.ifsc, customer_id: b.customer_id, provider_params: providerParams,
    });

    const linkId = uid('dl');
    await insert('decentro_links', {
      id: linkId, company_id: coId, account_number: b.account_number,
      mobile: b.mobile || null, customer_id: b.customer_id || null,
      bank_code: b.bank_code || (b.ifsc ? b.ifsc.toUpperCase().slice(0, 4) : null),
      status: result.redirect_url ? 'pending' : 'failed',
      decentro_txn_id: result.decentroTxnId || null,
      redirect_url: result.redirect_url,
      last_error: result.redirect_url ? null : (result.message || 'no redirect url returned'),
      created_at: nowIso(),
    });
    await audit(coId, user, 'bank.link_initiated', 'bank', b.account_number, { provider: 'decentro', decentro_status: result.status, response_code: result.responseCode });

    if (!result.redirect_url) {
      throw new ApiError(502, `Decentro did not return a redirect URL (${result.message || result.status || 'unknown'}) — account may already be linked; check link status instead.`);
    }
    ok(res, {
      link_id: linkId, redirect_url: result.redirect_url,
      decentroTxnId: result.decentroTxnId, message: result.message,
      note: 'Open the redirect URL in a new tab, approve the connected-banking consent on your netbanking portal, then confirm here. KhataOS also auto-completes via Decentro\'s Account Linkage Status Callback.',
    });
  });

  r.post('/api/decentro/link/status', async (req, res, p, user) => {
    const coId = companyOf(user);
    const b = req.body || {};
    if (!Decentro.enabled()) throw new ApiError(503, 'Decentro not configured');
    const linkRow = b.link_id
      ? await get('SELECT * FROM decentro_links WHERE id = ? AND company_id = ?', [b.link_id, coId])
      : await get('SELECT * FROM decentro_links WHERE account_number = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1', [b.account_number, coId]);
    if (!linkRow) throw new ApiError(404, 'no pending Decentro link for this account');
    if (linkRow.status === 'linked') {
      const account = await get('SELECT * FROM bank_accounts WHERE company_id = ? AND account_number = ?', [coId, linkRow.account_number]);
      return ok(res, { status: 'linked', account });
    }

    const poll = await Decentro.checkLinkStatus(linkRow.account_number, b.mobile || linkRow.mobile);
    const s = String(poll.status || '').toUpperCase();
    const linked = s === 'SUCCESS' || s.includes('LINKED') || s.includes('REGISTERED') || s === 'ACTIVE';
    if (linked) {
      const finalized = await Decentro.finalizeLink(coId, linkRow.account_number, {
        name: b.name, ifsc: b.ifsc, bank_code: linkRow.bank_code,
      });
    await recon.matchAll(coId);
      await run(`UPDATE onboarding_steps SET status='done', at=? WHERE company_id=? AND step='connect_bank'`, [nowIso(), coId]);
    await audit(coId, user, 'bank.linked_decentro', 'bank_account', finalized.account.id, { account_number: linkRow.account_number, via: 'status_poll' });
      ok(res, { status: 'linked', account: finalized.account, transactions_pulled: finalized.pulled.inserted, present_balance: finalized.pulled.present_balance });
    } else {
      ok(res, { status: String(poll.status || 'PENDING'), message: poll.message || 'still awaiting approval on the bank portal' });
    }
  });

  // Decentro -> KhataOS webhook: Account Linkage Status Callback.
  // Decentro triggers this to the endpoint shared at onboarding whenever an
  // account is linked or unlinked. Always responds 200 so Decentro doesn't
  // retry; ignores events for unknown tenants.
  r.post('/api/decentro/webhook', async (req, res) => {
    const b = req.body || {};
    const accountNumber = b.account_number || b.accountNumber || (b.data && (b.data.account_number || b.data.accountNumber));
    const status = String(b.status || (b.data && b.data.status) || '').toUpperCase();
    if (!accountNumber || !Decentro.enabled()) {
      return ok(res, { ok: true, ignored: true, reason: !accountNumber ? 'no account_number' : 'provider not configured' });
    }
    const linkRow = await get('SELECT * FROM decentro_links WHERE account_number = ? ORDER BY created_at DESC LIMIT 1', [accountNumber]);
    const coId = linkRow ? linkRow.company_id : ((await get('SELECT COUNT(*) AS c FROM companies')).c === 1 ? (await get('SELECT id FROM companies LIMIT 1')).id : null);
    if (!coId) {
      return ok(res, { ok: true, ignored: true, reason: 'no matching tenant for account ' + accountNumber });
    }
    const linked = status.includes('SUCCESS') || status.includes('LINKED') || status.includes('REGISTERED') || status.includes('ACTIVE');
    if (linked) {
      const finalized = await Decentro.finalizeLink(coId, accountNumber, { bank_code: linkRow ? linkRow.bank_code : null });
    await recon.matchAll(coId);
      await run(`UPDATE onboarding_steps SET status='done', at=? WHERE company_id=? AND step='connect_bank'`, [nowIso(), coId]);
    await audit(coId, null, 'bank.linked_decentro_webhook', 'bank_account', finalized.account.id, { account_number: accountNumber, status });
      ok(res, { ok: true, linked: true, account_id: finalized.account.id, transactions_pulled: finalized.pulled.inserted });
    } else {
      if (linkRow) await run(`UPDATE decentro_links SET status = 'failed', last_error = ? WHERE id = ?`, [String(status || b.status || '').slice(0, 200), linkRow.id]);
    await audit(coId, null, 'bank.link_rejected', 'bank', accountNumber, { status });
      ok(res, { ok: true, linked: false, status });
    }
  });

  r.post('/api/decentro/refresh', async (req, res, p, user) => {
    const coId = companyOf(user);
    if (!Decentro.enabled()) throw new ApiError(503, 'Decentro not configured');
    const accounts = await all('SELECT * FROM bank_accounts WHERE company_id = ? AND source = \'decentro\' AND status = \'active\'', [coId]);
    let inserted = 0;
    for (const a of accounts) inserted += (await Decentro.pull(coId, a, { recentOnly: true })).inserted;
    const stats = await recon.matchAll(coId);
    ok(res, { accounts: accounts.length, inserted, recon: stats });
  });

  // ===================== AP / INVOICES =====================
  r.get('/api/vendors', async (req, res, p, user) => {
    ok(res, await all('SELECT * FROM vendors WHERE company_id = ? AND active = 1 ORDER BY name', [companyOf(user)]));
  });

  // Payables aging from imported Tally purchase vouchers (authoritative once
  // imported): age buckets by voucher date vs today.
  r.get('/api/payables/aging', async (req, res, p, user) => {
    const coId = companyOf(user);
    const purchases = await all(`SELECT voucher_number, date, amount, party_name FROM tally_vouchers WHERE company_id = ? AND voucher_type = 'Purchase' AND cancelled = 0 ORDER BY date`, [coId]);
    const debitNotes = await all(`SELECT amount, party_name FROM tally_vouchers WHERE company_id = ? AND voucher_type = 'Debit Note' AND cancelled = 0 ORDER BY date`, [coId]);
    // Debit Notes reduce what we owe their vendor (purchase returns/price
    // adjustments). Net each vendor's outstanding purchase total against the
    // sum of their Debit Notes before bucketing; the reduction is applied
    // oldest-purchase-first, the standard FIFO assumption for settlements.
    const dnByParty = new Map();
    for (const d of debitNotes) {
      if (!d.party_name) continue;
      dnByParty.set(d.party_name, (dnByParty.get(d.party_name) || 0) + Math.abs(d.amount || 0));
    }
    const today = Date.parse(todayStr());
    const buckets = { current: 0, '31-60': 0, '61-90': 0, '90+': 0 };
    const items = [];
    for (const v of purchases) {
      let net = Math.abs(v.amount || 0);
      if (v.party_name && dnByParty.has(v.party_name)) {
        const applied = Math.min(net, dnByParty.get(v.party_name));
        net -= applied;
        const remaining = dnByParty.get(v.party_name) - applied;
        if (remaining <= 0) dnByParty.delete(v.party_name); else dnByParty.set(v.party_name, remaining);
      }
      if (net <= 0) continue; // fully offset by Debit Notes
      const age = Math.max(0, Math.floor((today - Date.parse(v.date)) / 86400000));
      const bucket = age <= 30 ? 'current' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+';
      buckets[bucket] += net;
      items.push({ voucher_number: v.voucher_number, date: v.date, party_name: v.party_name, age, bucket, amount: inr(net) });
    }
    ok(res, { buckets, total: inr(items.reduce((s, i) => s + i.amount, 0)), items });
  });

  r.get('/api/invoices', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const status = u.searchParams.get('status');
    const q = u.searchParams.get('q');
    const where = ['i.company_id = ?'];
    const args = [coId];
    if (status && status !== 'all') { where.push('i.status = ?'); args.push(status); }
    if (q) { where.push('(i.invoice_no LIKE ? OR v.name LIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
    const rows = await all(`SELECT i.*, v.name AS vendor_name, v.gstin AS vendor_gstin FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT 200`, args);
    ok(res, rows);
  });

  r.get('/api/invoices/:id', async (req, res, p, user) => {
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, companyOf(user)]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    const vendor = inv.vendor_id ? await get('SELECT * FROM vendors WHERE id = ?', [inv.vendor_id]) : null;
    const lines = await all('SELECT * FROM invoice_lines WHERE invoice_id = ?', [inv.id]);
    const approvals = await all('SELECT * FROM approvals WHERE invoice_id = ? ORDER BY level', [inv.id]);
    const payments = await all('SELECT * FROM payments WHERE company_id = ? AND invoice_ids LIKE ?', [companyOf(user), '%' + inv.id + '%']);
    ok(res, { ...inv, vendor, lines, approvals, payments });
  });

  r.post('/api/invoices/ocr-preview', async (req, res, p, user) => {
    const text = (req.body || {}).text || OcrEngine.sampleEmail('cement').body;
    ok(res, OcrEngine.extract(text));
  });

  r.post('/api/invoices/email-sim', async (req, res, p, user) => {
    const template = (req.body || {}).template || 'cement';
    const mail = OcrEngine.sampleEmail(template);
  const invoice = await EmailInbox.forward(companyOf(user), mail.from, mail.subject, mail.body);
    const poMatch = mail.body.match(/PO-\d+/);
    if (poMatch) {
      await update('invoices', invoice.id, { purchase_order_no: poMatch[0] });
      invoice.purchase_order_no = poMatch[0];
    }
      const twm = await runThreeWay(companyOf(user), invoice.id);
    await audit(companyOf(user), user, 'invoice.captured', 'invoice', invoice.id, { source: 'email_sim', invoice_no: invoice.invoice_no });
    ok(res, { invoice: await get('SELECT * FROM invoices WHERE id = ?', [invoice.id]), ocr: JSON.parse(invoice.ocr_json), three_way_match: twm });
  });

  r.post('/api/invoices/capture', async (req, res, p, user) => {
    const coId = companyOf(user);
    const b = req.body || {};
    const source = b.source || 'manual';
    let fields;
    if (source === 'pdf') {
      const mail = OcrEngine.sampleEmail('apex');
      fields = OcrEngine.extract(mail.body);
      fields.source = 'pdf_upload';
    } else {
      fields = b;
      fields.source = 'manual';
    }
    const vendor = fields.vendor_id ? await get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [fields.vendor_id, coId]) : null;
    const taxable = inr(parseFloat(fields.taxable_amount || 0));
    const inter = parseFloat(fields.igst || 0) > 0;
    const cgst = inr(parseFloat(fields.cgst || (inter ? 0 : taxable * 0.09)));
    const sgst = inr(parseFloat(fields.sgst || (inter ? 0 : taxable * 0.09)));
    const igst = inr(parseFloat(fields.igst || (inter ? taxable * 0.18 : 0)));
    const gross = inr(taxable + cgst + sgst + igst);
    const tdsRate = vendor ? vendor.tds_rate : 0;
    const tds = inr(gross * tdsRate);
    if (!fields.invoice_no) throw new ApiError(400, 'invoice_no required');
    const invId = uid('inv');
    await insert('invoices', {
      id: invId, company_id: coId, invoice_no: String(fields.invoice_no).trim(),
      vendor_id: vendor ? vendor.id : null,
      invoice_date: fields.invoice_date || todayStr(),
      due_date: fields.due_date || addDays(fields.invoice_date || todayStr(), vendor ? vendor.credit_days : 30),
      source, status: 'pending_approval',
      gross_amount: gross, taxable_amount: taxable, cgst, sgst, igst, cess: 0,
      tds_amount: tds, net_payable: inr(gross - tds),
      gstin_vendor: fields.gstin_vendor || (vendor ? vendor.gstin : null),
      hsns: JSON.stringify(fields.hsns || []),
      three_way_match: 'none',
      ocr_json: JSON.stringify({ engine: OcrEngine.name, confidence: source === 'pdf' ? 0.95 : 1 }),
      created_by: user.id, created_at: nowIso(),
    });
    if (fields.hsns && fields.hsns.length) {
      for (const l of fields.hsns) {
        await insert('invoice_lines', { id: uid('l'), invoice_id: invId, hsn: l.hsn, description: l.description, qty: l.qty || 1, rate: l.rate || 0, taxable: l.taxable || 0, cgst: l.cgst || 0, sgst: l.sgst || 0, igst: l.igst || 0, cess: 0 });
      }
    }
    await createApprovalChain(coId, invId);
    await audit(coId, user, 'invoice.captured', 'invoice', invId, { source, invoice_no: fields.invoice_no });
    ok(res, await get('SELECT * FROM invoices WHERE id = ?', [invId]));
  });

  r.post('/api/invoices/:id/three-way-match', async (req, res, p, user) => {
    const result = await runThreeWay(companyOf(user), p.id);
    ok(res, result);
  });

  r.post('/api/invoices/:id/approve', async (req, res, p, user) => {
    const coId = companyOf(user);
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    const pending = await get(`SELECT * FROM approvals WHERE invoice_id = ? AND status = 'pending' AND required_role = ? ORDER BY level LIMIT 1`, [p.id, user.role]);
    if (!pending) {
      const anyPending = await get(`SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ? AND status = 'pending'`, [p.id]);
      if (anyPending.c > 0) throw new ApiError(403, `This approval level requires ${(await get(`SELECT required_role FROM approvals WHERE invoice_id = ? AND status='pending' ORDER BY level LIMIT 1`, [p.id]) || {}).required_role}`);
      throw new ApiError(409, 'invoice already fully approved');
    }
    await update('approvals', pending.id, { status: 'approved', approver_id: user.id, approver_name: user.name, comment: (req.body || {}).comment || null, decided_at: nowIso() });
    const remaining = await get(`SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ? AND status = 'pending'`, [p.id]);
    if (remaining.c === 0) {
      await update('invoices', p.id, { status: 'approved', approved_by: user.id, approved_at: nowIso() });
      queue.enqueue(coId, 'tally.syncVoucher', { invoiceId: p.id });
    }
    await audit(coId, user, 'invoice.approved', 'invoice', p.id, { invoice_no: inv.invoice_no, level: pending.level });
    ok(res, await get('SELECT * FROM invoices WHERE id = ?', [p.id]));
  });

  r.post('/api/invoices/:id/reject', async (req, res, p, user) => {
    const coId = companyOf(user);
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    await update('invoices', p.id, { status: 'rejected' });
    await run(`UPDATE approvals SET status='rejected', approver_id=?, approver_name=?, decided_at=? WHERE invoice_id=? AND status='pending'`, [user.id, user.name, nowIso(), p.id]);
    await audit(coId, user, 'invoice.rejected', 'invoice', p.id, { invoice_no: inv.invoice_no, comment: (req.body || {}).comment });
    ok(res, await get('SELECT * FROM invoices WHERE id = ?', [p.id]));
  });

  r.get('/api/approvals/pending', async (req, res, p, user) => {
    const rows = await all(`SELECT a.*, i.invoice_no, i.gross_amount, i.invoice_date, i.due_date, v.name AS vendor_name
      FROM approvals a JOIN invoices i ON i.id = a.invoice_id LEFT JOIN vendors v ON v.id = i.vendor_id
      WHERE a.company_id = ? AND a.status = 'pending' AND a.required_role = ?
      ORDER BY i.due_date ASC`, [companyOf(user), user.role]);
    ok(res, rows);
  });

  // ===================== DASHBOARD =====================
  r.get('/api/dashboard', async (req, res, p, user) => {
    const coId = companyOf(user);
    const accounts = await all('SELECT * FROM bank_accounts WHERE company_id = ?', [coId]);
    let available = 0, uncleared = 0;
    for (const a of accounts) {
      const last = await get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [a.id]);
      available += last ? last.closing_balance : 0;
    }
    uncleared = inr((await all(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE company_id = ? AND status='uncleared' AND amount > 0`, [coId]))[0].u);
    available = inr(available);

    const today = todayStr();
    const due = await all(`SELECT * FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled','pending_approval') AND due_date >= ? AND due_date <= ? ORDER BY due_date`, [coId, today, daysAhead(7)]);
    const overdue = await all(`SELECT * FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled') AND due_date < ? ORDER BY due_date`, [coId, today]);
    const dueAmount = inr(due.reduce((s, i) => s + i.net_payable, 0));
    const overdueAmount = inr(overdue.reduce((s, i) => s + i.net_payable, 0));

    const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
    const gstLiability = inr((await all(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled')`, [coId]))[0].s);
    const mismatches = (await get(`SELECT COUNT(*) AS c FROM gst_mismatches WHERE company_id = ? AND status = 'open'`, [coId])).c;

    const outflows = await all(`SELECT COALESCE(SUM(amount),0) AS s FROM bank_transactions WHERE company_id = ? AND amount < 0 AND txn_date >= ?`, [coId, daysAgo(89)]);
    const monthlyBurn = inr(Math.abs(outflows[0].s) / 3);
    const runwayMonths = monthlyBurn > 0 ? inr(available / monthlyBurn) : null;

    const reconScore = await recon.score(coId);
    const tally = await TallyConnector.health(coId);
    const trend = await all(`SELECT date, SUM(closing_balance) AS balance FROM cash_daily WHERE company_id = ? AND date >= ? GROUP BY date ORDER BY date`, [coId, daysAgo(29)]);
    const lastBankSync = (await get('SELECT MAX(last_synced_at) AS t FROM bank_accounts WHERE company_id = ?', [coId])).t;

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

  // ===================== PAYMENTS =====================
  r.get('/api/payments', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const status = u.searchParams.get('status');
    const where = ['p.company_id = ?'];
    const args = [coId];
    if (status && status !== 'all') { where.push('p.status = ?'); args.push(status); }
    const rows = await all(`SELECT p.*, v.name AS vendor_name FROM payments p LEFT JOIN vendors v ON v.id = p.vendor_id
      WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 200`, args);
    // resolve invoice references in JS (engine-agnostic; invoice_ids is a JSON array string)
    const ids = [...new Set(rows.flatMap(r => { try { return JSON.parse(r.invoice_ids || '[]'); } catch { return []; } }))];
    let refMap = {};
    if (ids.length) {
      refMap = Object.fromEntries((await all(`SELECT id, invoice_no FROM invoices WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).map(i => [i.id, i.invoice_no]));
    }
    ok(res, rows.map(r => ({ ...r, invoice_refs: (() => { try { return JSON.parse(r.invoice_ids || '[]').map(id => refMap[id]).filter(Boolean).join(', '); } catch { return null; } })() })));
  });

  r.get('/api/payments/:id', async (req, res, p, user) => {
    const row = await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [p.id, companyOf(user)]);
    if (!row) throw new ApiError(404, 'payment not found');
    ok(res, row);
  });

  r.post('/api/payments', async (req, res, p, user) => {
    const coId = companyOf(user);
    const b = req.body || {};
    if (!b.vendor_id || !Array.isArray(b.invoice_ids) || !b.invoice_ids.length) throw new ApiError(400, 'vendor_id and invoice_ids required');
    const vendor = await get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [b.vendor_id, coId]);
    if (!vendor) throw new ApiError(404, 'vendor not found');
    const invoices = (await Promise.all(b.invoice_ids.map(id => get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId])))).filter(Boolean);
    if (!invoices.length) throw new ApiError(400, 'no valid invoices');
    const mode = b.mode || 'NEFT';
    if (!['UPI', 'IMPS', 'NEFT', 'RTGS'].includes(mode)) throw new ApiError(400, 'invalid mode');
    const amount = inr(invoices.reduce((s, i) => s + i.gross_amount, 0));
    const tds = inr(invoices.reduce((s, i) => s + (i.tds_amount || 0), 0));
    const net = inr(amount - tds);
    const settings = JSON.parse((await get('SELECT settings FROM companies WHERE id = ?', [coId])).settings || '{}');
    const payThreshold = settings.payment_approval_threshold || 500000;
    const needsApproval = amount > payThreshold;
    const payId = uid('pay');
    await insert('payments', {
      id: payId, company_id: coId, vendor_id: vendor.id,
      invoice_ids: JSON.stringify(invoices.map(i => i.id)),
      amount, mode, type: b.type === 'instant' ? 'instant' : b.scheduled_date ? 'scheduled' : 'batch',
      status: needsApproval ? 'pending_approval' : 'approved',
      scheduled_date: b.scheduled_date || null,
      bank_account_id: b.account_id || null,
      reference: `${mode}-${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
      gateway: 'razorpayx',
      gst_ledger: vendor.ledger_name, tds_section: vendor.tds_section,
      tds_amount: tds, net_amount: net,
      initiated_by: user.id, initiated_at: nowIso(), created_at: nowIso(),
    });
    const invStatus = b.scheduled_date && b.scheduled_date > todayStr() ? 'scheduled' : 'approved';
    await run(`UPDATE invoices SET status = ? WHERE id IN (${invoices.map(() => '?').join(',')})`, [invStatus, ...invoices.map(i => i.id)]);
    if (!needsApproval) {
    await PaymentGateway.createBatch(coId, [await get('SELECT * FROM payments WHERE id = ?', [payId])]);
    }
    await audit(coId, user, 'payment.created', 'payment', payId, { amount, mode, needs_approval: needsApproval });
    ok(res, await get('SELECT * FROM payments WHERE id = ?', [payId]));
  });

  r.post('/api/payments/:id/approve', async (req, res, p, user) => {
    const coId = companyOf(user);
    const pay = await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!pay) throw new ApiError(404, 'payment not found');
    if (pay.status !== 'pending_approval') throw new ApiError(409, 'payment is not awaiting approval');
    const settings = JSON.parse((await get('SELECT settings FROM companies WHERE id = ?', [coId])).settings || '{}');
    const threshold = settings.payment_approval_threshold || 500000;
    if (pay.amount > threshold) requireRole(user, ['cfo']);
    await update('payments', p.id, { status: 'approved', approved_by: user.id });
    await PaymentGateway.createBatch(coId, [pay]);
    await audit(coId, user, 'payment.approved', 'payment', p.id, { amount: pay.amount });
    ok(res, await get('SELECT * FROM payments WHERE id = ?', [p.id]));
  });

  r.post('/api/payments/:id/execute', async (req, res, p, user) => {
    const coId = companyOf(user);
    const pay = await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!pay) throw new ApiError(404, 'payment not found');
    if (!['approved', 'pending_approval'].includes(pay.status)) throw new ApiError(409, 'payment cannot be executed from current state');
    await update('payments', p.id, { type: 'instant', status: 'approved', approved_by: user.id });
    await PaymentGateway.createBatch(coId, [await get('SELECT * FROM payments WHERE id = ?', [p.id])]);
    await audit(coId, user, 'payment.executed', 'payment', p.id, { mode: pay.mode });
    ok(res, await get('SELECT * FROM payments WHERE id = ?', [p.id]));
  });

  r.post('/api/payments/batch', async (req, res, p, user) => {
    const coId = companyOf(user);
    const items = (req.body || {}).items || [];
    if (!items.length) throw new ApiError(400, 'items required');
    const created = [];
    for (const item of items) {
      const vendor = await get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [item.vendor_id, coId]);
      if (!vendor) continue;
    const invoices = (await Promise.all((item.invoice_ids || []).map(id => get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId])))).filter(Boolean);
      if (!invoices.length) continue;
      const amount = inr(invoices.reduce((s, i) => s + i.gross_amount, 0));
      const tds = inr(invoices.reduce((s, i) => s + (i.tds_amount || 0), 0));
      const payId = uid('pay');
      await insert('payments', {
        id: payId, company_id: coId, vendor_id: vendor.id,
        invoice_ids: JSON.stringify(invoices.map(i => i.id)),
        amount, mode: item.mode || 'NEFT', type: 'batch',
        status: 'approved', scheduled_date: item.scheduled_date || null,
        bank_account_id: item.account_id || null,
        reference: `${item.mode || 'NEFT'}-${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
        gateway: 'razorpayx', gst_ledger: vendor.ledger_name, tds_section: vendor.tds_section,
        tds_amount: tds, net_amount: inr(amount - tds),
        initiated_by: user.id, initiated_at: nowIso(), created_at: nowIso(),
      });
      const status = item.scheduled_date && item.scheduled_date > todayStr() ? 'scheduled' : 'approved';
      await run(`UPDATE invoices SET status = ? WHERE id IN (${invoices.map(() => '?').join(',')})`, [status, ...invoices.map(i => i.id)]);
      created.push(payId);
    }
    const rows = await all(`SELECT * FROM payments WHERE id IN (${created.map(() => '?').join(',')})`, created);
    await PaymentGateway.createBatch(coId, rows);
    await audit(coId, user, 'payment.batch_created', 'payment', null, { count: created.length });
    ok(res, rows);
  });

  // ===================== RECONCILIATION =====================
  r.get('/api/recon/summary', async (req, res, p, user) => {
    const coId = companyOf(user);
    const asOf = (await get('SELECT MAX(last_synced_at) AS t FROM bank_accounts WHERE company_id = ?', [coId])).t;
    const matches = await all(`SELECT rm.*, bt.amount AS bank_amount, bt.txn_date, bt.description, p.reference AS payment_ref
      FROM recon_matches rm
      JOIN bank_transactions bt ON bt.id = rm.bank_txn_id
      LEFT JOIN payments p ON p.id = rm.payment_id
      WHERE rm.company_id = ? ORDER BY rm.matched_at DESC LIMIT 50`, [coId]);
    ok(res, { ...(await recon.score(coId)), as_of: asOf, recent: matches });
  });

  // ===================== AI ASSISTANT =====================
  r.get('/api/assistant/prompts', async (req, res) => {
    ok(res, { prompts: Assistant.PROMPTS, status: Assistant.intent_status() });
  });

  r.get('/api/assistant/suggestions', async (req, res, p, user) => {
    ok(res, await Assistant.buildSuggestions(companyOf(user), user.role));
  });

  r.post('/api/assistant/ask', async (req, res, p, user) => {
    const question = String((req.body || {}).question || '').trim();
    if (!question) throw new ApiError(400, 'question required');
    await audit(companyOf(user), user, 'assistant.ask', 'assistant', null, { question: question.slice(0, 200) });
    const answer = await Assistant.ask(user, question);
    ok(res, answer);
  });

  r.get('/api/recon/unmatched', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = await all(`SELECT t.*, a.account_name, b.name AS bank_name
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code
      WHERE t.company_id = ? AND t.matched = 0 AND t.status = 'posted' AND t.txn_date >= ?
      ORDER BY t.txn_date DESC LIMIT 100`, [coId, daysAgo(30)]);
    // suggest a payment candidate by amount for each unmatched debit
    const payments = await all(`SELECT * FROM payments WHERE company_id = ? AND status IN ('completed','processing')`, [coId]);
    for (const t of rows) {
      const suggestion = payments.find(p => p.net_amount && Math.abs(Math.abs(t.amount) - p.net_amount) <= 1);
      t.suggested_payment = suggestion ? { id: suggestion.id, reference: suggestion.reference, vendor_id: suggestion.vendor_id, net_amount: suggestion.net_amount } : null;
    }
    const mismatchRows = await all(`SELECT bank_txn_id, notes FROM recon_matches WHERE company_id = ? AND status = 'mismatch' ORDER BY matched_at DESC`, [coId]);
    const mismatchByTxn = new Map(mismatchRows.map((m) => [m.bank_txn_id, m.notes]));
    for (const t of rows) t.mismatch_note = mismatchByTxn.get(t.id) || null;
    ok(res, rows);
  });

  r.post('/api/recon/run', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const stats = await recon.matchAll(companyOf(user));
    await audit(companyOf(user), user, 'recon.run', 'recon', null, stats);
    ok(res, { ...stats, score: await recon.score(companyOf(user)) });
  });

  r.post('/api/recon/manual-match', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const b = req.body || {};
    const txn = await get('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?', [b.bank_txn_id, coId]);
    if (!txn) throw new ApiError(404, 'transaction not found');
    const payment = b.payment_id ? await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [b.payment_id, coId]) : null;
    await recon.markMatched(txn.id, payment ? payment.id : null, 'manual', 1, user.id);
    await audit(coId, user, 'recon.manual_match', 'bank_transaction', txn.id, { payment_id: payment ? payment.id : null });
    ok(res, { matched: true });
  });

  r.post('/api/recon/unmatched/:id/voucher', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const txn = await get('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!txn) throw new ApiError(404, 'transaction not found');
    const vno = 'PV-MAN-' + String(Date.now()).slice(-6);
    await insert('recon_matches', {
      id: uid('rm'), company_id: coId, bank_txn_id: txn.id, payment_id: null,
      tally_voucher_no: vno, match_type: 'manual', confidence: 1, status: 'matched',
      matched_by: user.id, matched_at: nowIso(), notes: 'voucher created from unmatched transaction',
    });
    await run('UPDATE bank_transactions SET matched = 1 WHERE id = ?', [txn.id]);
    await TallyConnector.logSync(coId, 'voucher', vno, 'create', 'synced');
    await audit(coId, user, 'recon.voucher_created', 'bank_transaction', txn.id, { voucher: vno });
    ok(res, { voucher_no: vno });
  });

  // ===================== GST =====================
  r.get('/api/gst/summary', async (req, res, p, user) => {
    const coId = companyOf(user);
    const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
    const liability = inr((await all(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled')`, [coId]))[0].s);
    const committed = inr((await all(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled','pending_approval')`, [coId]))[0].s);
    const mismatches = await all(`SELECT * FROM gst_mismatches WHERE company_id = ? AND status = 'open' ORDER BY period DESC`, [coId]);
    const periods = await all('SELECT period, MAX(fetched_at) AS fetched_at FROM gstr2b_snapshots WHERE company_id = ? GROUP BY period ORDER BY period DESC', [coId]);
    ok(res, {
      itc: snap ? snap.total_itc : 0, itc_cgst: snap ? snap.itc_cgst : 0,
      itc_sgst: snap ? snap.itc_sgst : 0, itc_igst: snap ? snap.itc_igst : 0,
      period: snap ? snap.period : null, fetched_at: snap ? snap.fetched_at : null,
      liability, committed, mismatch_count: mismatches.length, mismatches, periods,
    });
  });

  r.post('/api/gst/refresh', async (req, res, p, user) => {
    const coId = companyOf(user);
    const period = GstDataProvider.currentPeriod();
    await GstDataProvider.fetchGstr2b(coId, period);
    const mismatches = await GstDataProvider.scanMismatches(coId, period);
    await audit(coId, user, 'gst.refresh', 'gstr2b', period, { mismatches: mismatches.length });
    ok(res, { period, mismatches: mismatches.length });
  });

  r.get('/api/gst/export', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const type = u.searchParams.get('type') || 'gstr3b';
    const period = u.searchParams.get('period') || GstDataProvider.currentPeriod();
    let csv;
    if (type === 'gstr2b') {
      const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? AND period = ? ORDER BY fetched_at DESC LIMIT 1', [coId, period]);
      const rows = snap ? JSON.parse(snap.data_json || '[]') : [];
      csv = 'period,gstin,invoice_no,taxable,cgst,sgst,igst\n' + rows.map(g => `${period},${g.gstin},${g.invoice_no},${g.taxable},${g.cgst},${g.sgst},${g.igst}`).join('\n');
    } else {
      csv = 'field,amount\n' + await GstDataProvider.exportGstr3b(coId, period);
    }
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${type}_${period}.csv"` });
    res.end(csv);
  });

  // ===================== GSTN / GSP (GSTR-2B + e-invoice contract) =====================
  r.get('/api/gstn/config', async (req, res) => {
    ok(res, Gstn.config());
  });

  r.post('/api/gstn/otp/request', async (req, res, p, user) => {
    const coId = companyOf(user);
    const out = await Gstn.requestOtp();
    await audit(coId, user, 'gstn.otp_request', 'gstn', null, { mode: out.mode, gstin: out.gstin });
    ok(res, out);
  });

  r.post('/api/gstn/otp/validate', async (req, res, p, user) => {
    const coId = companyOf(user);
    const { otp } = req.body || {};
    const out = await Gstn.validateOtp(otp);
    await audit(coId, user, 'gstn.otp_validated', 'gstn', null, { mode: out.mode, expiry_minutes: out.expiry_minutes });
    ok(res, out);
  });

  // ===================== TALLY =====================
  r.get('/api/tally/health', async (req, res, p, user) => {
    ok(res, await TallyConnector.health(companyOf(user)));
  });

  r.get('/api/tally/sync-logs', async (req, res, p, user) => {
    const rows = await all('SELECT * FROM tally_sync_logs WHERE company_id = ? ORDER BY queued_at DESC LIMIT 100', [companyOf(user)]);
    ok(res, rows);
  });

  r.post('/api/tally/pull-ledgers', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const ledgers = await TallyConnector.pullLedgers(coId);
    await audit(coId, user, 'tally.pull_ledgers', 'tally', null, { ledgers: ledgers.ledgers, mapped: ledgers.mapped });
    ok(res, ledgers);
  });

  // Cloud-only path: user exports Groups/Ledgers/Vouchers from Tally as XML
  // and uploads it. Validated, then imported in sequence (Groups -> Ledgers
  // -> Vouchers). Works without any live Tally connection.
  r.post('/api/tally/import-xml', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const xml = String((req.body || {}).xml || '').trim();
    if (!xml) throw new ApiError(400, 'xml payload required');
    let result;
    try {
      result = await TallyImport.handleImport(coId, xml);
    } catch (err) {
      throw new ApiError(400, err.message);
    }
    const totalImported = result.imported.groups.imported + result.imported.ledgers.imported + result.imported.vouchers.imported;
    const totalSkipped = result.imported.groups.skipped + result.imported.ledgers.skipped + result.imported.vouchers.skipped;
    await TallyConnector.logSync(coId, 'import', 'xml', 'import', 'synced',
      `imported ${totalImported}, skipped ${totalSkipped}, errors ${result.validation.errors.length}`);
    await audit(coId, user, 'tally.xml_import', 'tally', 'xml', {
      parsed: result.parsed, imported: result.imported, errors: result.validation.errors.length,
    });
    let mapping = null;
    try {
      const m = await TallyMapping.autoMap(coId);
      mapping = { updated: m.updated };
    } catch { /* mapping is best-effort; the import itself already succeeded */ }
    ok(res, { ...result, mapping });
  });

  r.get('/api/tally/mappings', async (req, res, p, user) => {
    ok(res, await TallyMapping.report(companyOf(user)));
  });

  r.post('/api/tally/mappings/auto', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const result = await TallyMapping.autoMap(coId);
    await audit(coId, user, 'tally.auto_map', 'tally', null, { updated: result.updated.length });
    await TallyConnector.logSync(coId, 'ledger', 'mapping', 'map', 'synced', `auto-mapped ${result.updated.length} vendor(s)`);
    ok(res, result);
  });

  r.post('/api/tally/mappings', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const { vendor_id, ledger_name } = req.body || {};
    if (!vendor_id) throw new ApiError(400, 'vendor_id required');
    const result = await TallyMapping.setMapping(coId, vendor_id, ledger_name);
    await audit(coId, user, 'tally.mapping_set', 'vendor', vendor_id, { ledger_name: result.ledger_name });
    ok(res, result);
  });

  r.post('/api/tally/retry/:id', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const log = await get('SELECT * FROM tally_sync_logs WHERE id = ? AND company_id = ?', [p.id, companyOf(user)]);
    if (!log) throw new ApiError(404, 'sync log not found');
    await update('tally_sync_logs', log.id, { status: 'queued', error: null, queued_at: nowIso() });
    setTimeout(async () => {
      await run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE id=?", [nowIso(), log.id]);
      await TallyConnector.heartbeat(companyOf(user));
    }, 1000);
    ok(res, { retried: true });
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
    const row = await get('SELECT settings FROM companies WHERE id = ?', [companyOf(user)]);
    ok(res, JSON.parse(row.settings || '{}'));
  });

  r.put('/api/settings', async (req, res, p, user) => {
    requireRole(user, ['cfo']);
    const coId = companyOf(user);
    const current = JSON.parse((await get('SELECT settings FROM companies WHERE id = ?', [coId])).settings || '{}');
    const next = { ...current, ...(req.body || {}) };
    await update('companies', coId, { settings: JSON.stringify(next) });
    await audit(coId, user, 'settings.updated', 'company', coId, next);
    ok(res, next);
  });

  r.get('/api/metrics', async (req, res, p, user) => {
    const coId = companyOf(user);
    const score = await recon.score(coId);
    const completedPayments = await all(`SELECT * FROM payments WHERE company_id = ? AND status = 'completed' AND processed_at IS NOT NULL ORDER BY processed_at DESC LIMIT 30`, [coId]);
    // engine-agnostic: first invoice id per payment -> received date
    const firstInvIds = completedPayments.map(p => { try { return JSON.parse(p.invoice_ids || '[]')[0] || null; } catch { return null; } }).filter(Boolean);
    let invDateMap = {};
    if (firstInvIds.length) {
      invDateMap = Object.fromEntries((await all(`SELECT id, invoice_date FROM invoices WHERE id IN (${firstInvIds.map(() => '?').join(',')})`, firstInvIds)).map(i => [i.id, i.invoice_date]));
    }
    const completed = completedPayments.map(p => {
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
    const bankAccounts = (await all('SELECT source, COUNT(*) AS c FROM bank_accounts WHERE company_id = ? GROUP BY source', [coId])).map(r => ({ source: r.source, count: r.c }));
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

  return r;
}

async function runThreeWay(coId, invoiceId) {
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [invoiceId, coId]);
  if (!inv) throw new ApiError(404, 'invoice not found');
  let result;
  if (!inv.purchase_order_no) {
    result = { status: 'none', detail: 'No PO reference in Tally for this invoice' };
  } else if (!inv.receipt_note_no) {
    result = { status: 'pending', detail: `PO ${inv.purchase_order_no} found; awaiting receipt note` };
  } else {
    // deterministic: Apex Steel invoice carries a quantity mismatch in the demo
    const vendor = inv.vendor_id ? await get('SELECT name FROM vendors WHERE id = ?', [inv.vendor_id]) : null;
    const mismatch = vendor && vendor.name.includes('Apex');
    result = mismatch
      ? { status: 'mismatch', detail: `Qty variance vs receipt ${inv.receipt_note_no}; flagged for review` }
      : { status: 'matched', detail: `PO ${inv.purchase_order_no} ↔ RN ${inv.receipt_note_no} ✓` };
  }
  await update('invoices', invoiceId, { three_way_match: result.status });
  await audit(coId, null, 'invoice.three_way_match', 'invoice', invoiceId, result);
  return result;
}

module.exports = { createRouter, ok, Router };
