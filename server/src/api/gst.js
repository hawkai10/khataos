'use strict';

// GST domain: GSTR-2B summary/refresh/export and the GSTN/GSP auth contract.

const { get, all } = require('../db');
const { inr } = require('../util');
const { audit } = require('../auth');
const { GstDataProvider } = require('../adapters');
const Gstn = require('../gstn');
const Gst = require('../services/gst');
const { bodyOf } = require('./validators');
const { companyOf, parseUrl, queryParam } = require('./helpers');

function register(r, deps) {
  const { ok } = deps;

  r.get('/api/gst/summary', async (req, res, p, user) => {
    const coId = companyOf(user);
    const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? ORDER BY period DESC LIMIT 1', [coId]);
    const liability = await Gst.netPayableSum(coId, ['approved', 'scheduled']);
    const committed = await Gst.netPayableSum(coId, ['approved', 'scheduled', 'pending_approval']);
    const mismatches = await all(`SELECT * FROM gst_mismatches WHERE company_id = ? AND status = 'open' ORDER BY period DESC`, [coId]);
    const periods = await all('SELECT period, MAX(fetched_at) AS fetched_at FROM gstr2b_snapshots WHERE company_id = ? GROUP BY period ORDER BY period DESC', [coId]);
    ok(res, {
      itc: snap ? snap.total_itc : 0, itc_cgst: snap ? snap.itc_cgst : 0,
      itc_sgst: snap ? snap.itc_sgst : 0, itc_igst: snap ? snap.itc_igst : 0,
      period: snap ? snap.period : null, fetched_at: snap ? snap.fetched_at : null,
      liability, committed, mismatch_count: mismatches.length, mismatches, periods,
    });
  });

  r.post('/api/gst/refresh', async (req, res, p, user) => {
    const coId = companyOf(user);
    const period = GstDataProvider.currentPeriod();
    await GstDataProvider.fetchGstr2b(coId, period);
    const mismatches = await GstDataProvider.scanMismatches(coId, period);
    await audit(coId, user, 'gst.refresh', 'gstr2b', period, { mismatches: mismatches.length });
    ok(res, { period, mismatches: mismatches.length });
  });

  r.get('/api/gst/export', async (req, res, p, user) => {
    const coId = companyOf(user);
    const u = parseUrl(req);
    const type = queryParam(u, 'type', 'gstr3b');
    const period = queryParam(u, 'period', GstDataProvider.currentPeriod());
    let csv;
    if (type === 'gstr2b') {
      const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? AND period = ? ORDER BY fetched_at DESC LIMIT 1', [coId, period]);
      const rows = snap ? JSON.parse(snap.data_json || '[]') : [];
      csv = 'period,gstin,invoice_no,taxable,cgst,sgst,igst\n' + rows.map((g) => `${period},${g.gstin},${g.invoice_no},${g.taxable},${g.cgst},${g.sgst},${g.igst}`).join('\n');
    } else {
      csv = 'field,amount\n' + await GstDataProvider.exportGstr3b(coId, period);
    }
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${type}_${period}.csv"` });
    res.end(csv);
  });

  // ---- GSTN / GSP (GSTR-2B + e-invoice contract) ----
  r.get('/api/gstn/config', async (req, res) => {
    ok(res, Gstn.config());
  });

  r.post('/api/gstn/otp/request', async (req, res, p, user) => {
    const coId = companyOf(user);
    const out = await Gstn.requestOtp();
    await audit(coId, user, 'gstn.otp_request', 'gstn', null, { mode: out.mode, gstin: out.gstin });
    ok(res, out);
  });

  r.post('/api/gstn/otp/validate', async (req, res, p, user) => {
    const coId = companyOf(user);
    const { otp } = bodyOf(req);
    const out = await Gstn.validateOtp(otp);
    await audit(coId, user, 'gstn.otp_validated', 'gstn', null, { mode: out.mode, expiry_minutes: out.expiry_minutes });
    ok(res, out);
  });
}

module.exports = { register };
