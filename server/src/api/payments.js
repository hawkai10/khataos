'use strict';

// Payments & reconciliation domain (Fastify plugin): payment
// create/approve/execute/batch and the bank-vs-payment/voucher reconciliation
// endpoints.

const { all, get, insert, run, update } = require('../db');
const { uid, nowIso, daysAgo } = require('../util');
const { Money } = require('../money');
const { ApiError, audit, requireRole } = require('../auth');
const { PaymentGateway, TallyConnector } = require('../adapters');
const recon = require('../recon');
const PaymentService = require('../services/payments');
const { bodyOf, requireOneOf } = require('./validators');
const { companyOf, rupees, publicize, publicizeRows } = require('./helpers');

async function register(fastify) {
  fastify.get('/api/payments', async (request, reply) => {
    const u = new URL(request.url, 'http://x');
    const status = u.searchParams.get('status');
    reply.ok(await PaymentService.listPayments(companyOf(request.user), status));
  });

  fastify.get('/api/payments/:id', async (request, reply) => {
    const row = await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [request.params.id, companyOf(request.user)]);
    if (!row) throw new ApiError(404, 'payment not found');
    reply.ok(publicize(row, 'payments'));
  });

  fastify.post('/api/payments', {
    schema: {
      body: {
        type: 'object',
        required: ['vendor_id', 'invoice_ids'],
        properties: {
          vendor_id: { type: 'string', minLength: 1 },
          invoice_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          mode: { type: 'string' },
          type: { type: 'string' },
          scheduled_date: { type: 'string' },
          account_id: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const coId = companyOf(request.user);
    const user = request.user;
    const b = bodyOf(request);
    const vendor = await get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [b.vendor_id, coId]);
    if (!vendor) throw new ApiError(404, 'vendor not found');
    const invoices = (await Promise.all(b.invoice_ids.map((id) => get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId])))).filter(Boolean);
    if (!invoices.length) throw new ApiError(400, 'no valid invoices');
    const mode = requireOneOf(b.mode || 'NEFT', PaymentService.PAYMENT_MODES, 'invalid mode');
    const amounts = PaymentService.computeAmounts(invoices);
    const needsApproval = amounts.amount.gt(await PaymentService.approvalThreshold(coId));
    const type = b.type === 'instant' ? 'instant' : b.scheduled_date ? 'scheduled' : 'batch';
    const row = await PaymentService.insertPayment(coId, {
      vendor, invoices, mode, type,
      status: needsApproval ? 'pending_approval' : 'approved',
      scheduledDate: b.scheduled_date, accountId: b.account_id, user,
    });
    await PaymentService.markInvoicesScheduled(coId, invoices.map((i) => i.id), b.scheduled_date);
    if (!needsApproval) {
      await PaymentGateway.createBatch(coId, [await get('SELECT * FROM payments WHERE id = ?', [row.id])]);
    }
    await audit(coId, user, 'payment.created', 'payment', row.id, { amount: Number(amounts.amount.toPaise()), mode, needs_approval: needsApproval });
    reply.ok(publicize(row, 'payments'));
  });

  fastify.post('/api/payments/:id/approve', async (request, reply) => {
    const coId = companyOf(request.user);
    const user = request.user;
    const pay = await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [request.params.id, coId]);
    if (!pay) throw new ApiError(404, 'payment not found');
    if (pay.status !== 'pending_approval') throw new ApiError(409, 'payment is not awaiting approval');
    const threshold = await PaymentService.approvalThreshold(coId);
    if (Money.fromPaise(pay.amount).gt(threshold)) requireRole(user, ['cfo']);
    await update('payments', request.params.id, { status: 'approved', approved_by: user.id });
    await PaymentGateway.createBatch(coId, [pay]);
    await audit(coId, user, 'payment.approved', 'payment', request.params.id, { amount: pay.amount });
    reply.ok(publicize(await get('SELECT * FROM payments WHERE id = ?', [request.params.id]), 'payments'));
  });

  fastify.post('/api/payments/:id/execute', async (request, reply) => {
    const coId = companyOf(request.user);
    const user = request.user;
    const pay = await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [request.params.id, coId]);
    if (!pay) throw new ApiError(404, 'payment not found');
    if (!['approved', 'pending_approval'].includes(pay.status)) throw new ApiError(409, 'payment cannot be executed from current state');
    await update('payments', request.params.id, { type: 'instant', status: 'approved', approved_by: user.id });
    await PaymentGateway.createBatch(coId, [await get('SELECT * FROM payments WHERE id = ?', [request.params.id])]);
    await audit(coId, user, 'payment.executed', 'payment', request.params.id, { mode: pay.mode });
    reply.ok(publicize(await get('SELECT * FROM payments WHERE id = ?', [request.params.id]), 'payments'));
  });

  fastify.post('/api/payments/batch', async (request, reply) => {
    const coId = companyOf(request.user);
    const user = request.user;
    const items = (request.body || {}).items || [];
    if (!items.length) throw new ApiError(400, 'items required');
    const created = [];
    for (const item of items) {
      const vendor = await get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [item.vendor_id, coId]);
      if (!vendor) continue;
      const invoices = (await Promise.all((item.invoice_ids || []).map((id) => get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId])))).filter(Boolean);
      if (!invoices.length) continue;
      const row = await PaymentService.insertPayment(coId, {
        vendor, invoices, mode: item.mode || 'NEFT', type: 'batch', status: 'approved',
        scheduledDate: item.scheduled_date, accountId: item.account_id, user,
      });
      await PaymentService.markInvoicesScheduled(coId, invoices.map((i) => i.id), item.scheduled_date);
      created.push(row.id);
    }
    const rows = await all(`SELECT * FROM payments WHERE id IN (${created.map(() => '?').join(',')})`, created);
    await PaymentGateway.createBatch(coId, rows);
    await audit(coId, user, 'payment.batch_created', 'payment', null, { count: created.length });
    reply.ok(publicizeRows(rows, 'payments'));
  });

  // ===================== RECONCILIATION =====================
  fastify.get('/api/recon/summary', async (request, reply) => {
    const coId = companyOf(request.user);
    const asOf = (await get('SELECT MAX(last_synced_at) AS t FROM bank_accounts WHERE company_id = ?', [coId])).t;
    const matches = await all(`SELECT rm.*, bt.amount AS bank_amount, bt.txn_date, bt.description, p.reference AS payment_ref
      FROM recon_matches rm
      JOIN bank_transactions bt ON bt.id = rm.bank_txn_id
      LEFT JOIN payments p ON p.id = rm.payment_id
      WHERE rm.company_id = ? ORDER BY rm.matched_at DESC LIMIT 50`, [coId]);
    reply.ok({ ...(await recon.score(coId)), as_of: asOf, recent: matches.map((m) => ({ ...m, bank_amount: rupees(m.bank_amount) })) });
  });

  fastify.get('/api/recon/unmatched', async (request, reply) => {
    const coId = companyOf(request.user);
    const rows = await all(`SELECT t.*, a.account_name, b.name AS bank_name
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id JOIN banks b ON b.code = a.bank_code
      WHERE t.company_id = ? AND t.matched = 0 AND t.status = 'posted' AND t.txn_date >= ?
      ORDER BY t.txn_date DESC LIMIT 100`, [coId, daysAgo(30)]);
    // suggest a payment candidate by amount for each unmatched debit
    const payments = await all(`SELECT * FROM payments WHERE company_id = ? AND status IN ('completed','processing')`, [coId]);
    for (const t of rows) {
      const txnAmt = Money.fromPaise(Math.abs(Number(t.amount) || 0));
      const suggestion = payments.find((p) => p.net_amount && txnAmt.equals(Money.fromPaise(p.net_amount)));
      t.suggested_payment = suggestion ? { id: suggestion.id, reference: suggestion.reference, vendor_id: suggestion.vendor_id, net_amount: rupees(suggestion.net_amount) } : null;
    }
    const mismatchRows = await all(`SELECT bank_txn_id, notes FROM recon_matches WHERE company_id = ? AND status = 'mismatch' ORDER BY matched_at DESC`, [coId]);
    const mismatchByTxn = new Map(mismatchRows.map((m) => [m.bank_txn_id, m.notes]));
    for (const t of rows) t.mismatch_note = mismatchByTxn.get(t.id) || null;
    reply.ok(publicizeRows(rows, 'bank_transactions'));
  });

  fastify.post('/api/recon/run', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const stats = await recon.matchAll(companyOf(user));
    await audit(companyOf(user), user, 'recon.run', 'recon', null, stats);
    reply.ok({ ...stats, score: await recon.score(companyOf(user)) });
  });

  fastify.post('/api/recon/manual-match', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const b = bodyOf(request);
    const txn = await get('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?', [b.bank_txn_id, coId]);
    if (!txn) throw new ApiError(404, 'transaction not found');
    const payment = b.payment_id ? await get('SELECT * FROM payments WHERE id = ? AND company_id = ?', [b.payment_id, coId]) : null;
    await recon.markMatched(txn.id, payment ? payment.id : null, 'manual', 1, user.id);
    await audit(coId, user, 'recon.manual_match', 'bank_transaction', txn.id, { payment_id: payment ? payment.id : null });
    reply.ok({ matched: true });
  });

  fastify.post('/api/recon/unmatched/:id/voucher', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const txn = await get('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?', [request.params.id, coId]);
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
    reply.ok({ voucher_no: vno });
  });
}

module.exports = { register };
