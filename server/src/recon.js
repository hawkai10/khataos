'use strict';

// Automatic bank reconciliation engine.
// Primary: amount, date, reference. Fuzzy: tolerance windows. Combined:
// multiple bank debits sum to one payment. Target: >= 70% automatic matching.

const { all, get, insert, run } = require('./db');
const { uid, nowIso, diffDays, inr, daysAgo } = require('./util');

function amountClose(a, b, tol = 1) { return Math.abs(a - b) <= tol; }

function safeParse(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}

function billRefsOf(entries) {
  const out = [];
  for (const e of entries || []) for (const r of e.bill_refs || []) out.push(r);
  return out;
}

// Index the imported Tally vouchers (ground truth for Tally-side activity)
// plus the KhataOS references a BILLALLOCATIONS entry can tie to.
async function loadTallyIndex(companyId) {
  // Cancelled vouchers are stored for audit but are never recon candidates.
  const vouchers = await all('SELECT * FROM tally_vouchers WHERE company_id = ? AND cancelled = 0', [companyId]);
  const parsed = vouchers.map((v) => {
    const entries = safeParse(v.entry_json);
    return { ...v, entries, billRefs: billRefsOf(entries) };
  });
  const vendors = await all('SELECT ledger_name FROM vendors WHERE company_id = ? AND active = 1', [companyId]);
  const vendorLedgers = new Set(vendors.map((v) => v.ledger_name).filter(Boolean));
  const invoices = await all('SELECT invoice_no FROM invoices WHERE company_id = ?', [companyId]);
  const payments = await all('SELECT reference FROM payments WHERE company_id = ? AND reference IS NOT NULL', [companyId]);
  return {
    vouchers: parsed,
    vendorLedgers,
    invoiceNos: new Set(invoices.map((i) => i.invoice_no)),
    payRefs: new Set(payments.map((p) => p.reference)),
  };
}

// Strong match: BILLALLOCATIONS ref ties a Receipt/Payment voucher to a
// KhataOS invoice or payment. A ref with a different amount is a MISMATCH,
// never a false match. Fallback: amount + date + party (known vendor ledger).
function findTallyMatch(txn, index) {
  const outflow = Number(txn.amount) < 0;
  const directionOk = (v) => {
    const t = String(v.voucher_type || '').toLowerCase();
    return outflow ? ['payment', 'contra', 'journal', 'purchase'].includes(t) : ['receipt', 'sales', 'journal'].includes(t);
  };
  const absAmt = Math.abs(Number(txn.amount) || 0);
  // Strong pass: BILLALLOCATIONS ref ties to a KhataOS invoice or payment.
  // Scanned across ALL vouchers so a ref conflict is flagged regardless of
  // direction; the actual match still requires the right voucher direction.
  for (const v of index.vouchers) {
    if (!v.billRefs.length) continue;
    const ref = v.billRefs.find((r) => index.invoiceNos.has(r) || index.payRefs.has(r));
    if (!ref) continue;
    const voucherAmt = Math.abs(Number(v.amount) || 0);
    if (!amountClose(absAmt, voucherAmt)) {
      return { mismatch: { voucher: v, ref, expected: absAmt, actual: voucherAmt } };
    }
    if (!directionOk(v)) continue;
    return { match: { voucher: v, ref, type: 'billref', confidence: 0.97 } };
  }
  const candidates = index.vouchers.filter(directionOk);
  for (const v of candidates) {
    const voucherAmt = Math.abs(Number(v.amount) || 0);
    if (!amountClose(absAmt, voucherAmt)) continue;
    if (Math.abs(diffDays(v.date, txn.txn_date)) > 3) continue;
    if (!v.party_name || !index.vendorLedgers.has(v.party_name)) continue;
    return { match: { voucher: v, ref: null, type: 'fuzzy', confidence: 0.78 } };
  }
  return null;
}

async function matchPending(paymentId) {
  const p = await get('SELECT * FROM payments WHERE id = ?', [paymentId]);
  if (!p) return;
  const txn = await get(`SELECT * FROM bank_transactions WHERE company_id = ? AND matched = 0 AND ref_no = ? AND amount < 0`,
    [p.company_id, p.reference]);
  if (txn) {
    await markMatched(txn.id, paymentId, 'exact', 0.99, 'auto');
  }
}

function localHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// New bank activity arrives unmatched; match it against real imported Tally
// vouchers (bill-ref first, then amount+date+party).
async function autoVoucherMatch(companyId, days = 7) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const txns = await all(`SELECT * FROM bank_transactions WHERE company_id = ? AND matched = 0 AND status = 'posted' AND txn_date >= ?`, [companyId, since]);
  const tallyIndex = await loadTallyIndex(companyId);
  let matched = 0;
  for (const t of txns) {
    const tv = findTallyMatch(t, tallyIndex);
    if (!tv || !tv.match) continue;
    const mt = tv.match;
    await insert('recon_matches', {
      id: uid('rm'), company_id: companyId, bank_txn_id: t.id, payment_id: null,
      tally_voucher_no: mt.voucher.voucher_number, match_type: mt.type, confidence: mt.confidence,
      status: 'matched', matched_by: 'auto', matched_at: nowIso(),
      notes: mt.ref ? `Matched against Tally voucher #${mt.voucher.voucher_number} (${mt.ref})` : `Matched against Tally voucher #${mt.voucher.voucher_number}`,
    });
    await run('UPDATE bank_transactions SET matched = 1 WHERE id = ?', [t.id]);
    matched++;
  }
  return matched;
}

async function markMatched(bankTxnId, paymentId, type, confidence, by) {
  const txn = await get('SELECT company_id FROM bank_transactions WHERE id = ?', [bankTxnId]);
  await insert('recon_matches', {
    id: uid('rm'), company_id: txn.company_id,
    bank_txn_id: bankTxnId, payment_id: paymentId || null,
    match_type: type, confidence, status: 'matched', matched_by: by,
    matched_at: nowIso(),
  });
  await run('UPDATE bank_transactions SET matched = 1, matched_id = ? WHERE id = ?', [paymentId || '', bankTxnId]);
}

