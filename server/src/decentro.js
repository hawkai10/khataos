'use strict';

// ============================================================================
// Decentro Connected Banking adapter (real API).
//
// Module: Business Accounts (Connected Banking) — fetch balance and statement
// for linked bank accounts.
//
//   Balance   GET /v2/banking/account/{accountNumber}/balance
//   Statement GET /v2/banking/account/{accountNumber}/statement?from=&to=
//
// Auth: header-based — client_id, client_secret, module_secret, provider_secret.
// Staging: https://in.staging.decentro.tech
//
// The adapter activates automatically when the environment variables are set;
// otherwise the UI/API reports it as not configured and the deterministic
// simulator (mock AA) remains the demo provider.
// ============================================================================

const { db, insert, get, all, run } = require('./db');
const { uid, nowIso, todayStr, daysAgo, inr } = require('./util');

const BASE_URL = process.env.DECENTRO_BASE_URL || 'https://in.staging.decentro.tech';
const CLIENT_ID = process.env.DECENTRO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DECENTRO_CLIENT_SECRET || '';
const MODULE_SECRET = process.env.DECENTRO_MODULE_SECRET || '';
const PROVIDER_SECRET = process.env.DECENTRO_PROVIDER_SECRET || '';
const CUSTOMER_ID = process.env.DECENTRO_CUSTOMER_ID || '';

function enabled() {
  return !!(CLIENT_ID && CLIENT_SECRET && MODULE_SECRET);
}

function config() {
  return {
    provider: 'decentro-connected-banking',
    module: 'business_accounts',
    base_url: BASE_URL,
    enabled: enabled(),
    missing_env: enabled() ? [] : ['DECENTRO_CLIENT_ID', 'DECENTRO_CLIENT_SECRET', 'DECENTRO_MODULE_SECRET'].filter(k => !process.env[k]),
    provider_secret_set: !!PROVIDER_SECRET,
    production: !BASE_URL.includes('staging'),
  };
}

function headers() {
  return {
    'content-type': 'application/json',
    'client_id': CLIENT_ID,
    'client_secret': CLIENT_SECRET,
    'module_secret': MODULE_SECRET,
    ...(PROVIDER_SECRET ? { 'provider_secret': PROVIDER_SECRET } : {}),
  };
}

