'use strict';

// Accounts-payable domain (Fastify plugin): vendors, payables aging, invoice
// capture/approval and the approval queue.

const { all, get, withTransaction, T } = require('../db');
const { eq, and, count } = require('drizzle-orm');
const { uid, nowIso, todayStr, addDays } = require('../util');
const { Money } = require('../money');
const { ApiError, audit } = require('../auth');
const { queue, OcrEngine, createApprovalChain } = require('../adapters');
const Aging = require('../services/aging');
const Invoices = require('../services/invoices');
const { bodyOf } = require('./validators');
const { companyOf, parseUrl, queryParam, rupees, publicize, publicizeRows } = require('./helpers');

async function register(fastify) {
  fastify.get('/api/vendors', async (request, reply) => {
    reply.ok(await all('SELECT * FROM vendors WHERE company_id = ? AND active = 1 ORDER BY name', [companyOf(request.user)]));
  });

  // Payables aging from imported Tally purchase vouchers (authoritative once
  // imported): age buckets by voucher date vs today. Netting lives in the
  // aging service; this handler is a thin wrapper.
  fastify.get('/api/payables/aging', async (request, reply) => {
    reply.ok(await Aging.payablesAging(companyOf(request.user)));
  });

  fastify.get('/api/invoices', async (request, reply) => {
    const coId = companyOf(request.user);
    const u = parseUrl(request);
    const status = queryParam(u, 'status');
    const q = queryParam(u, 'q');
    const where = ['i.company_id = ?'];
    const args = [coId];
    if (status && status !== 'all') { where.push('i.status = ?'); args.push(status); }
    if (q) { where.push('(i.invoice_no LIKE ? OR v.name LIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
    const rows = await all(`SELECT i.*, v.name AS vendor_name, v.gstin AS vendor_gstin FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT 200`, args);
    reply.ok(publicizeRows(rows, 'invoices'));
  });

  fastify.get('/api/invoices/:id', async (request, reply) => {
    reply.ok(await Invoices.getInvoiceDetail(companyOf(request.user), request.params.id));
  });

  fastify.post('/api/invoices/ocr-preview', async (request, reply) => {
    const text = String((request.body || {}).text || '').trim();
    if (!text) throw new ApiError(400, 'text required');
    const ocr = OcrEngine.extract(text);
    for (const k of ['taxable_amount', 'cgst', 'sgst', 'igst', 'tds_amount', 'grand_total']) {
      if (ocr[k] != null) ocr[k] = rupees(ocr[k]);
    }
    for (const l of ocr.hsns || []) {
      l.rate = rupees(l.rate);
      l.taxable = rupees(l.taxable);
      l.cgst = rupees(l.cgst);
    }
    reply.ok(ocr);
  });

  fastify.post('/api/invoices/capture', async (request, reply) => {
    const coId = companyOf(request.user);
    const user = request.user;
    const b = bodyOf(request);
    const source = b.source || 'manual';
    let fields;
    if (source === 'pdf') {
      // PDF uploads must carry the OCR'd invoice text; the OCR parser runs on
      // that real text (no canned samples).
      const text = String(b.text || '').trim();
      if (!text) throw new ApiError(400, 'text required for pdf capture');
      fields = OcrEngine.extract(text);
      fields.source = 'pdf_upload';
      if (fields.gstin && !fields.gstin_vendor) fields.gstin_vendor = fields.gstin;
    } else {
      fields = b;
      fields.source = 'manual';
    }
    const vendor = fields.vendor_id ? await get('SELECT * FROM vendors WHERE id = ? AND company_id = ?', [fields.vendor_id, coId]) : null;
    const taxable = Money.fromRupees(fields.taxable_amount || 0);
    const inter = Money.fromRupees(fields.igst || 0).gt(Money.fromPaise(0));
    const cgst = fields.cgst != null ? Money.fromRupees(fields.cgst) : (inter ? Money.fromPaise(0) : taxable.percentBps(900));
    const sgst = fields.sgst != null ? Money.fromRupees(fields.sgst) : (inter ? Money.fromPaise(0) : taxable.percentBps(900));
    const igst = fields.igst != null ? Money.fromRupees(fields.igst) : (inter ? taxable.percentBps(1800) : Money.fromPaise(0));
    const gross = taxable.plus(cgst).plus(sgst).plus(igst);
    const tdsRate = vendor ? vendor.tds_rate : 0;
    const tds = gross.percentBps(Math.round((tdsRate || 0) * 10000));
    if (!fields.invoice_no) throw new ApiError(400, 'invoice_no required');
    const invId = uid('inv');
    // The uniqueness check, the invoice, its lines, the approval chain and the
    // audit row commit as ONE transaction — a failure halfway can never leave an
    // invoice with no approval chain (which would be permanently unapprovable).
    await withTransaction(async (tx) => {
      const existing = await tx.select({ id: T.invoices.id }).from(T.invoices)
        .where(and(eq(T.invoices.company_id, coId), eq(T.invoices.invoice_no, String(fields.invoice_no).trim()))).limit(1);
      if (existing.length) throw new ApiError(409, 'invoice_no already exists');
      await tx.insert(T.invoices).values({
        id: invId, company_id: coId, invoice_no: String(fields.invoice_no).trim(),
        vendor_id: vendor ? vendor.id : null,
        invoice_date: fields.invoice_date || todayStr(),
        due_date: fields.due_date || addDays(fields.invoice_date || todayStr(), vendor ? vendor.credit_days : 30),
        source, status: 'pending_approval',
        gross_amount: Number(gross.toPaise()), taxable_amount: Number(taxable.toPaise()),
        cgst: Number(cgst.toPaise()), sgst: Number(sgst.toPaise()), igst: Number(igst.toPaise()), cess: 0,
        tds_amount: Number(tds.toPaise()), net_payable: Number(gross.minus(tds).toPaise()),
        gstin_vendor: fields.gstin_vendor || (vendor ? vendor.gstin : null),
        hsns: JSON.stringify(fields.hsns || []),
        three_way_match: 'none',
        ocr_json: JSON.stringify({ engine: OcrEngine.name, confidence: source === 'pdf' ? 0.95 : 1 }),
        created_by: user.id, created_at: nowIso(),
      });
      if (fields.hsns && fields.hsns.length) {
        for (const l of fields.hsns) {
          await tx.insert(T.invoice_lines).values({ id: uid('l'), invoice_id: invId, hsn: l.hsn, description: l.description, qty: l.qty || 1, rate: l.rate || 0, taxable: l.taxable || 0, cgst: l.cgst || 0, sgst: l.sgst || 0, igst: l.igst || 0, cess: 0 });
        }
      }
      await createApprovalChain(coId, invId, tx);
      await audit(coId, user, 'invoice.captured', 'invoice', invId, { source, invoice_no: fields.invoice_no }, tx);
    });
    reply.ok(publicize(await get('SELECT * FROM invoices WHERE id = ?', [invId]), 'invoices'));
  });

  fastify.post('/api/invoices/:id/three-way-match', async (request, reply) => {
    reply.ok(await Invoices.threeWayMatch(companyOf(request.user), request.params.id));
  });

  fastify.post('/api/invoices/:id/approve', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } },
      body: {
        type: 'object',
        properties: { comment: { type: 'string' } },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const coId = companyOf(request.user);
    const user = request.user;
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [request.params.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    const pending = await get(`SELECT * FROM approvals WHERE invoice_id = ? AND status = 'pending' AND required_role = ? ORDER BY level LIMIT 1`, [request.params.id, user.role]);
    if (!pending) {
      const anyPending = await get(`SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ? AND status = 'pending'`, [request.params.id]);
      if (anyPending.c > 0) throw new ApiError(403, `This approval level requires ${(await get(`SELECT required_role FROM approvals WHERE invoice_id = ? AND status='pending' ORDER BY level LIMIT 1`, [request.params.id]) || {}).required_role}`);
      throw new ApiError(409, 'invoice already fully approved');
    }
    // Approving the last pending level must finalize the invoice atomically —
    // an invoice can never be left approved-but-without-a-voucher-sync or
    // half-finalized. The approval-row update is conditional (WHERE status =
    // 'pending'): of two concurrent approvals of the same level, exactly one
    // wins the row and enqueues the voucher sync; the other gets a 409.
    await withTransaction(async (tx) => {
      const decided = await tx.update(T.approvals)
        .set({ status: 'approved', approver_id: user.id, approver_name: user.name, comment: (request.body || {}).comment || null, decided_at: nowIso() })
        .where(and(eq(T.approvals.id, pending.id), eq(T.approvals.status, 'pending')))
        .returning({ id: T.approvals.id });
      if (!decided.length) throw new ApiError(409, 'approval already decided');
      const remaining = await tx.select({ c: count() }).from(T.approvals).where(and(eq(T.approvals.invoice_id, request.params.id), eq(T.approvals.status, 'pending')));
      // Finalizing is itself a conditional update on the invoice: when two
      // levels approve concurrently and both see zero remaining, only the
      // request that actually flips pending_approval -> approved enqueues the
      // voucher sync — exactly one sync job, exactly one final state change.
      if (remaining[0].c === 0) {
        const finalized = await tx.update(T.invoices)
          .set({ status: 'approved', approved_by: user.id, approved_at: nowIso() })
          .where(and(eq(T.invoices.id, request.params.id), eq(T.invoices.status, 'pending_approval')))
          .returning({ id: T.invoices.id });
        if (finalized.length) {
          await queue.enqueue(coId, 'tally.syncVoucher', { invoiceId: request.params.id }, {}, tx);
        }
      }
      await audit(coId, user, 'invoice.approved', 'invoice', request.params.id, { invoice_no: inv.invoice_no, level: pending.level }, tx);
    });
    reply.ok(publicize(await get('SELECT * FROM invoices WHERE id = ?', [request.params.id]), 'invoices'));
  });

  fastify.post('/api/invoices/:id/reject', async (request, reply) => {
    const coId = companyOf(request.user);
    const user = request.user;
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [request.params.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    await withTransaction(async (tx) => {
      // Same conditional guard as approve: only one of two concurrent rejects
      // can flip the pending approvals, so the audit + status move run once.
      const decided = await tx.update(T.approvals)
        .set({ status: 'rejected', approver_id: user.id, approver_name: user.name, decided_at: nowIso() })
        .where(and(eq(T.approvals.invoice_id, request.params.id), eq(T.approvals.status, 'pending')))
        .returning({ id: T.approvals.id });
      if (!decided.length) throw new ApiError(409, 'invoice is not awaiting approval');
      await tx.update(T.invoices).set({ status: 'rejected' }).where(eq(T.invoices.id, request.params.id));
      await audit(coId, user, 'invoice.rejected', 'invoice', request.params.id, { invoice_no: inv.invoice_no, comment: (request.body || {}).comment }, tx);
    });
    reply.ok(publicize(await get('SELECT * FROM invoices WHERE id = ?', [request.params.id]), 'invoices'));
  });

  fastify.get('/api/approvals/pending', async (request, reply) => {
    const rows = await all(`SELECT a.*, i.invoice_no, i.gross_amount, i.invoice_date, i.due_date, v.name AS vendor_name
      FROM approvals a JOIN invoices i ON i.id = a.invoice_id LEFT JOIN vendors v ON v.id = i.vendor_id
      WHERE a.company_id = ? AND a.status = 'pending' AND a.required_role = ?
      ORDER BY i.due_date ASC`, [companyOf(request.user), request.user.role]);
    for (const r of rows) r.gross_amount = rupees(r.gross_amount);
    reply.ok(rows);
  });
}

module.exports = { register };
