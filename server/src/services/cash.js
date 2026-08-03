'use strict';

// Cash/bank service functions: the bank-account listing, balance, uncleared
// and trend queries reused by the cash, dashboard and metrics routes.

const { all, get } = require('../db');
const { daysAgo, inr } = require('../util');

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
  return inr(r.u);
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

// Sum of each account's latest closing balance (used by the dashboard).
async function availableCash(coId) {
  const accounts = await all('SELECT * FROM bank_accounts WHERE company_id = ?', [coId]);
  let available = 0;
  for (const a of accounts) available += await closingBalance(a.id);
  return { accounts, available: inr(available) };
}

module.exports = { listBankAccounts, activeAccounts, closingBalance, accountUncleared, totalUncleared, lastBankSync, cashTrend, recentTransactions, availableCash };
