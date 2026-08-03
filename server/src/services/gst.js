'use strict';

// GST service helpers shared by the GST summary and dashboard routes.

const { all, get } = require('../db');
const { inr } = require('../util');

async function netPayableSum(coId, statuses) {
  const marks = statuses.map(() => '?').join(',');
  const r = await get(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN (${marks})`, [coId, ...statuses]);
  return inr(r.s);
}

// Latest snapshot + approved liability + open mismatches. Shared by the
// dashboard and the AI assistant.
async function position(coId) {
  const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
  const liability = await netPayableSum(coId, ['approved', 'scheduled']);
  const mismatches = await all(`SELECT * FROM gst_mismatches WHERE company_id = ? AND status = 'open' ORDER BY period DESC`, [coId]);
  return {
    itc: snap ? snap.total_itc : 0,
    period: snap ? snap.period : null,
    fetched_at: snap ? snap.fetched_at : null,
    liability,
    mismatches,
  };
}

module.exports = { netPayableSum, position };
