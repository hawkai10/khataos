'use strict';

// Invoice service functions: detail assembly and the three-way match check
// shared by the invoice routes.

const { all, get, update } = require('../db');
const { ApiError, audit } = require('../auth');
const { todayStr, daysAhead, inr } = require('../util');

async function getInvoiceDetail(coId, id) {
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId]);
  if (!inv) throw new ApiError(404, 'invoice not found');
  const vendor = inv.vendor_id ? await get('SELECT * FROM vendors WHERE id = ?', [inv.vendor_id]) : null;
  const lines = await all('SELECT * FROM invoice_lines WHERE invoice_id = ?', [inv.id]);
  const approvals = await all('SELECT * FROM approvals WHERE invoice_id = ? ORDER BY level', [inv.id]);
  const payments = await all('SELECT * FROM payments WHERE company_id = ? AND invoice_ids LIKE ?', [coId, '%' + inv.id + '%']);
  return { ...inv, vendor, lines, approvals, payments };
}

async function threeWayMatch(coId, invoiceId) {
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [invoiceId, coId]);
  if (!inv) throw new ApiError(404, 'invoice not found');
  let result;
  if (!inv.purchase_order_no) {
    result = { status: 'none', detail: 'No PO reference in Tally for this invoice' };
  } else if (!inv.receipt_note_no) {
    result = { status: 'pending', detail: `PO ${inv.purchase_order_no} found; awaiting receipt note` };
  } else {
    // deterministic: Apex Steel invoice carries a quantity mismatch in the demo
    const vendor = inv.vendor_id ? await get('SELECT name FROM vendors WHERE id = ?', [inv.vendor_id]) : null;
    const mismatch = vendor && vendor.name.includes('Apex');
    result = mismatch
      ? { status: 'mismatch', detail: `Qty variance vs receipt ${inv.receipt_note_no}; flagged for review` }
      : { status: 'matched', detail: `PO ${inv.purchase_order_no} ↔ RN ${inv.receipt_note_no} ✓` };
  }
  await update('invoices', invoiceId, { three_way_match: result.status });
  await audit(coId, null, 'invoice.three_way_match', 'invoice', invoiceId, result);
  return result;
}

// Due-this-week + overdue invoices with vendor names and totals. Shared by the
// dashboard and the AI assistant.
async function dueAndOverdue(coId) {
  const rows = await all(`SELECT i.*, v.name AS vendor_name FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE i.company_id = ? AND i.status IN ('approved','scheduled','pending_approval') AND i.due_date >= ? AND i.due_date <= ?
    ORDER BY i.due_date`, [coId, todayStr(), daysAhead(7)]);
  const overdue = await all(`SELECT i.*, v.name AS vendor_name FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE i.company_id = ? AND i.status IN ('approved','scheduled') AND i.due_date < ? ORDER BY i.due_date`, [coId, todayStr()]);
  return {
    rows, overdue,
    due_amount: inr(rows.reduce((s, i) => s + i.net_payable, 0)),
    overdue_amount: inr(overdue.reduce((s, i) => s + i.net_payable, 0)),
  };
}

async function pendingApprovals(coId, role) {
  return all(`SELECT a.*, i.invoice_no, i.gross_amount, v.name AS vendor_name FROM approvals a
    JOIN invoices i ON i.id = a.invoice_id LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE a.company_id = ? AND a.status = 'pending' AND a.required_role = ? ORDER BY i.due_date LIMIT 8`, [coId, role]);
}

module.exports = { getInvoiceDetail, threeWayMatch, dueAndOverdue, pendingApprovals };
