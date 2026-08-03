'use strict';

// Payables aging: imported Tally purchase vouchers netted by same-vendor
// Debit Notes, bucketed by age. The SQL + netting logic lives here so the
// route handler stays a thin wrapper.

const { all } = require('../db');
const { todayStr, inr } = require('../util');

async function payablesAging(coId) {
  const purchases = await all(`SELECT voucher_number, date, amount, party_name FROM tally_vouchers WHERE company_id = ? AND voucher_type = 'Purchase' AND cancelled = 0 ORDER BY date`, [coId]);
  const debitNotes = await all(`SELECT amount, party_name FROM tally_vouchers WHERE company_id = ? AND voucher_type = 'Debit Note' AND cancelled = 0 ORDER BY date`, [coId]);
  // Debit Notes reduce what we owe their vendor (purchase returns/price
  // adjustments). Net each vendor's outstanding purchase total against the
  // sum of their Debit Notes before bucketing; the reduction is applied
  // oldest-purchase-first, the standard FIFO assumption for settlements.
  const dnByParty = new Map();
  for (const d of debitNotes) {
    if (!d.party_name) continue;
    dnByParty.set(d.party_name, (dnByParty.get(d.party_name) || 0) + Math.abs(d.amount || 0));
  }
  const today = Date.parse(todayStr());
  const buckets = { current: 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const items = [];
  for (const v of purchases) {
    let net = Math.abs(v.amount || 0);
    if (v.party_name && dnByParty.has(v.party_name)) {
      const applied = Math.min(net, dnByParty.get(v.party_name));
      net -= applied;
      const remaining = dnByParty.get(v.party_name) - applied;
      if (remaining <= 0) dnByParty.delete(v.party_name); else dnByParty.set(v.party_name, remaining);
    }
    if (net <= 0) continue; // fully offset by Debit Notes
    const age = Math.max(0, Math.floor((today - Date.parse(v.date)) / 86400000));
    const bucket = age <= 30 ? 'current' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+';
    buckets[bucket] += net;
    items.push({ voucher_number: v.voucher_number, date: v.date, party_name: v.party_name, age, bucket, amount: inr(net) });
  }
  return { buckets, total: inr(items.reduce((s, i) => s + i.amount, 0)), items };
}

module.exports = { payablesAging };
