'use strict';

// Accounts-payable domain: vendors, payables aging, invoice capture/approval
// and the approval queue.

const { all, get, insert, run, update } = require('../db');
const { uid, nowIso, todayStr, addDays, inr } = require('../util');
const { ApiError, audit } = require('../auth');
const { queue, OcrEngine, createApprovalChain } = require('../adapters');
const Aging = require('../services/aging');
const Invoices = require('../services/invoices');
const { bodyOf } = require('./validators');
const { companyOf, parseUrl, queryParam } = require('./helpers');

function register(r, deps) {
  const { ok } = deps;

  r.get('/api/vendors', async (req, res, p, user) => {
    ok(res, await all('SELECT * FROM vendors WHERE company_id = ? AND active = 1 ORDER BY name', [companyOf(user)]));
  });

  // Payables aging from imported Tally purchase vouchers (authoritative once
  // imported): age buckets by voucher date vs today. Netting lives in the
  // aging service; this handler is a thin wrapper.
  r.get('/api/payables/aging', async (req, res, p, user) => {
    ok(res, await Aging.payablesAging(companyOf(user)));
  });

  r.get('/api/invoices', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = parseUrl(req);
    const status = queryParam(u, 'status');
    const q = queryParam(u, 'q');
    const where = ['i.company_id = ?'];
    const args = [coId];
    if (status && status !== 'all') { where.push('i.status = ?'); args.push(status); }
    if (q) { where.push('(i.invoice_no LIKE ? OR v.name LIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
    const rows = await all(`SELECT i.*, v.name AS vendor_name, v.gstin AS vendor_gstin FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT 200`, args);
    ok(res, rows);
  });

  r.get('/api/invoices/:id', async (req, res, p, user) => {
    ok(res, await Invoices.getInvoiceDetail(companyOf(user), p.id));
  });

  r.post('/api/invoices/ocr-preview', async (req, res, p, user) => {
    const text = String((req.body || {}).text || '').trim();
    if (!text) throw new ApiError(400, 'text required');
    ok(res, OcrEngine.extract(text));
  });

  r.post('/api/invoices/capture', async (req, res, p, user) => {
    const coId = companyOf(user);
    const b = bodyOf(req);
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
    await insert('invoices', {
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
        await insert('invoice_lines', { id: uid('l'), invoice_id: invId, hsn: l.hsn, description: l.description, qty: l.qty || 1, rate: l.rate || 0, taxable: l.taxable || 0, cgst: l.cgst || 0, sgst: l.sgst || 0, igst: l.igst || 0, cess: 0 });
      }
    }
    await createApprovalChain(coId, invId);
    await audit(coId, user, 'invoice.captured', 'invoice', invId, { source, invoice_no: fields.invoice_no });
    ok(res, await get('SELECT * FROM invoices WHERE id = ?', [invId]));
  });

  r.post('/api/invoices/:id/three-way-match', async (req, res, p, user) => {
    ok(res, await Invoices.threeWayMatch(companyOf(user), p.id));
  });

  r.post('/api/invoices/:id/approve', async (req, res, p, user) => {
    const coId = companyOf(user);
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    const pending = await get(`SELECT * FROM approvals WHERE invoice_id = ? AND status = 'pending' AND required_role = ? ORDER BY level LIMIT 1`, [p.id, user.role]);
    if (!pending) {
      const anyPending = await get(`SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ? AND status = 'pending'`, [p.id]);
      if (anyPending.c > 0) throw new ApiError(403, `This approval level requires ${(await get(`SELECT required_role FROM approvals WHERE invoice_id = ? AND status='pending' ORDER BY level LIMIT 1`, [p.id]) || {}).required_role}`);
      throw new ApiError(409, 'invoice already fully approved');
    }
    await update('approvals', pending.id, { status: 'approved', approver_id: user.id, approver_name: user.name, comment: (req.body || {}).comment || null, decided_at: nowIso() });
    const remaining = await get(`SELECT COUNT(*) AS c FROM approvals WHERE invoice_id = ? AND status = 'pending'`, [p.id]);
    if (remaining.c === 0) {
      await update('invoices', p.id, { status: 'approved', approved_by: user.id, approved_at: nowIso() });
      queue.enqueue(coId, 'tally.syncVoucher', { invoiceId: p.id });
    }
    await audit(coId, user, 'invoice.approved', 'invoice', p.id, { invoice_no: inv.invoice_no, level: pending.level });
    ok(res, await get('SELECT * FROM invoices WHERE id = ?', [p.id]));
  });

  r.post('/api/invoices/:id/reject', async (req, res, p, user) => {
    const coId = companyOf(user);
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [p.id, coId]);
    if (!inv) throw new ApiError(404, 'invoice not found');
    await update('invoices', p.id, { status: 'rejected' });
    await run(`UPDATE approvals SET status='rejected', approver_id=?, approver_name=?, decided_at=? WHERE invoice_id=? AND status='pending'`, [user.id, user.name, nowIso(), p.id]);
    await audit(coId, user, 'invoice.rejected', 'invoice', p.id, { invoice_no: inv.invoice_no, comment: (req.body || {}).comment });
    ok(res, await get('SELECT * FROM invoices WHERE id = ?', [p.id]));
  });

  r.get('/api/approvals/pending', async (req, res, p, user) => {
    const rows = await all(`SELECT a.*, i.invoice_no, i.gross_amount, i.invoice_date, i.due_date, v.name AS vendor_name
      FROM approvals a JOIN invoices i ON i.id = a.invoice_id LEFT JOIN vendors v ON v.id = i.vendor_id
      WHERE a.company_id = ? AND a.status = 'pending' AND a.required_role = ?
      ORDER BY i.due_date ASC`, [companyOf(user), user.role]);
    ok(res, rows);
  });
}

module.exports = { register };
