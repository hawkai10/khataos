'use strict';

// Cash & banks domain (Fastify plugin): bank accounts, cash views, AA consent,
// bank data refresh and Decentro connected-banking integration.

const { all, get, insert, withTransaction, T } = require('../db');
const { eq, and } = require('drizzle-orm');
const { uid, nowIso, todayStr } = require('../util');
const { Money } = require('../money');
const { ApiError, audit } = require('../auth');
const { BankDataProvider, TallyConnector } = require('../adapters');
const Decentro = require('../decentro');
const recon = require('../recon');
const Cash = require('../services/cash');
const { bodyOf, requireBodyFields } = require('./validators');
const { companyOf, parseUrl, queryParam, queryInt, rupees, publicizeRows } = require('./helpers');

async function register(fastify) {
  fastify.get('/api/banks', async (request, reply) => {
    reply.ok(await all('SELECT code, name, kind, aa_supported FROM banks ORDER BY name'));
  });

  fastify.get('/api/cash/accounts', async (request, reply) => {
    const coId = companyOf(request.user);
    const rows = await Cash.listBankAccounts(coId);
    const out = [];
    for (const a of rows) {
      const balance = await Cash.closingBalance(a.id);
      const unc = await Cash.accountUncleared(a.id);
      out.push({ ...a, balance: rupees(balance), uncleared: rupees(unc), source_label: a.source === 'aa' ? 'Account Aggregator' : 'Direct API' });
    }
    reply.ok(out);
  });

  fastify.get('/api/cash/overview', async (request, reply) => {
    const coId = companyOf(request.user);
    const rows = await Cash.listBankAccounts(coId, '');
    const accounts = await Promise.all(rows.map(async (a) => {
      const balance = await Cash.closingBalance(a.id);
      return { id: a.id, account_name: a.account_name, bank_name: a.bank_name, account_number: a.account_number, balance: rupees(balance), source: a.source };
    }));
    const total = Money.sum(accounts.map((a) => Money.fromRupees(a.balance)));
    const uncleared = rupees(await Cash.totalUncleared(coId));
    const week = await Cash.recentTransactions(coId, 7);
    reply.ok({ accounts, total_available: total.toRupees(), uncleared, last_synced_at: await Cash.lastBankSync(coId), week: publicizeRows(week, 'bank_transactions') });
  });

  fastify.get('/api/cash/transactions', async (request, reply) => {
    const coId = companyOf(request.user);
    const u = parseUrl(request);
    const account = queryParam(u, 'account') || '';
    const days = queryInt(u, 'days', 7);
    reply.ok(publicizeRows(await Cash.recentTransactions(coId, days, account || null), 'bank_transactions'));
  });

  fastify.get('/api/cash/trend', async (request, reply) => {
    const coId = companyOf(request.user);
    const u = parseUrl(request);
    const days = queryInt(u, 'days', 30);
    reply.ok((await Cash.cashTrend(coId, days)).map((r) => ({ ...r, balance: rupees(r.balance) })));
  });

  fastify.post('/api/aa/consent/start', async (request, reply) => {
    const user = request.user;
    const { bank_code, account_number } = requireBodyFields(bodyOf(request), { bank_code: 'bank_code', account_number: 'account_number' });
    const bank = await get('SELECT * FROM banks WHERE code = ?', [bank_code]);
    if (!bank) throw new ApiError(400, 'unknown bank');
    const consent = BankDataProvider.startConsent(companyOf(user), bank_code, account_number);
    await audit(companyOf(user), user, 'aa.consent_start', 'bank', bank_code, { bank: bank.name });
    reply.ok(consent);
  });

  fastify.post('/api/aa/consent/verify', async (request, reply) => {
    const user = request.user;
    const { consent_id, otp } = bodyOf(request);
    const approved = BankDataProvider.verifyConsent(consent_id, otp);
    const c = approved; // {consentId, status...}
    const consentMeta = await get('SELECT * FROM banks WHERE code = ?', [request.body.bank_code || '']);
    const accountId = uid('acc');
    const accNum = request.body.account_number || String(Math.floor(Math.random() * 90000000000) + 10000000000);
    await insert('bank_accounts', {
      id: accountId, company_id: companyOf(user), bank_code: request.body.bank_code || 'ICIC',
      account_name: `${consentMeta ? consentMeta.name : 'New Bank'} Current - New`, account_number: accNum,
      type: 'current', ifsc: consentMeta && consentMeta.code === 'ICIC' ? 'ICIC0000022' : 'HDFC0001234',
      status: 'active', source: 'aa', consent_id: consent_id,
      opened_at: todayStr(),
    });
    const account = await get('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
    await BankDataProvider.fetchTransactions(companyOf(user), { ...account, opening_balance: Number(Money.fromRupees(1500000 + Math.floor(Math.random() * 500000)).toPaise()) });
    await withTransaction(async (tx) => {
      await tx.update(T.onboarding_steps).set({ status: 'done', at: nowIso() }).where(and(eq(T.onboarding_steps.company_id, companyOf(user)), eq(T.onboarding_steps.step, 'connect_bank')));
      await audit(companyOf(user), user, 'aa.consent_approved', 'bank_account', accountId, { consent: consent_id }, tx);
    });
    reply.ok({ consent: approved, account });
  });

  fastify.post('/api/cash/refresh', async (request, reply) => {
    const coId = companyOf(request.user);
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
      // Each account's statement ingestion is one transaction — a failure can't
      // leave a half-imported statement for a single account.
      added += await withTransaction(async (tx) => {
        let n = 0;
        for (const t of txns) {
          const exists = (await tx.select({ id: T.bank_transactions.id }).from(T.bank_transactions).where(and(eq(T.bank_transactions.account_id, a.id), eq(T.bank_transactions.external_id, t.external_id))).limit(1))[0];
          if (exists) continue;
          await tx.insert(T.bank_transactions).values({
            id: uid('btx'), company_id: coId, account_id: a.id, external_id: t.external_id,
            txn_date: t.txn_date, value_date: t.value_date, amount: t.amount,
            balance_after: t.balance_after, description: t.description, mode: t.mode,
            ref_no: t.ref_no, status: t.status, raw_json: JSON.stringify(t), created_at: nowIso(),
          });
          n++;
        }
        return n;
      });
    }
    const stats = await recon.matchAll(coId);
    const voucherMatched = await recon.autoVoucherMatch(coId, 7);
    await TallyConnector.heartbeat(coId);
    reply.ok({ added_transactions: added, decentro_transactions: decentroAdded, decentro_accounts: decentroAccounts.length, skipped_accounts: skipped, voucher_matched: voucherMatched, recon: stats });
  });

  // ---- Decentro Connected Banking (real bank data API) ----
  fastify.get('/api/integrations/decentro/status', async (request, reply) => {
    reply.ok(Decentro.config());
  });

  fastify.post('/api/decentro/link', async (request, reply) => {
    const coId = companyOf(request.user);
    const b = requireBodyFields(bodyOf(request), { account_number: 'account_number' });
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
    await withTransaction(async (tx) => {
      await tx.insert(T.decentro_links).values({
        id: linkId, company_id: coId, account_number: b.account_number,
        mobile: b.mobile || null, customer_id: b.customer_id || null,
        bank_code: b.bank_code || (b.ifsc ? b.ifsc.toUpperCase().slice(0, 4) : null),
        status: result.redirect_url ? 'pending' : 'failed',
        decentro_txn_id: result.decentroTxnId || null,
        redirect_url: result.redirect_url,
        last_error: result.redirect_url ? null : (result.message || 'no redirect url returned'),
        created_at: nowIso(),
      });
      await audit(coId, request.user, 'bank.link_initiated', 'bank', b.account_number, { provider: 'decentro', decentro_status: result.status, response_code: result.responseCode }, tx);
    });

    if (!result.redirect_url) {
      throw new ApiError(502, `Decentro did not return a redirect URL (${result.message || result.status || 'unknown'}) — account may already be linked; check link status instead.`);
    }
    reply.ok({
      link_id: linkId, redirect_url: result.redirect_url,
      decentroTxnId: result.decentroTxnId, message: result.message,
      note: 'Open the redirect URL in a new tab, approve the connected-banking consent on your netbanking portal, then confirm here. KhataOS also auto-completes via Decentro\'s Account Linkage Status Callback.',
    });
  });

  fastify.post('/api/decentro/link/status', async (request, reply) => {
    const coId = companyOf(request.user);
    const b = bodyOf(request);
    if (!Decentro.enabled()) throw new ApiError(503, 'Decentro not configured');
    const linkRow = b.link_id
      ? await get('SELECT * FROM decentro_links WHERE id = ? AND company_id = ?', [b.link_id, coId])
      : await get('SELECT * FROM decentro_links WHERE account_number = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1', [b.account_number, coId]);
    if (!linkRow) throw new ApiError(404, 'no pending Decentro link for this account');
    if (linkRow.status === 'linked') {
      const account = await get('SELECT * FROM bank_accounts WHERE company_id = ? AND account_number = ?', [coId, linkRow.account_number]);
      return reply.ok({ status: 'linked', account });
    }

    const poll = await Decentro.checkLinkStatus(linkRow.account_number, b.mobile || linkRow.mobile);
    const s = String(poll.status || '').toUpperCase();
    const linked = s === 'SUCCESS' || s.includes('LINKED') || s.includes('REGISTERED') || s === 'ACTIVE';
    if (linked) {
      const finalized = await Decentro.finalizeLink(coId, linkRow.account_number, {
        name: b.name, ifsc: b.ifsc, bank_code: linkRow.bank_code,
      });
      await recon.matchAll(coId);
      await withTransaction(async (tx) => {
        await tx.update(T.onboarding_steps).set({ status: 'done', at: nowIso() }).where(and(eq(T.onboarding_steps.company_id, coId), eq(T.onboarding_steps.step, 'connect_bank')));
        await audit(coId, request.user, 'bank.linked_decentro', 'bank_account', finalized.account.id, { account_number: linkRow.account_number, via: 'status_poll' }, tx);
      });
      reply.ok({ status: 'linked', account: finalized.account, transactions_pulled: finalized.pulled.inserted, present_balance: rupees(finalized.pulled.present_balance) });
    } else {
      reply.ok({ status: String(poll.status || 'PENDING'), message: poll.message || 'still awaiting approval on the bank portal' });
    }
  });

  // Decentro -> KhataOS webhook: Account Linkage Status Callback.
  // Always responds 200 so Decentro doesn't retry; ignores unknown tenants.
  fastify.post('/api/decentro/webhook', async (request, reply) => {
    const b = bodyOf(request);
    const accountNumber = b.account_number || b.accountNumber || (b.data && (b.data.account_number || b.data.accountNumber));
    const status = String(b.status || (b.data && b.data.status) || '').toUpperCase();
    if (!accountNumber || !Decentro.enabled()) {
      return reply.ok({ ok: true, ignored: true, reason: !accountNumber ? 'no account_number' : 'provider not configured' });
    }
    const linkRow = await get('SELECT * FROM decentro_links WHERE account_number = ? ORDER BY created_at DESC LIMIT 1', [accountNumber]);
    const coId = linkRow ? linkRow.company_id : ((await get('SELECT COUNT(*) AS c FROM companies')).c === 1 ? (await get('SELECT id FROM companies LIMIT 1')).id : null);
    if (!coId) {
      return reply.ok({ ok: true, ignored: true, reason: 'no matching tenant for account ' + accountNumber });
    }
    const linked = status.includes('SUCCESS') || status.includes('LINKED') || status.includes('REGISTERED') || status.includes('ACTIVE');
    if (linked) {
      const finalized = await Decentro.finalizeLink(coId, accountNumber, { bank_code: linkRow ? linkRow.bank_code : null });
      await recon.matchAll(coId);
      await withTransaction(async (tx) => {
        await tx.update(T.onboarding_steps).set({ status: 'done', at: nowIso() }).where(and(eq(T.onboarding_steps.company_id, coId), eq(T.onboarding_steps.step, 'connect_bank')));
        await audit(coId, null, 'bank.linked_decentro_webhook', 'bank_account', finalized.account.id, { account_number: accountNumber, status }, tx);
      });
      reply.ok({ ok: true, linked: true, account_id: finalized.account.id, transactions_pulled: finalized.pulled.inserted });
    } else {
      await withTransaction(async (tx) => {
        if (linkRow) await tx.update(T.decentro_links).set({ status: 'failed', last_error: String(status || b.status || '').slice(0, 200) }).where(eq(T.decentro_links.id, linkRow.id));
        await audit(coId, null, 'bank.link_rejected', 'bank', accountNumber, { status }, tx);
      });
      reply.ok({ ok: true, linked: false, status });
    }
  });

  fastify.post('/api/decentro/refresh', async (request, reply) => {
    const coId = companyOf(request.user);
    if (!Decentro.enabled()) throw new ApiError(503, 'Decentro not configured');
    const accounts = await all(`SELECT * FROM bank_accounts WHERE company_id = ? AND source = 'decentro' AND status = 'active'`, [coId]);
    let inserted = 0;
    for (const a of accounts) inserted += (await Decentro.pull(coId, a, { recentOnly: true })).inserted;
    const stats = await recon.matchAll(coId);
    reply.ok({ accounts: accounts.length, inserted, recon: stats });
  });
}

module.exports = { register };
