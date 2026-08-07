'use strict';

// Invoice service functions: detail assembly and the three-way match check
// shared by the invoice routes.

const { all, get, withTransaction, T } = require('../db');
const { eq } = require('drizzle-orm');
const { ApiError, audit } = require('../auth');
const { todayStr, daysAhead } = require('../util');
const { Money } = require('../money');
const { publicize, rupees } = require('../api/helpers');

async function getInvoiceDetail(coId, id) {
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [id, coId]);
  if (!inv) throw new ApiError(404, 'invoice not found');
  const vendor = inv.vendor_id ? await get('SELECT * FROM vendors WHERE id = ?', [inv.vendor_id]) : null;
  const lines = await all('SELECT * FROM invoice_lines WHERE invoice_id = ?', [inv.id]);
  const approvals = await all('SELECT * FROM approvals WHERE invoice_id = ? ORDER BY level', [inv.id]);
  const payments = await all('SELECT * FROM payments WHERE company_id = ? AND invoice_ids LIKE ?', [coId, '%' + inv.id + '%']);
  return { ...publicize(inv, 'invoices'), vendor, lines: publicize(lines, 'invoice_lines'), approvals, payments: publicize(payments, 'payments') };
}

async function threeWayMatch(coId, invoiceId) {
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', [invoiceId, coId]);
  if (!inv) throw new ApiError(404, 'invoice not found');
  // The three-way check needs PO, receipt-note AND invoice line data. This
  // build captures only the PO/RN reference numbers (and the invoice itself);
  // there is no PO/receipt line data to compare, so a 'matched'/'mismatch'
  // verdict would be fabricated. Report the real observations, and an explicit
  // 'unavailable' when the comparison itself cannot be computed.
  let result;
  if (!inv.purchase_order_no) {
    result = { status: 'none', detail: 'No PO reference in Tally for this invoice' };
  } else if (!inv.receipt_note_no) {
    result = { status: 'pending', detail: `PO ${inv.purchase_order_no} found; awaiting receipt note` };
  } else {
    result = {
      status: 'unavailable',
      detail: `PO ${inv.purchase_order_no} and RN ${inv.receipt_note_no} are referenced, but PO/receipt line data is not captured — the three-way match cannot be computed`,
    };
  }
  await withTransaction(async (tx) => {
    await tx.update(T.invoices).set({ three_way_match: result.status }).where(eq(T.invoices.id, invoiceId));
    await audit(coId, null, 'invoice.three_way_match', 'invoice', invoiceId, result, tx);
  });
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
    rows: publicize(rows, 'invoices'), overdue: publicize(overdue, 'invoices'),
    due_amount: Money.sum(rows.map((i) => Money.fromPaise(i.net_payable || 0))).toPaise(),
    overdue_amount: Money.sum(overdue.map((i) => Money.fromPaise(i.net_payable || 0))).toPaise(),
  };
}

async function pendingApprovals(coId, role) {
  const rows = await all(`SELECT a.*, i.invoice_no, i.gross_amount, v.name AS vendor_name FROM approvals a
    JOIN invoices i ON i.id = a.invoice_id LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE a.company_id = ? AND a.status = 'pending' AND a.required_role = ? ORDER BY i.due_date LIMIT 8`, [coId, role]);
  for (const r of rows) r.gross_amount = rupees(r.gross_amount);
  return rows;
}

module.exports = { getInvoiceDetail, threeWayMatch, dueAndOverdue, pendingApprovals };
