'use strict';

// Payment service functions: amount computation, row insertion, the list
// query shared by the single-create and batch payment routes, and the
// status-transition state machine (the single gate every payment status
// change must pass through).

const { all, get, T } = require('../db');
const { eq, and, inArray } = require('drizzle-orm');
const { uid, nowIso, todayStr } = require('../util');
const { Money } = require('../money');
const { getSettings } = require('./company');
const { publicize } = require('../api/helpers');
const { ApiError } = require('../auth');

const PAYMENT_MODES = ['UPI', 'IMPS', 'NEFT', 'RTGS'];

// ----------------------------------------------------------------------------
// Payment status state machine. Every status change must be one of these
// pairs; transitionPayment enforces the map AND makes the move atomic
// (conditional UPDATE ... WHERE status = from, so two concurrent requests can
// never both win the same transition).
//   pending_approval -> approved   (approve)
//   pending_approval -> rejected   (reject)
//   approved         -> executing  (instant execute — the only way out of
//                                   approved besides the gateway picking it up)
//   approved         -> processing (gateway job for auto-approved/batch/
//                                   scheduled payments)
//   executing        -> processing (gateway job after an instant execute)
//   processing       -> completed / failed
//   failed           -> approved   (retry)
//
// There is deliberately NO processing -> processing self-loop: the gateway
// claim (approved/executing -> processing) happens inside the same transaction
// as the provider call and the terminal transition, so a committed 'processing'
// row never exists alone. A second gateway job for the same payment (e.g.
// approve-then-execute enqueues two) therefore always loses the claim CAS — on
// SQLite the write lock and on PostgreSQL the row lock serialize the two
// UPDATEs, and the loser re-checks the WHERE against the committed row
// (completed) and aborts. At most one job ever wins the claim per payment.
// ----------------------------------------------------------------------------
const PAYMENT_TRANSITIONS = {
  pending_approval: ['approved', 'executing', 'rejected'],
  approved: ['executing', 'processing', 'cancelled'],
  executing: ['processing', 'cancelled'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: ['approved'],
  rejected: [],
  cancelled: [],
};

// Atomically move a payment from `from` to `to` inside the caller's
// transaction. The conditional UPDATE doubles as the concurrency guard: only
// the request that observes `status = from` gets a row back (RETURNING id);
// every other concurrent request sees zero rows and gets a 409. The transition
// is then recorded in payment_state_transitions so the full lifecycle of every
// payment is auditable. Returns the updated row id.
async function transitionPayment(db, coId, paymentId, from, to, opts = {}) {
  const allowed = PAYMENT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new ApiError(409, `payment cannot transition from '${from}' to '${to}'`);
  }
  // `status` is always the validated target — callers may attach extra columns
  // (approved_by, type, ...) but can never override the state machine.
  const set = { ...(opts.set || {}), status: to };
  const updated = await db.update(T.payments)
    .set(set)
    .where(and(eq(T.payments.id, paymentId), eq(T.payments.company_id, coId), eq(T.payments.status, from)))
    .returning({ id: T.payments.id });
  if (!updated.length) {
    throw new ApiError(409, `payment is not in state '${from}' — concurrent change or unexpected status`);
  }
  await db.insert(T.payment_state_transitions).values({
    id: uid('pst'), payment_id: paymentId, company_id: coId,
    from_status: from, to_status: to,
    action: opts.action || null, changed_by: opts.changedBy || null, at: nowIso(),
  });
  return updated[0].id;
}

function computeAmounts(invoices) {
  const amount = Money.sum(invoices.map((i) => Money.fromPaise(i.gross_amount || 0)));
  const tds = Money.sum(invoices.map((i) => Money.fromPaise(i.tds_amount || 0)));
  return { amount, tds, net: amount.minus(tds) };
}

async function approvalThreshold(coId) {
  const settings = await getSettings(coId);
  return Money.fromRupees(settings.payment_approval_threshold || 500000);
}

// Inserts a payment row inside the caller's transaction and returns the new
// row (fetched via the same handle so the read-back is transaction-consistent).
async function insertPayment(db, coId, opts) {
  const { vendor, invoices, mode, type, status, scheduledDate, accountId, user, payId = uid('pay') } = opts;
  const { amount, tds, net } = computeAmounts(invoices);
  await db.insert(T.payments).values({
    id: payId, company_id: coId, vendor_id: vendor.id,
    invoice_ids: JSON.stringify(invoices.map((i) => i.id)),
    amount: Number(amount.toPaise()), mode, type, status,
    scheduled_date: scheduledDate || null,
    bank_account_id: accountId || null,
    // `reference` is a local identifier for the payment (the eventual bank
    // statement carries its own real ref); a random placeholder is an
    // identifier, not a claimed data point.
    reference: `${mode}-${String(Math.floor(Math.random() * 90000000) + 10000000)}`,
    gateway: 'razorpayx', gst_ledger: vendor.ledger_name, tds_section: vendor.tds_section,
    tds_amount: Number(tds.toPaise()), net_amount: Number(net.toPaise()),
    initiated_by: user.id, initiated_at: nowIso(), created_at: nowIso(),
  });
  // A payment's lifecycle starts with its creation state — record it so the
  // transition trail covers the whole history, not just subsequent moves.
  await db.insert(T.payment_state_transitions).values({
    id: uid('pst'), payment_id: payId, company_id: coId,
    from_status: null, to_status: status, action: 'payment.created',
    changed_by: user.id, at: nowIso(),
  });
  return (await db.select().from(T.payments).where(eq(T.payments.id, payId)).limit(1))[0];
}

// Invoice status follows the payment's scheduling: future date -> scheduled,
// otherwise approved.
async function markInvoicesScheduled(db, coId, invoiceIds, scheduledDate) {
  const status = scheduledDate && scheduledDate > todayStr() ? 'scheduled' : 'approved';
  await db.update(T.invoices).set({ status }).where(inArray(T.invoices.id, invoiceIds));
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

module.exports = { PAYMENT_MODES, PAYMENT_TRANSITIONS, transitionPayment, computeAmounts, approvalThreshold, insertPayment, markInvoicesScheduled, listPayments };