// Run the full matching pass. Returns stats.
async function matchAll(companyId) {
  const candidates = await all(`
    SELECT * FROM bank_transactions
    WHERE company_id = ? AND matched = 0 AND status = 'posted' AND amount < 0
    ORDER BY txn_date`, [companyId]);

  const payments = await all(`SELECT * FROM payments WHERE company_id = ? AND status IN ('completed','processing')`, [companyId]);

  // Approved invoices without payments act as Tally purchase-voucher candidates.
  const vouchers = await all(`
    SELECT i.* FROM invoices i
    WHERE i.company_id = ? AND i.status IN ('approved','paid','scheduled')
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.company_id = i.company_id AND p.status IN ('completed','processing','pending','approved') AND p.invoice_ids LIKE '%' || i.id || '%')`,
    [companyId]);
  const tallyIndex = await loadTallyIndex(companyId);

  let auto = 0, total = 0;
  for (const txn of candidates) {
    total += 1;
    // 1) exact reference match
    let hit = payments.find(p => (p.reference && p.reference === txn.ref_no) && amountClose(txn.amount, -p.net_amount));
    if (hit) { await markMatched(txn.id, hit.id, 'exact', 0.99, 'auto'); auto++; continue; }

    // 2) exact amount + date window
    hit = payments.find(p => amountClose(txn.amount, -p.net_amount) && Math.abs(diffDays(p.processed_at ? p.processed_at.slice(0, 10) : p.scheduled_date, txn.txn_date)) <= 3);
    if (hit) { await markMatched(txn.id, hit.id, 'exact', 0.93, 'auto'); auto++; continue; }

    // 3) fuzzy: amount within ₹1, date within 5 days
    hit = payments.find(p => Math.abs(Math.abs(txn.amount) - p.net_amount) <= 1 && Math.abs(diffDays(p.processed_at ? p.processed_at.slice(0, 10) : p.scheduled_date, txn.txn_date)) <= 5);
    if (hit) { await markMatched(txn.id, hit.id, 'fuzzy', 0.68, 'auto'); auto++; continue; }

    // 4) real Tally voucher match (imported XML): bill-ref first, then
    //    amount + date + party. A bill-ref with a different amount is
    //    recorded as a mismatch, never silently force-matched.
    const tv = findTallyMatch(txn, tallyIndex);
    if (tv && tv.mismatch) {
      const m = tv.mismatch;
      await insert('recon_matches', {
        id: uid('rm'), company_id: companyId, bank_txn_id: txn.id, payment_id: null,
        tally_voucher_no: m.voucher.voucher_number, match_type: 'billref', confidence: 0.5,
        status: 'mismatch', matched_by: 'auto', matched_at: nowIso(),
        notes: `Tally voucher #${m.voucher.voucher_number} references ${m.ref} but amount differs (bank ${inr(m.expected)} vs voucher ${inr(m.actual)})`,
      });
      continue;
    }
    if (tv && tv.match) {
      const mt = tv.match;
      await insert('recon_matches', {
        id: uid('rm'), company_id: companyId, bank_txn_id: txn.id, payment_id: null,
        tally_voucher_no: mt.voucher.voucher_number, match_type: mt.type, confidence: mt.confidence,
        status: 'matched', matched_by: 'auto', matched_at: nowIso(),
        notes: mt.ref ? `Matched against Tally voucher #${mt.voucher.voucher_number} (${mt.ref})` : `Matched against Tally voucher #${mt.voucher.voucher_number}`,
      });
      await run('UPDATE bank_transactions SET matched = 1 WHERE id = ?', [txn.id]);
      auto++; continue;
    }

    // 5) KhataOS invoice fallback (approved invoice, no payment, no Tally
    //    voucher imported yet). Labeled as KhataOS-side, not authoritative.
    hit = vouchers.find(v => amountClose(txn.amount, -v.net_payable) && Math.abs(diffDays(v.invoice_date, txn.txn_date)) <= 4);
    if (hit) {
      await insert('recon_matches', {
        id: uid('rm'), company_id: companyId, bank_txn_id: txn.id,
        payment_id: null, tally_voucher_no: null,
        match_type: 'fuzzy', confidence: 0.66, status: 'matched', matched_by: 'auto',
        matched_at: nowIso(), notes: `Matched against KhataOS invoice ${hit.invoice_no} (no Tally voucher imported)`,
      });
      await run('UPDATE bank_transactions SET matched = 1 WHERE id = ?', [txn.id]);
      auto++; continue;
    }
  }

  // Combined matches: two small debits within 2 days summing to a payment.
  const unmatched = await all(`SELECT * FROM bank_transactions WHERE company_id = ? AND matched = 0 AND status = 'posted' AND amount < 0 ORDER BY txn_date`, [companyId]);
  for (let i = 0; i < unmatched.length; i++) {
    for (let j = i + 1; j < unmatched.length; j++) {
      const a = unmatched[i], b = unmatched[j];
      if (Math.abs(diffDays(a.txn_date, b.txn_date)) > 2) continue;
      const sum = a.amount + b.amount;
      const hit = payments.find(p => amountClose(sum, -p.net_amount));
      if (hit) {
        await markMatched(a.id, hit.id, 'combined', 0.55, 'auto');
        await markMatched(b.id, hit.id, 'combined', 0.55, 'auto');
        auto += 2; total += 1;
        break;
      }
    }
  }

  return { auto, total, accuracy: total ? inr((auto / total) * 100) : 0 };
}

// Score for display: auto-matched / total posted txns (all accounts, 30 days).
async function score(companyId) {
  const stats = await get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END) AS matched,
      SUM(CASE WHEN matched = 1 AND EXISTS (SELECT 1 FROM recon_matches rm WHERE rm.bank_txn_id = bank_transactions.id AND rm.match_type IN ('exact','fuzzy','combined','billref')) THEN 1 ELSE 0 END) AS auto_matched
    FROM bank_transactions
    WHERE company_id = ? AND status = 'posted' AND txn_date >= ?`, [companyId, daysAgo(29)]);
  const total = stats.total || 0;
  const auto = stats.auto_matched || 0;
  return {
    total, matched: stats.matched || 0, auto_matched: auto,
    manual_matched: (stats.matched || 0) - auto,
    accuracy: total ? inr((auto / total) * 100) : 0,
    target: 70,
  };
}

module.exports = { matchAll, score, markMatched, matchPending, autoVoucherMatch, findTallyMatch, loadTallyIndex, safeParse, billRefsOf };
