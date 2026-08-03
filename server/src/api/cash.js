'use strict';

// Cash & banks domain: bank accounts, cash views, AA consent, bank data
// refresh and Decentro connected-banking integration.

const { all, get, insert, run } = require('../db');
const { uid, nowIso, todayStr, inr } = require('../util');
const { ApiError, audit } = require('../auth');
const { BankDataProvider, TallyConnector } = require('../adapters');
const Decentro = require('../decentro');
const recon = require('../recon');
const Cash = require('../services/cash');
const { bodyOf, requireBodyFields } = require('./validators');
const { companyOf, parseUrl, queryParam, queryInt } = require('./helpers');

function register(r, deps) {
  const { ok } = deps;

  r.get('/api/banks', async (req, res, p, user) => {
    ok(res, await all('SELECT code, name, kind, aa_supported FROM banks ORDER BY name'));
  });

  r.get('/api/cash/accounts', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = await Cash.listBankAccounts(coId);
    const out = [];
    for (const a of rows) {
      const balance = await Cash.closingBalance(a.id);
      const unc = await Cash.accountUncleared(a.id);
      out.push({ ...a, balance, uncleared: unc, source_label: a.source === 'aa' ? 'Account Aggregator' : 'Direct API' });
    }
    ok(res, out);
  });

  r.get('/api/cash/overview', async (req, res, p, user) => {
    const coId = companyOf(user);
    const rows = await Cash.listBankAccounts(coId, '');
    const accounts = await Promise.all(rows.map(async (a) => {
      const balance = await Cash.closingBalance(a.id);
      return { id: a.id, account_name: a.account_name, bank_name: a.bank_name, account_number: a.account_number, balance, source: a.source };
    }));
    const total = inr(accounts.reduce((s, a) => s + a.balance, 0));
    const uncleared = await Cash.totalUncleared(coId);
    const week = await Cash.recentTransactions(coId, 7);
    ok(res, { accounts, total_available: total, uncleared, last_synced_at: await Cash.lastBankSync(coId) });
  });

  r.get('/api/cash/transactions', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = parseUrl(req);
    const account = queryParam(u, 'account') || '';
    const days = queryInt(u, 'days', 7);
    ok(res, await Cash.recentTransactions(coId, days, account || null));
  });

  r.get('/api/cash/trend', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = parseUrl(req);
    const days = queryInt(u, 'days', 30);
    ok(res, await Cash.cashTrend(coId, days));
  });

  r.post('/api/aa/consent/start', async (req, res, p, user) => {
    const { bank_code, account_number } = requireBodyFields(bodyOf(req), { bank_code: 'bank_code', account_number: 'account_number' });
    const bank = await get('SELECT * FROM banks WHERE code = ?', [bank_code]);
    if (!bank) throw new ApiError(400, 'unknown bank');
    const consent = BankDataProvider.startConsent(companyOf(user), bank_code, account_number);
    await audit(companyOf(user), user, 'aa.consent_start', 'bank', bank_code, { bank: bank.name });
    ok(res, consent);
  });

  r.post('/api/aa/consent/verify', async (req, res, p, user) => {
    const { consent_id, otp } = bodyOf(req);
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
    const accounts = await Cash.activeAccounts(coId);
    let added = 0, decentroAdded = 0, skipped = 0;
    const decentroAccounts = [];
    for (const a of accounts) {
      if (a.source === 'decentro') {
        if (Decentro.enabled()) {
          decentroAccounts.push(a);
          const result = await Decentro.pull(coId, a, { recentOnly: true });
          decentroAdded += result.inserted;
        } else skipped++;
        continue;
      }
      let txns;
      try {
        txns = await BankDataProvider.refresh(coId, a);
      } catch (err) {
        skipped++; // provider unconfigured or failed; never fabricate data
        continue;
      }
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
    ok(res, { added_transactions: added, decentro_transactions: decentroAdded, decentro_accounts: decentroAccounts.length, skipped_accounts: skipped, voucher_matched: voucherMatched, recon: stats });
  });

  // ---- Decentro Connected Banking (real bank data API) ----
  r.get('/api/integrations/decentro/status', async (req, res) => {
    ok(res, Decentro.config());
  });

  r.post('/api/decentro/link', async (req, res, p, user) => {
    const coId = companyOf(user);
    const b = requireBodyFields(bodyOf(req), { account_number: 'account_number' });
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
    const b = bodyOf(req);
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
  // Always responds 200 so Decentro doesn't retry; ignores unknown tenants.
  r.post('/api/decentro/webhook', async (req, res) => {
    const b = bodyOf(req);
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
    const accounts = await all(`SELECT * FROM bank_accounts WHERE company_id = ? AND source = 'decentro' AND status = 'active'`, [coId]);
    let inserted = 0;
    for (const a of accounts) inserted += (await Decentro.pull(coId, a, { recentOnly: true })).inserted;
    const stats = await recon.matchAll(coId);
    ok(res, { accounts: accounts.length, inserted, recon: stats });
  });
}

module.exports = { register };
