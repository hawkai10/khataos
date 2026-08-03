'use strict';

// GST service helpers shared by the GST summary and dashboard routes.

const { get } = require('../db');
const { inr } = require('../util');

async function netPayableSum(coId, statuses) {
  const marks = statuses.map(() => '?').join(',');
  const r = await get(`SELECT COALESCE(SUM(net_payable),0) AS s FROM invoices WHERE company_id = ? AND status IN (${marks})`, [coId, ...statuses]);
  return inr(r.s);
}

module.exports = { netPayableSum };