async function request(path, { method = 'GET', body, allowFailure = false } = {}) {
  if (!enabled()) {
    const err = new Error('Decentro not configured — set DECENTRO_CLIENT_ID, DECENTRO_CLIENT_SECRET and DECENTRO_MODULE_SECRET');
    err.status = 503;
    throw err;
  }
  let resp;
  try {
    resp = await fetch(BASE_URL + path, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error(`Decentro unreachable (${e.message})`);
    err.status = 502;
    throw err;
  }
  let json = null;
  try { json = await resp.json(); } catch { /* empty body */ }
  if (!resp.ok) {
    const msg = (json && (json.message || json.error)) || `Decentro HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = 502;
    err.details = json;
    throw err;
  }
  if (json && json.status && json.status !== 'SUCCESS' && !allowFailure) {
    const err = new Error((json.message || json.responseCode || 'Decentro request failed') + (json.data && json.data.message ? `: ${json.data.message}` : ''));
    err.status = 502;
    err.details = json;
    throw err;
  }
  return json;
}

// ----------------------------------------------------------------------------
// Account linking (Connected Banking connect flow)
//
// 1. createLink -> POST /v2/banking/account/{accountNumber}/link
//    Decentro returns a redirect URL to the bank's internet banking portal.
// 2. The user logs in, approves the consent, and approves an OTP.
// 3. Decentro triggers the Account Linkage Status Callback to our webhook
//    and/or we poll the Check Linkage Status endpoint.
// 4. finalizeLink activates the account in KhataOS and pulls the statement.
// ----------------------------------------------------------------------------

// Provider-specific parameters required by the Link API (docs, ICICI example;
// other banks follow Decentro's provider parameter tables).
function providerParamFields(bankCode) {
  if (bankCode === 'ICIC') {
    return [
      { key: 'corp_id', label: 'Corp ID (ICICI)', required: true, hint: 'Corp ID belonging to the account' },
      { key: 'user_id', label: 'User ID (ICICI)', required: true, hint: 'User ID belonging to the account (needs admin privileges)' },
      { key: 'alias_id', label: 'Alias ID (optional)', required: false, hint: 'Can be skipped if not configured' },
    ];
  }
  return [
    { key: 'user_id', label: 'Netbanking user ID', required: true, hint: 'User ID used to log in to the bank portal (admin privileges recommended)' },
  ];
}

async function createLink(accountNumber, payload) {
  const body = {
    type: 'business',
    name: payload.name || '',
    pan: payload.pan || '',
    email: payload.email || '',
    mobile: payload.mobile || '',
    address: payload.address || '',
    kyc_verified: payload.kyc_verified != null ? payload.kyc_verified : 1,
    kyc_check_decentro: payload.kyc_check_decentro || 0,
    currency_code: 'INR',
    customer_id: payload.customer_id || CUSTOMER_ID,
    ifsc: payload.ifsc || '',
    integration_type: 'CONNECTED_BANKING',
    provider_params: payload.provider_params || {},
  };
  const json = await request(`/v2/banking/account/${encodeURIComponent(accountNumber)}/link`, { method: 'POST', body, allowFailure: true });
  const d = (json && json.data) || {};
  const redirectUrl = d.redirectUrl || d.redirect_url || d.url || d.shortUrl || d.link || d.connectUrl || d.netbankingUrl || null;
  return {
    decentroTxnId: json && json.decentroTxnId,
    status: json && json.status,
    responseCode: json && json.responseCode,
    message: json && json.message,
    redirect_url: redirectUrl,
    data: d,
  };
}

async function checkLinkStatus(accountNumber, mobile) {
  const path = (process.env.DECENTRO_LINK_STATUS_PATH || '/v2/banking/account/{account_number}/link/status')
    .replace('{account_number}', encodeURIComponent(accountNumber));
  const qs = mobile ? `?mobile=${encodeURIComponent(mobile)}` : '';
  try {
    const json = await request(path + qs);
    return json;
  } catch (e) {
    // The status endpoint shape varies by provider/version; never crash the
    // polling loop — report the state as unknown so the UI can fall back to
    // the webhook / manual confirmation.
    if (e.status === 404 || e.status === 400 || e.status === 405) {
      return { status: 'UNKNOWN', message: `Status endpoint not supported (${e.message}) — use webhook or manual confirmation` };
    }
    throw e;
  }
}

async function findBankByIfsc(ifsc) {
  const prefix = String(ifsc || '').toUpperCase().slice(0, 4);
  const bank = await get('SELECT * FROM banks WHERE code = ?', [prefix]);
  return bank || null;
}

// Activate a linked account in KhataOS (idempotent): create/reuse the
// bank_account row, pull balance + 90-day statement, run reconciliation.
async function finalizeLink(companyId, accountNumber, opts = {}) {
  const existing = await get('SELECT * FROM bank_accounts WHERE company_id = ? AND account_number = ? AND source = \'decentro\'', [companyId, accountNumber]);
  let account;
  if (existing) {
    account = existing;
  } else {
    const bank = await findBankByIfsc(opts.ifsc) || (opts.bank_code ? await get('SELECT * FROM banks WHERE code = ?', [opts.bank_code]) : null);
    const accountId = uid('acc');
    await insert('bank_accounts', {
      id: accountId, company_id: companyId, bank_code: bank ? bank.code : 'ICIC',
      account_name: opts.name || 'Decentro Connected Account', account_number: accountNumber,
      type: 'current', ifsc: opts.ifsc || '', status: 'active', source: 'decentro',
      consent_id: null, opened_at: todayStr(),
    });
    account = await get('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
  }
  const pulled = await pull(companyId, account, { recentOnly: false });
  await run(`UPDATE decentro_links SET status = 'linked', linked_at = ?, last_error = NULL WHERE company_id = ? AND account_number = ? AND status != 'linked'`,
    [nowIso(), companyId, accountNumber]);
  return { account, pulled };
}

// GET /v2/banking/account/{accountNumber}/balance
async function fetchBalance(accountNumber) {
  const json = await request(`/v2/banking/account/${encodeURIComponent(accountNumber)}/balance`);
  const d = (json && json.data) || {};
  return {
    decentroTxnId: json && json.decentroTxnId,
    accountNumber: d.accountNumber || accountNumber,
    presentBalance: d.presentBalance != null ? inr(Number(d.presentBalance)) : null,
  };
}

// GET /v2/banking/account/{accountNumber}/statement?from=YYYY-MM-DD&to=YYYY-MM-DD
async function fetchStatement(accountNumber, from, to) {
  const json = await request(`/v2/banking/account/${encodeURIComponent(accountNumber)}/statement?from=${from}&to=${to}`);
  return json;
}

function inferMode(description) {
  const d = String(description || '').toUpperCase();
  if (d.includes('UPI')) return 'UPI';
  if (d.includes('IMPS')) return 'IMPS';
  if (d.includes('NEFT')) return 'NEFT';
  if (d.includes('RTGS')) return 'RTGS';
  if (d.includes('CHQ') || d.includes('CHEQUE')) return 'CHQ';
  if (d.includes('ATM')) return 'ATM';
  if (d.includes('CASH')) return 'CASH';
  return 'NEFT'; // default for Indian corporate statements
}

// Pure mapper: Decentro statement response -> our bank_transactions shape.
function mapStatement(data) {
  const rows = (data && data.statement ? data.statement : []).map((t, idx) => {
    const deposit = Number(t.depositAmount || 0);
    const withdrawal = Number(t.withdrawalAmount || 0);
    const amount = inr(deposit - withdrawal);
    const ts = String(t.timestamp || '');
    return {
      external_id: String(t.bankTransactionId || `${data.accountNumber}-${ts || idx}`),
      txn_date: ts.slice(0, 10),
      value_date: ts.slice(0, 10),
      amount,
      balance_after: t.balance != null ? inr(Number(t.balance)) : null,
      description: String(t.description || ''),
      mode: inferMode(t.description),
      ref_no: t.bankTransactionId ? String(t.bankTransactionId) : null,
      status: 'posted',
      type: t.type,
    };
  }).filter(r => r.txn_date);
  return {
    accountNumber: data && data.accountNumber,
    name: data && data.name,
    ifsc: data && data.ifsc,
    openingBalance: data && data.openingBalance != null ? inr(Number(data.openingBalance)) : null,
    closingBalance: data && data.closingBalance != null ? inr(Number(data.closingBalance)) : null,
    rows,
  };
}

// Pull a linked account's history into the platform.
async function pull(companyId, account, opts = {}) {
  const days = opts.recentOnly ? 7 : 90;
  const from = daysAgo(days - 1);
  const to = todayStr();
  const json = await fetchStatement(account.account_number, from, to);
  const mapped = mapStatement(json && json.data);

  let inserted = 0;
  for (const r of mapped.rows) {
    const exists = await get('SELECT id FROM bank_transactions WHERE account_id = ? AND external_id = ?', [account.id, r.external_id]);
    if (exists) continue;
    await insert('bank_transactions', {
      id: uid('btx'), company_id: companyId, account_id: account.id,
      external_id: r.external_id, txn_date: r.txn_date, value_date: r.value_date,
      amount: r.amount, balance_after: r.balance_after, description: r.description,
      mode: r.mode, ref_no: r.ref_no, status: 'posted',
      raw_json: JSON.stringify(r), created_at: nowIso(),
    });
    inserted++;
  }

  // balance API gives the present balance; store as today's closing balance
  let present = null;
  try { present = (await fetchBalance(account.account_number)).presentBalance; } catch { /* non-fatal */ }
  const dayMap = new Map(mapped.rows.map(r => [r.txn_date, r.balance_after]));
  let carry = present != null ? present : (mapped.closingBalance != null ? mapped.closingBalance : dayMap.get(to));
  if (carry != null) {
    for (let k = 29; k >= 0; k--) {
      const date = daysAgo(k);
      if (dayMap.has(date) && dayMap.get(date) != null) carry = dayMap.get(date);
      const existing = await get('SELECT id FROM cash_daily WHERE account_id = ? AND date = ?', [account.id, date]);
      if (existing) await run('UPDATE cash_daily SET closing_balance = ? WHERE id = ?', [carry, existing.id]);
      else await insert('cash_daily', { id: uid('cd'), company_id: companyId, account_id: account.id, date, closing_balance: carry, source: 'decentro' });
    }
  }

  if (mapped.name) await run('UPDATE bank_accounts SET account_name = ? WHERE id = ?', [mapped.name, account.id]);
  if (mapped.ifsc) await run('UPDATE bank_accounts SET ifsc = ? WHERE id = ?', [mapped.ifsc, account.id]);
  await run('UPDATE bank_accounts SET last_synced_at = ?, status = ? WHERE id = ?', [nowIso(), 'active', account.id]);
  return { inserted, mapped_rows: mapped.rows.length, present_balance: present, account_name: mapped.name, ifsc: mapped.ifsc };
}

module.exports = { enabled, config, fetchBalance, fetchStatement, mapStatement, pull, createLink, checkLinkStatus, finalizeLink, findBankByIfsc, providerParamFields };
