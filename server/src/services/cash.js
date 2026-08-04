'use strict';

// Cash/bank service functions: the bank-account listing, balance, uncleared
// and trend queries reused by the cash, dashboard and metrics routes.

const { all, get } = require('../db');
const { daysAgo } = require('../util');
const { Money } = require('../money');

async function listBankAccounts(coId, orderBy = 'ORDER BY ba.account_name') {
  return all(`SELECT ba.*, b.name AS bank_name FROM bank_accounts ba JOIN banks b ON b.code = ba.bank_code WHERE ba.company_id = ? ${orderBy}`, [coId]);
}

async function activeAccounts(coId) {
  return all(`SELECT * FROM bank_accounts WHERE company_id = ? AND status = 'active'`, [coId]);
}

async function closingBalance(accountId) {
  const last = await get('SELECT closing_balance FROM cash_daily WHERE account_id = ? ORDER BY date DESC LIMIT 1', [accountId]);
  return last ? last.closing_balance : 0;
}

async function accountUncleared(accountId) {
  const r = await get(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE account_id = ? AND status = 'uncleared' AND amount > 0`, [accountId]);
  return r.u || 0;
}

async function totalUncleared(coId) {
  const r = await get(`SELECT COALESCE(SUM(amount),0) AS u FROM bank_transactions WHERE company_id = ? AND status='uncleared' AND amount > 0`, [coId]);
  return r.u || 0;
}

async function lastBankSync(coId) {
  const r = await get('SELECT MAX(last_synced_at) AS t FROM bank_accounts WHERE company_id = ?', [coId]);
  return r ? r.t : null;
}

async function cashTrend(coId, days) {
  return all(`SELECT date, SUM(closing_balance) AS balance FROM cash_daily WHERE company_id = ? AND date >= ? GROUP BY date ORDER BY date`, [coId, daysAgo(days - 1)]);
}

async function recentTransactions(coId, days, accountId = null) {
  const since = daysAgo(days - 1);
  return accountId
    ? all(`SELECT t.*, a.account_name, b.name AS bank_name FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code WHERE t.company_id = ? AND t.account_id = ? AND t.txn_date >= ? ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, [coId, accountId, since])
    : all(`SELECT t.*, a.account_name, b.name AS bank_name FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code WHERE t.company_id = ? AND t.txn_date >= ? ORDER BY t.txn_date DESC, t.id DESC LIMIT 200`, [coId, since]);
}

// Sum of each account's latest closing balance in a single query (used by
// the dashboard and the AI assistant) — no per-account N+1 lookups.
async function availableCash(coId) {
  const r = await get(`SELECT COUNT(*) AS c, COALESCE(SUM(balance), 0) AS total FROM (
      SELECT ba.id,
        (SELECT cd.closing_balance FROM cash_daily cd WHERE cd.account_id = ba.id ORDER BY cd.date DESC LIMIT 1) AS balance
      FROM bank_accounts ba WHERE ba.company_id = ?
    ) t`, [coId]);
  return { accounts: r ? Number(r.c) : 0, available: r ? Number(r.total) : 0 };
}

// Monthly burn from the last 90 days of outflows + runway in months. Shared by
// the dashboard and the AI assistant so both see the same number.
async function runway(coId) {
  const { accounts, available } = await availableCash(coId);
  const outflows = await get(`SELECT COALESCE(SUM(amount),0) AS s FROM bank_transactions WHERE company_id = ? AND amount < 0 AND txn_date >= ?`, [coId, daysAgo(89)]);
  const monthlyBurn = Money.fromPaise(Math.abs(Number(outflows.s))).divide(3);
  return {
    available, accounts: accounts.length,
    monthly_burn: monthlyBurn.toPaise(),
    runway_months: !monthlyBurn.isZero() ? Number(available) / Number(monthlyBurn.toPaise()) : null,
  };
}

module.exports = { listBankAccounts, activeAccounts, closingBalance, accountUncleared, totalUncleared, lastBankSync, cashTrend, recentTransactions, availableCash, runway };
