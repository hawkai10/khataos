'use strict';

// Payment service functions: amount computation, row insertion and the list
// query shared by the single-create and batch payment routes.

const { all, get, insert, run } = require('../db');
const { uid, nowIso, todayStr } = require('../util');
const { Money } = require('../money');
const { getSettings } = require('./company');
const { publicize } = require('../api/helpers');

const PAYMENT_MODES = ['UPI', 'IMPS', 'NEFT', 'RTGS'];

function computeAmounts(invoices) {
  const amount = Money.sum(invoices.map((i) => Money.fromPaise(i.gross_amount || 0)));
  const tds = Money.sum(invoices.map((i) => Money.fromPaise(i.tds_amount || 0)));
  return { amount, tds, net: amount.minus(tds) };
}

async function approvalThreshold(coId) {
  const settings = await getSettings(coId);
  return Money.fromRupees(settings.payment_approval_threshold || 500000);
}

// Inserts a payment row and returns the new row (fetched fresh so gateway
// submission and downstream consumers see the complete record).
async function insertPayment(coId, opts) {
  const { vendor, invoices, mode, type, status, scheduledDate, accountId, user, payId = uid('pay') } = opts;
  const { amount, tds, net } = computeAmounts(invoices);
  await insert('payments', {
    id: payId, company_id: coId, vendor_id: vendor.id,
    invoice_ids: JSON.stringify(invoices.map((i) => i.id)),
    amount: Number(amount.toPaise()), mode, type, status,
    scheduled_date: scheduledDate || null,
    bank_account_id: accountId || null,
    reference: `${mode}-${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
    gateway: 'razorpayx', gst_ledger: vendor.ledger_name, tds_section: vendor.tds_section,
    tds_amount: Number(tds.toPaise()), net_amount: Number(net.toPaise()),
    initiated_by: user.id, initiated_at: nowIso(), created_at: nowIso(),
  });
  return get('SELECT * FROM payments WHERE id = ?', [payId]);
}

// Invoice status follows the payment's scheduling: future date -> scheduled,
// otherwise approved.
async function markInvoicesScheduled(coId, invoiceIds, scheduledDate) {
  const status = scheduledDate && scheduledDate > todayStr() ? 'scheduled' : 'approved';
  await run(`UPDATE invoices SET status = ? WHERE id IN (${invoiceIds.map(() => '?').join(',')})`, [status, ...invoiceIds]);
  return status;
}

async function listPayments(coId, status) {
  const where = ['p.company_id = ?'];
  const args = [coId];
  if (status && status !== 'all') { where.push('p.status = ?'); args.push(status); }
  const rows = await all(`SELECT p.*, v.name AS vendor_name FROM payments p LEFT JOIN vendors v ON v.id = p.vendor_id
    WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 200`, args);
  // resolve invoice references in JS (engine-agnostic; invoice_ids is a JSON array string)
  const ids = [...new Set(rows.flatMap((r) => { try { return JSON.parse(r.invoice_ids || '[]'); } catch { return []; } }))];
  let refMap = {};
  if (ids.length) {
    refMap = Object.fromEntries((await all(`SELECT id, invoice_no FROM invoices WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).map((i) => [i.id, i.invoice_no]));
  }
  return rows.map((r) => publicize({ ...r, invoice_refs: (() => { try { return JSON.parse(r.invoice_ids || '[]').map((id) => refMap[id]).filter(Boolean).join(', '); } catch { return null; } })() }, 'payments'));
}

module.exports = { PAYMENT_MODES, computeAmounts, approvalThreshold, insertPayment, markInvoicesScheduled, listPayments };
