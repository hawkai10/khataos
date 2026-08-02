'use strict';

const { all, get, insert, run, update } = require('./db');
const { uid, nowIso, todayStr, daysAgo, daysAhead, addDays, inr, formatINR } = require('./util');
const { ApiError, login, logout, requireAuth, requireRole, audit, recentAudit, publicUser } = require('./auth');
const { queue, BankDataProvider, PaymentGateway, TallyConnector, OcrEngine, GstDataProvider, EmailInbox, createApprovalChain } = require('./adapters');
const recon = require('./recon');

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
    ok(res, login(email, password));
  });

  r.post('/api/auth/logout', async (req, res) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (token) logout(token);
    ok(res, { loggedOut: true });
  });

  r.get('/api/me', async (req, res, p, user) => {
    ok(res, publicUser(user));
  });

  r.get('/api/users', async (req, res, p, user) => {
    requireRole(user, ['cfo']);
    ok(res, all('SELECT id, name, email, role, department, last_login_at FROM users WHERE company_id = ? ORDER BY role', [companyOf(user)]));
  });

  r.get('/api/audit', async (req, res, p, user) => {
    ok(res, recentAudit(companyOf(user), 100));
  });

  // ===================== CASH & BANKS =====================
  r.get('/api/banks', async (req, res, p, user) => {
    ok(res, all('SELECT code, name, kind, aa_supported FROM banks ORDER BY name'));
  });

  r.get('/api/cash/accounts', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = all(`SELECT ba.*, b.name AS bank_name FROM bank_accounts ba JOIN banks b ON b.code = ba.bank_code WHERE ba.company_id = ? ORDER BY ba.account_name`, [coId]);
    const out = [];
    for (const a of rows) {
      const last = get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [a.id]);
      const unc = get(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE account_id = ? AND status = 'uncleared' AND amount > 0`, [a.id]);
      out.push({ ...a, balance: last ? last.closing_balance : 0, uncleared: unc.u || 0, source_label: a.source === 'aa' ? 'Account Aggregator' : 'Direct API' });
    }
    ok(res, out);
  });

  r.get('/api/cash/overview', async (req, res, p, user) => {
    const coId = companyOf(user);
    const accounts = await (async () => {
      const rows = all(`SELECT ba.*, b.name AS bank_name FROM bank_accounts ba JOIN banks b ON b.code = ba.bank_code WHERE ba.company_id = ?`, [coId]);
      return rows.map(a => {
        const last = get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [a.id]);
        return { id: a.id, account_name: a.account_name, bank_name: a.bank_name, account_number: a.account_number, balance: last ? last.closing_balance : 0, source: a.source };
      });
    })();
    const total = inr(accounts.reduce((s, a) => s + a.balance, 0));
    const uncleared = inr(all(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE company_id = ? AND status='uncleared' AND amount > 0`, [coId])[0].u);
    const week = all(`SELECT * FROM bank_transactions WHERE company_id = ? AND txn_date >= ? ORDER BY txn_date DESC, id DESC`, [coId, daysAgo(6)]);
    ok(res, { accounts, total_available: total, uncleared, last_synced_at: get('SELECT MAX(last_synced_at) AS t FROM bank_accounts WHERE company_id = ?', [coId]).t });
  });

  r.get('/api/cash/transactions', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const account = u.searchParams.get('account') || '';
    const days = parseInt(u.searchParams.get('days') || '7', 10);
    const rows = account
      ? all(`SELECT t.*, a.account_name, b.name AS bank_name FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code WHERE t.company_id = ? AND t.account_id = ? AND t.txn_date >= ? ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, [coId, account, daysAgo(days - 1)])
      : all(`SELECT t.*, a.account_name, b.name AS bank_name FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code WHERE t.company_id = ? AND t.txn_date >= ? ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, [coId, daysAgo(days - 1)]);
    ok(res, rows);
  });

  r.get('/api/cash/trend', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const days = parseInt(u.searchParams.get('days') || '30', 10);
    const rows = all(`SELECT date, SUM(closing_balance) AS balance FROM cash_daily WHERE company_id = ? AND date >= ? GROUP BY date ORDER BY date`, [coId, daysAgo(days - 1)]);
    ok(res, rows);
  });

  r.post('/api/aa/consent/start', async (req, res, p, user) => {
    const { bank_code, account_number } = req.body || {};
    if (!bank_code || !account_number) throw new ApiError(400, 'bank_code and account_number required');
    const bank = get('SELECT * FROM banks WHERE code = ?', [bank_code]);
    if (!bank) throw new ApiError(400, 'unknown bank');
    const consent = BankDataProvider.startConsent(companyOf(user), bank_code, account_number);
    audit(companyOf(user), user, 'aa.consent_start', 'bank', bank_code, { bank: bank.name });
    ok(res, consent);
  });

  r.post('/api/aa/consent/verify', async (req, res, p, user) => {
    const { consent_id, otp } = req.body || {};
    const approved = BankDataProvider.verifyConsent(consent_id, otp);
    const c = approved; // {consentId, status...}
    const consentMeta = get('SELECT * FROM banks WHERE code = ?', [req.body.bank_code || '']);
    const accountId = uid('acc');
    const accNum = req.body.account_number || String(Math.floor(Math.random() * 90000000000) + 10000000000);
    insert('bank_accounts', {
      id: accountId, company_id: companyOf(user), bank_code: req.body.bank_code || 'ICIC',
      account_name: `${consentMeta ? consentMeta.name : 'New Bank'} Current - New`, account_number: accNum,
      type: 'current', ifsc: consentMeta && consentMeta.code === 'ICIC' ? 'ICIC0000022' : 'HDFC0001234',
      status: 'active', source: 'aa', consent_id: consent_id,
      opened_at: todayStr(),
    });
    const account = get('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
    BankDataProvider.fetchTransactions(companyOf(user), { ...account, opening_balance: 1500000 + Math.floor(Math.random() * 500000) });
    run(`UPDATE onboarding_steps SET status='done', at=? WHERE company_id=? AND step='connect_bank'`, [nowIso(), companyOf(user)]);
    audit(companyOf(user), user, 'aa.consent_approved', 'bank_account', accountId, { consent: consent_id });
    ok(res, { consent: approved, account });
  });

  r.post('/api/cash/refresh', async (req, res, p, user) => {
    const coId = companyOf(user);
    const accounts = all('SELECT * FROM bank_accounts WHERE company_id = ? AND status = \'active\'', [coId]);
    let added = 0;
    for (const a of accounts) {
      const txns = BankDataProvider.refresh(coId, a);
      for (const t of txns) {
        const exists = get('SELECT id FROM bank_transactions WHERE account_id = ? AND external_id = ?', [a.id, t.external_id]);
        if (exists) continue;
        insert('bank_transactions', {
          id: uid('btx'), company_id: coId, account_id: a.id, external_id: t.external_id,
          txn_date: t.txn_date, value_date: t.value_date, amount: t.amount,
          balance_after: t.balance_after, description: t.description, mode: t.mode,
          ref_no: t.ref_no, status: t.status, raw_json: JSON.stringify(t), created_at: nowIso(),
        });
        added++;
      }
    }
    const stats = recon.matchAll(coId);
    TallyConnector.heartbeat(coId);
    ok(res, { added_transactions: added, recon: stats });
  });

  // ===================== AP / INVOICES =====================
  r.get('/api/vendors', async (req, res, p, user) => {
    ok(res, all('SELECT * FROM vendors WHERE company_id = ? AND active = 1 ORDER BY name', [companyOf(user)]));
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
    const rows = all(`SELECT i.*, v.name AS vendor_name, v.gstin AS vendor_gstin FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT 200`, args);
    ok(res, rows);
  });

  r.get('/api/invoices/:id', async (req, res, p, user) => {
    const inv = get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, companyOf(user)]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    const vendor = inv.vendor_id ? get('SELECT * FROM vendors WHERE id = ?', [inv.vendor_id]) : null;
    const lines = all('SELECT * FROM invoice_lines WHERE invoice_id = ?', [inv.id]);
    const approvals = all('SELECT * FROM approvals WHERE invoice_id = ? ORDER BY level', [inv.id]);
    const payments = all('SELECT * FROM payments WHERE company_id = ? AND invoice_ids LIKE ?', [companyOf(user), '%' + inv.id + '%']);
    ok(res, { ...inv, vendor, lines, approvals, payments });
  });

  r.post('/api/invoices/ocr-preview', async (req, res, p, user) => {
    const text = (req.body || {}).text || OcrEngine.sampleEmail('cement').body;
    ok(res, OcrEngine.extract(text));
  });

  r.post('/api/invoices/email-sim', async (req, res, p, user) => {
    const template = (req.body || {}).template || 'cement';
    const mail = OcrEngine.sampleEmail(template);
    const invoice = EmailInbox.forward(companyOf(user), mail.from, mail.subject, mail.body);
    const poMatch = mail.body.match(/PO-\d+/);
    if (poMatch) {
      update('invoices', invoice.id, { purchase_order_no: poMatch[0] });
      invoice.purchase_order_no = poMatch[0];
    }
    const twm = runThreeWay(companyOf(user), invoice.id);
    audit(companyOf(user), user, 'invoice.captured', 'invoice', invoice.id, { source: 'email_sim', invoice_no: invoice.invoice_no });
    ok(res, { invoice: get('SELECT * FROM invoices WHERE id = ?', [invoice.id]), ocr: JSON.parse(invoice.ocr_json), three_way_match: twm });
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
    const vendor = fields.vendor_id ? get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [fields.vendor_id, coId]) : null;
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
    insert('invoices', {
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
        insert('invoice_lines', { id: uid('l'), invoice_id: invId, hsn: l.hsn, description: l.description, qty: l.qty || 1, rate: l.rate || 0, taxable: l.taxable || 0, cgst: l.cgst || 0, sgst: l.sgst || 0, igst: l.igst || 0, cess: 0 });
      }
    }
    createApprovalChain(coId, invId);
    audit(coId, user, 'invoice.captured', 'invoice', invId, { source, invoice_no: fields.invoice_no });
    ok(res, get('SELECT * FROM invoices WHERE id = ?', [invId]));
  });

  r.post('/api/invoices/:id/three-way-match', async (req, res, p, user) => {
    const result = runThreeWay(companyOf(user), p.id);
    ok(res, result);
  });

  r.post('/api/invoices/:id/approve', async (req, res, p, user) => {
    const coId = companyOf(user);
    const inv = get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    const pending = get(`SELECT * FROM approvals WHERE invoice_id = ? AND status = 'pending' AND required_role = ? ORDER BY level LIMIT 1`, [p.id, user.role]);
    if (!pending) {
      const anyPending = get(`SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ? AND status = 'pending'`, [p.id]);
      if (anyPending.c > 0) throw new ApiError(403, `This approval level requires ${(get(`SELECT required_role FROM approvals WHERE invoice_id = ? AND status='pending' ORDER BY level LIMIT 1`, [p.id]) || {}).required_role}`);
      throw new ApiError(409, 'invoice already fully approved');
    }
    update('approvals', pending.id, { status: 'approved', approver_id: user.id, approver_name: user.name, comment: (req.body || {}).comment || null, decided_at: nowIso() });
    const remaining = get(`SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ? AND status = 'pending'`, [p.id]);
    if (remaining.c === 0) {
      update('invoices', p.id, { status: 'approved', approved_by: user.id, approved_at: nowIso() });
      queue.enqueue(coId, 'tally.syncVoucher', { invoiceId: p.id });
    }
    audit(coId, user, 'invoice.approved', 'invoice', p.id, { invoice_no: inv.invoice_no, level: pending.level });
    ok(res, get('SELECT * FROM invoices WHERE id = ?', [p.id]));
  });

  r.post('/api/invoices/:id/reject', async (req, res, p, user) => {
    const coId = companyOf(user);
    const inv = get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    update('invoices', p.id, { status: 'rejected' });
    run(`UPDATE approvals SET status='rejected', approver_id=?, approver_name=?, decided_at=? WHERE invoice_id=? AND status='pending'`, [user.id, user.name, nowIso(), p.id]);
    audit(coId, user, 'invoice.rejected', 'invoice', p.id, { invoice_no: inv.invoice_no, comment: (req.body || {}).comment });
    ok(res, get('SELECT * FROM invoices WHERE id = ?', [p.id]));
  });

  r.get('/api/approvals/pending', async (req, res, p, user) => {
    const rows = all(`SELECT a.*, i.invoice_no, i.gross_amount, i.invoice_date, i.due_date, v.name AS vendor_name
      FROM approvals a JOIN invoices i ON i.id = a.invoice_id LEFT JOIN vendors v ON v.id = i.vendor_id
      WHERE a.company_id = ? AND a.status = 'pending' AND a.required_role = ?
      ORDER BY i.due_date ASC`, [companyOf(user), user.role]);
    ok(res, rows);
  });

  // ===================== DASHBOARD =====================
  r.get('/api/dashboard', async (req, res, p, user) => {
    const coId = companyOf(user);
    const accounts = all('SELECT * FROM bank_accounts WHERE company_id = ?', [coId]);
    let available = 0, uncleared = 0;
    for (const a of accounts) {
      const last = get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [a.id]);
      available += last ? last.closing_balance : 0;
    }
    uncleared = inr(all(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE company_id = ? AND status='uncleared' AND amount > 0`, [coId])[0].u);
    available = inr(available);

    const today = todayStr();
    const due = all(`SELECT * FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled','pending_approval') AND due_date >= ? AND due_date <= ? ORDER BY due_date`, [coId, today, daysAhead(7)]);
    const overdue = all(`SELECT * FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled') AND due_date < ? ORDER BY due_date`, [coId, today]);
    const dueAmount = inr(due.reduce((s, i) => s + i.net_payable, 0));
    const overdueAmount = inr(overdue.reduce((s, i) => s + i.net_payable, 0));

    const snap = get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
    const gstLiability = inr(all(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled')`, [coId])[0].s);
    const mismatches = get(`SELECT COUNT(*) AS c FROM gst_mismatches WHERE company_id = ? AND status = 'open'`, [coId]).c;

    const outflows = all(`SELECT COALESCE(SUM(amount),0) AS s FROM bank_transactions WHERE company_id = ? AND amount < 0 AND txn_date >= ?`, [coId, daysAgo(89)]);
    const monthlyBurn = inr(Math.abs(outflows[0].s) / 3);
    const runwayMonths = monthlyBurn > 0 ? inr(available / monthlyBurn) : null;

    const reconScore = recon.score(coId);
    const tally = TallyConnector.health(coId);
    const trend = all(`SELECT date, SUM(closing_balance) AS balance FROM cash_daily WHERE company_id = ? AND date >= ? GROUP BY date ORDER BY date`, [coId, daysAgo(29)]);

    ok(res, {
      cash: { available, uncleared, accounts: accounts.length, runway_months: runwayMonths, monthly_burn: monthlyBurn },
      payments: { due_this_week: { count: due.length, amount: dueAmount }, overdue: { count: overdue.length, amount: overdueAmount } },
      gst: { itc: snap ? snap.total_itc : 0, liability: gstLiability, open_mismatches: mismatches },
      recon: reconScore,
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
    const rows = all(`SELECT p.*, v.name AS vendor_name,
      (SELECT GROUP_CONCAT(invoice_no) FROM invoices WHERE id IN (SELECT value FROM json_each('[' || REPLACE(p.invoice_ids, ',', ',') || ']') JOIN invoices i ON i.id = value)) AS invoice_refs
      FROM payments p LEFT JOIN vendors v ON v.id = p.vendor_id
      WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 200`, args);
    ok(res, rows);
  });

  r.get('/api/payments/:id', async (req, res, p, user) => {
    const row = get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [p.id, companyOf(user)]);
    if (!row) throw new ApiError(404, 'payment not found');
    ok(res, row);
  });

  r.post('/api/payments', async (req, res, p, user) => {
    const coId = companyOf(user);
    const b = req.body || {};
    if (!b.vendor_id || !Array.isArray(b.invoice_ids) || !b.invoice_ids.length) throw new ApiError(400, 'vendor_id and invoice_ids required');
    const vendor = get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [b.vendor_id, coId]);
    if (!vendor) throw new ApiError(404, 'vendor not found');
    const invoices = b.invoice_ids.map(id => get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId])).filter(Boolean);
    if (!invoices.length) throw new ApiError(400, 'no valid invoices');
    const mode = b.mode || 'NEFT';
    if (!['UPI', 'IMPS', 'NEFT', 'RTGS'].includes(mode)) throw new ApiError(400, 'invalid mode');
    const amount = inr(invoices.reduce((s, i) => s + i.gross_amount, 0));
    const tds = inr(invoices.reduce((s, i) => s + (i.tds_amount || 0), 0));
    const net = inr(amount - tds);
    const settings = JSON.parse(get('SELECT settings FROM companies WHERE id = ?', [coId]).settings || '{}');
    const payThreshold = settings.payment_approval_threshold || 500000;
    const needsApproval = amount > payThreshold;
    const payId = uid('pay');
    insert('payments', {
      id: payId, company_id: coId, vendor_id: vendor.id,
      invoice_ids: invoices.map(i => i.id).join(','),
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
    run(`UPDATE invoices SET status = ? WHERE id IN (${invoices.map(() => '?').join(',')})`, [invStatus, ...invoices.map(i => i.id)]);
    if (!needsApproval) {
      PaymentGateway.createBatch(coId, [get('SELECT * FROM payments WHERE id = ?', [payId])]);
    }
    audit(coId, user, 'payment.created', 'payment', payId, { amount, mode, needs_approval: needsApproval });
    ok(res, get('SELECT * FROM payments WHERE id = ?', [payId]));
  });

  r.post('/api/payments/:id/approve', async (req, res, p, user) => {
    const coId = companyOf(user);
    const pay = get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!pay) throw new ApiError(404, 'payment not found');
    if (pay.status !== 'pending_approval') throw new ApiError(409, 'payment is not awaiting approval');
    const settings = JSON.parse(get('SELECT settings FROM companies WHERE id = ?', [coId]).settings || '{}');
    const threshold = settings.payment_approval_threshold || 500000;
    if (pay.amount > threshold) requireRole(user, ['cfo']);
    update('payments', p.id, { status: 'approved', approved_by: user.id });
    PaymentGateway.createBatch(coId, [pay]);
    audit(coId, user, 'payment.approved', 'payment', p.id, { amount: pay.amount });
    ok(res, get('SELECT * FROM payments WHERE id = ?', [p.id]));
  });

  r.post('/api/payments/:id/execute', async (req, res, p, user) => {
    const coId = companyOf(user);
    const pay = get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!pay) throw new ApiError(404, 'payment not found');
    if (!['approved', 'pending_approval'].includes(pay.status)) throw new ApiError(409, 'payment cannot be executed from current state');
    update('payments', p.id, { type: 'instant', status: 'approved', approved_by: user.id });
    PaymentGateway.createBatch(coId, [get('SELECT * FROM payments WHERE id = ?', [p.id])]);
    audit(coId, user, 'payment.executed', 'payment', p.id, { mode: pay.mode });
    ok(res, get('SELECT * FROM payments WHERE id = ?', [p.id]));
  });

  r.post('/api/payments/batch', async (req, res, p, user) => {
    const coId = companyOf(user);
    const items = (req.body || {}).items || [];
    if (!items.length) throw new ApiError(400, 'items required');
    const created = [];
    for (const item of items) {
      const vendor = get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [item.vendor_id, coId]);
      if (!vendor) continue;
      const invoices = (item.invoice_ids || []).map(id => get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId])).filter(Boolean);
      if (!invoices.length) continue;
      const amount = inr(invoices.reduce((s, i) => s + i.gross_amount, 0));
      const tds = inr(invoices.reduce((s, i) => s + (i.tds_amount || 0), 0));
      const payId = uid('pay');
      insert('payments', {
        id: payId, company_id: coId, vendor_id: vendor.id,
        invoice_ids: invoices.map(i => i.id).join(','),
        amount, mode: item.mode || 'NEFT', type: 'batch',
        status: 'approved', scheduled_date: item.scheduled_date || null,
        bank_account_id: item.account_id || null,
        reference: `${item.mode || 'NEFT'}-${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
        gateway: 'razorpayx', gst_ledger: vendor.ledger_name, tds_section: vendor.tds_section,
        tds_amount: tds, net_amount: inr(amount - tds),
        initiated_by: user.id, initiated_at: nowIso(), created_at: nowIso(),
      });
      const status = item.scheduled_date && item.scheduled_date > todayStr() ? 'scheduled' : 'approved';
      run(`UPDATE invoices SET status = ? WHERE id IN (${invoices.map(() => '?').join(',')})`, [status, ...invoices.map(i => i.id)]);
      created.push(payId);
    }
    const rows = all(`SELECT * FROM payments WHERE id IN (${created.map(() => '?').join(',')})`, created);
    PaymentGateway.createBatch(coId, rows);
    audit(coId, user, 'payment.batch_created', 'payment', null, { count: created.length });
    ok(res, rows);
  });

  // ===================== RECONCILIATION =====================
  r.get('/api/recon/summary', async (req, res, p, user) => {
    const coId = companyOf(user);
    const matches = all(`SELECT rm.*, bt.amount AS bank_amount, bt.txn_date, bt.description, p.reference AS payment_ref
      FROM recon_matches rm
      JOIN bank_transactions bt ON bt.id = rm.bank_txn_id
      LEFT JOIN payments p ON p.id = rm.payment_id
      WHERE rm.company_id = ? ORDER BY rm.matched_at DESC LIMIT 50`, [coId]);
    ok(res, { ...recon.score(coId), recent: matches });
  });

  r.get('/api/recon/unmatched', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = all(`SELECT t.*, a.account_name, b.name AS bank_name
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code
      WHERE t.company_id = ? AND t.matched = 0 AND t.status = 'posted' AND t.txn_date >= ?
      ORDER BY t.txn_date DESC LIMIT 100`, [coId, daysAgo(30)]);
    // suggest a payment candidate by amount for each unmatched debit
    const payments = all(`SELECT * FROM payments WHERE company_id = ? AND status IN ('completed','processing')`, [coId]);
    for (const t of rows) {
      const suggestion = payments.find(p => p.net_amount && Math.abs(Math.abs(t.amount) - p.net_amount) <= 1);
      t.suggested_payment = suggestion ? { id: suggestion.id, reference: suggestion.reference, vendor_id: suggestion.vendor_id, net_amount: suggestion.net_amount } : null;
    }
    ok(res, rows);
  });

  r.post('/api/recon/run', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const stats = recon.matchAll(companyOf(user));
    audit(companyOf(user), user, 'recon.run', 'recon', null, stats);
    ok(res, { ...stats, score: recon.score(companyOf(user)) });
  });

  r.post('/api/recon/manual-match', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const b = req.body || {};
    const txn = get('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?', [b.bank_txn_id, coId]);
    if (!txn) throw new ApiError(404, 'transaction not found');
    const payment = b.payment_id ? get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [b.payment_id, coId]) : null;
    recon.markMatched(txn.id, payment ? payment.id : null, 'manual', 1, user.id);
    audit(coId, user, 'recon.manual_match', 'bank_transaction', txn.id, { payment_id: payment ? payment.id : null });
    ok(res, { matched: true });
  });

  r.post('/api/recon/unmatched/:id/voucher', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const txn = get('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!txn) throw new ApiError(404, 'transaction not found');
    const vno = 'PV-MAN-' + String(Date.now()).slice(-6);
    insert('recon_matches', {
      id: uid('rm'), company_id: coId, bank_txn_id: txn.id, payment_id: null,
      tally_voucher_no: vno, match_type: 'manual', confidence: 1, status: 'matched',
      matched_by: user.id, matched_at: nowIso(), notes: 'voucher created from unmatched transaction',
    });
    run('UPDATE bank_transactions SET matched = 1 WHERE id = ?', [txn.id]);
    TallyConnector.logSync(coId, 'voucher', vno, 'create', 'synced');
    audit(coId, user, 'recon.voucher_created', 'bank_transaction', txn.id, { voucher: vno });
    ok(res, { voucher_no: vno });
  });

  // ===================== GST =====================
  r.get('/api/gst/summary', async (req, res, p, user) => {
    const coId = companyOf(user);
    const snap = get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
    const liability = inr(all(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled')`, [coId])[0].s);
    const committed = inr(all(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN ('approved','scheduled','pending_approval')`, [coId])[0].s);
    const mismatches = all(`SELECT * FROM gst_mismatches WHERE company_id = ? AND status = 'open' ORDER BY period DESC`, [coId]);
    const periods = all('SELECT period, MAX(fetched_at) AS fetched_at FROM gstr2b_snapshots WHERE company_id = ? GROUP BY period ORDER BY period DESC', [coId]);
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
    GstDataProvider.fetchGstr2b(coId, period);
    const mismatches = GstDataProvider.scanMismatches(coId, period);
    audit(coId, user, 'gst.refresh', 'gstr2b', period, { mismatches: mismatches.length });
    ok(res, { period, mismatches: mismatches.length });
  });

  r.get('/api/gst/export', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = new URL(req.url, 'http://x');
    const type = u.searchParams.get('type') || 'gstr3b';
    const period = u.searchParams.get('period') || GstDataProvider.currentPeriod();
    const csv = type === 'gstr2b'
      ? 'period,gstin,invoice_no,taxable,cgst,sgst,igst\n' + all(`SELECT * FROM gstr2b_snapshots WHERE company_id = ? AND period = ? LIMIT 1`, [coId, period]).map(() => '').join('')
      : 'field,amount\n' + GstDataProvider.exportGstr3b(coId, period);
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${type}_${period}.csv"` });
    res.end(csv);
  });

  // ===================== TALLY =====================
  r.get('/api/tally/health', async (req, res, p, user) => {
    ok(res, TallyConnector.health(companyOf(user)));
  });

  r.get('/api/tally/sync-logs', async (req, res, p, user) => {
    const rows = all('SELECT * FROM tally_sync_logs WHERE company_id = ? ORDER BY queued_at DESC LIMIT 100', [companyOf(user)]);
    ok(res, rows);
  });

  r.post('/api/tally/pull-ledgers', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    TallyConnector.logSync(coId, 'ledger', 'vendors', 'pull', 'queued');
    setTimeout(() => {
      run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE entity='ledger' AND status='queued'", [nowIso()]);
      TallyConnector.heartbeat(coId);
    }, 1200);
    audit(coId, user, 'tally.pull_ledgers', 'tally', null, {});
    ok(res, { queued: true });
  });

  r.post('/api/tally/retry/:id', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const log = get('SELECT * FROM tally_sync_logs WHERE id = ? AND company_id = ?', [p.id, companyOf(user)]);
    if (!log) throw new ApiError(404, 'sync log not found');
    update('tally_sync_logs', log.id, { status: 'queued', error: null, queued_at: nowIso() });
    setTimeout(() => {
      run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE id=?", [nowIso(), log.id]);
      TallyConnector.heartbeat(companyOf(user));
    }, 1000);
    ok(res, { retried: true });
  });

  // ===================== ONBOARDING =====================
  r.get('/api/onboarding', async (req, res, p, user) => {
    const coId = companyOf(user);
    const steps = all('SELECT * FROM onboarding_steps WHERE company_id = ? ORDER BY rowid', [coId]);
    ok(res, steps);
  });

  r.post('/api/onboarding/:step/complete', async (req, res, p, user) => {
    const coId = companyOf(user);
    const existing = get('SELECT * FROM onboarding_steps WHERE company_id = ? AND step = ?', [coId, p.step]);
    if (existing) update('onboarding_steps', { company_id: coId, step: p.step }, { status: 'done', detail: (req.body || {}).detail || existing.detail, at: nowIso() });
    else insert('onboarding_steps', { company_id: coId, step: p.step, status: 'done', detail: (req.body || {}).detail || null, at: nowIso() });
    ok(res, { step: p.step, status: 'done' });
  });

  // ===================== SETTINGS & METRICS =====================
  r.get('/api/settings', async (req, res, p, user) => {
    const row = get('SELECT settings FROM companies WHERE id = ?', [companyOf(user)]);
    ok(res, JSON.parse(row.settings || '{}'));
  });

  r.put('/api/settings', async (req, res, p, user) => {
    requireRole(user, ['cfo']);
    const coId = companyOf(user);
    const current = JSON.parse(get('SELECT settings FROM companies WHERE id = ?', [coId]).settings || '{}');
    const next = { ...current, ...(req.body || {}) };
    update('companies', coId, { settings: JSON.stringify(next) });
    audit(coId, user, 'settings.updated', 'company', coId, next);
    ok(res, next);
  });

  r.get('/api/metrics', async (req, res, p, user) => {
    const coId = companyOf(user);
    const score = recon.score(coId);
    const completed = all(`SELECT p.*, i.invoice_date FROM payments p JOIN invoices i ON i.id = (SELECT value FROM json_each('[' || REPLACE(p.invoice_ids, ',', ',') || ']') LIMIT 1)
      WHERE p.company_id = ? AND p.status = 'completed' AND p.processed_at IS NOT NULL ORDER BY p.processed_at DESC LIMIT 30`, [coId]);
    const cycleDays = completed.length ? inr(completed.reduce((s, p) => {
      const received = p.invoice_date || p.initiated_at.slice(0, 10);
      const processed = p.processed_at.slice(0, 10);
      return s + Math.max(0, Math.round((new Date(processed) - new Date(received)) / 86400000));
    }, 0) / completed.length) : null;
    const baseline = 11.2;
    const improvement = cycleDays != null ? inr(((baseline - cycleDays) / baseline) * 100) : null;
    const today = todayStr();
    const usage = get('SELECT * FROM usage_daily WHERE company_id = ? AND date = ?', [coId, today]);
    const dau = usage ? usage.dau : 0;
    const tally = TallyConnector.health(coId);
    ok(res, {
      customers: { paying: 12, pipeline: 21, target: 100, acv_inr: 300000, retention_6m: 92 },
      banks: { connected: 17, target: 15 },
      tally_uptime: tally.uptime_30d, target_uptime: 99.5,
      recon: { accuracy: score.accuracy, target: 70 },
      cycle: { avg_days: cycleDays, baseline_days: baseline, improvement_pct: improvement, target_pct: 50 },
      engagement: { dau, mau: 3, daumau_pct: inr((dau / 3) * 100), target_pct: 60 },
    });
  });

  return r;
}

function runThreeWay(coId, invoiceId) {
  const inv = get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [invoiceId, coId]);
  if (!inv) throw new ApiError(404, 'invoice not found');
  let result;
  if (!inv.purchase_order_no) {
    result = { status: 'none', detail: 'No PO reference in Tally for this invoice' };
  } else if (!inv.receipt_note_no) {
    result = { status: 'pending', detail: `PO ${inv.purchase_order_no} found; awaiting receipt note` };
  } else {
    // deterministic: Apex Steel invoice carries a quantity mismatch in the demo
    const vendor = inv.vendor_id ? get('SELECT name FROM vendors WHERE id = ?', [inv.vendor_id]) : null;
    const mismatch = vendor && vendor.name.includes('Apex');
    result = mismatch
      ? { status: 'mismatch', detail: `Qty variance vs receipt ${inv.receipt_note_no}; flagged for review` }
      : { status: 'matched', detail: `PO ${inv.purchase_order_no} ↔ RN ${inv.receipt_note_no} ✓` };
  }
  update('invoices', invoiceId, { three_way_match: result.status });
  audit(coId, null, 'invoice.three_way_match', 'invoice', invoiceId, result);
  return result;
}

module.exports = { createRouter, ok, Router };
