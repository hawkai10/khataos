'use strict';

// Payables aging: imported Tally purchase vouchers netted by same-vendor
// Debit Notes, bucketed by age. The SQL + netting logic lives here so the
// route handler stays a thin wrapper.

const { all } = require('../db');
const { todayStr } = require('../util');
const { Money } = require('../money');
const { rupees } = require('../api/helpers');

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
    const current = dnByParty.get(d.party_name) || Money.fromPaise(0);
    dnByParty.set(d.party_name, current.plus(Money.fromPaise(Math.abs(Number(d.amount) || 0))));
  }
  const today = Date.parse(todayStr());
  const buckets = { current: Money.fromPaise(0), '31-60': Money.fromPaise(0), '61-90': Money.fromPaise(0), '90+': Money.fromPaise(0) };
  const items = [];
  for (const v of purchases) {
    let net = Money.fromPaise(Math.abs(Number(v.amount) || 0));
    if (v.party_name && dnByParty.has(v.party_name)) {
      const availableDn = dnByParty.get(v.party_name);
      const applied = net.lte(availableDn) ? net : availableDn;
      net = net.minus(applied);
      const remaining = availableDn.minus(applied);
      if (remaining.isZero()) dnByParty.delete(v.party_name); else dnByParty.set(v.party_name, remaining);
    }
    if (net.isZero()) continue; // fully offset by Debit Notes
    const age = Math.max(0, Math.floor((today - Date.parse(v.date)) / 86400000));
    const bucket = age <= 30 ? 'current' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+';
    buckets[bucket] = buckets[bucket].plus(net);
    items.push({ voucher_number: v.voucher_number, date: v.date, party_name: v.party_name, age, bucket, amount: rupees(net) });
  }
  const bucketRupees = Object.fromEntries(Object.entries(buckets).map(([k, m]) => [k, rupees(m)]));
  return { buckets: bucketRupees, total: rupees(Money.sum(Object.values(buckets))), items };
}

module.exports = { payablesAging };
