'use strict';

// Test-only hooks (Fastify plugin), active ONLY when KHATAOS_TEST_HOOKS=1 /
// KHATAOS_TEST_TENANT=1. They let the E2E suite create data inside the
// server's own process, which is required for the single-process pglite
// engine. Never enabled in production.

const { insert } = require('./db');
const { hashPassword, uid, nowIso, todayStr } = require('./util');

async function bootstrapTestTenant() {
  const coId = 'co_smoke';
  const today = todayStr();
  await insert('companies', { id: coId, name: 'Smoke Test Co', gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F', city: 'Bengaluru', plan: 'standard', settings: JSON.stringify({ payment_approval_threshold: 500000 }), created_at: nowIso() });
  for (const u of [
    { id: 'u_cfo', name: 'CFO Smoke', email: 'cfo@smoke.in', role: 'cfo' },
    { id: 'u_mgr', name: 'Mgr Smoke', email: 'manager@smoke.in', role: 'finance_manager' },
    { id: 'u_exec', name: 'Exec Smoke', email: 'exec@smoke.in', role: 'finance_executive' },
  ]) {
    await insert('users', { id: u.id, company_id: coId, name: u.name, email: u.email, password: hashPassword('test1234'), role: u.role, department: 'Finance', active: 1, created_at: nowIso() });
  }
  await insert('vendors', { id: 'v_smoke', company_id: coId, name: 'Smoke Vendor Traders', gstin: '29ABCDE1234F1Z5', ledger_name: 'Sundry Creditors - Smoke Vendor', tds_section: '194C', tds_rate: 0.02, credit_days: 30, active: 1 });
  await insert('bank_accounts', { id: 'acc_smoke', company_id: coId, bank_code: 'HDFC', account_name: 'HDFC Current', account_number: '502100000001', type: 'current', ifsc: 'HDFC0001234', status: 'active', source: 'direct_api', opened_at: today, last_synced_at: nowIso() });
  await insert('cash_daily', { id: uid('cd'), company_id: coId, account_id: 'acc_smoke', date: today, closing_balance: 2500000, source: 'direct_api' });
  await insert('bank_transactions', { id: 'btx_unmatched', company_id: coId, account_id: 'acc_smoke', external_id: 'BTX-1', txn_date: today, amount: -25000, description: 'NEFT OFFICE SUPPLIES', mode: 'NEFT', ref_no: 'NEFT-UNMATCHED', status: 'posted', matched: 0, created_at: nowIso() });
  for (const [step, detail] of [['connect_bank', 'linked'], ['install_tally', 'installed'], ['email_routing', 'active'], ['vendor_import', 'imported']]) {
    await insert('onboarding_steps', { company_id: coId, step, status: 'done', detail, at: nowIso() });
  }
  return coId;
}

async function registerTestHooks(fastify) {
  // Statement-shaped bank transaction (like Decentro.pull would write).
  fastify.post('/api/_test/bank-txn', async (request, reply) => {
    const b = request.body || {};
    await insert('bank_transactions', {
      id: b.id || uid('btx'), company_id: request.user.company_id, account_id: b.account_id || 'acc_smoke',
      external_id: b.external_id || 'EXT-' + Date.now(), txn_date: b.txn_date || todayStr(),
      amount: Number(b.amount) || 0, description: b.description || '', mode: b.mode || 'NEFT',
      ref_no: b.ref_no || null, status: 'posted', matched: 0, created_at: nowIso(),
    });
    reply.ok({ inserted: true });
  });

  // GSTR-2B snapshot (like a real GSP fetch would store).
  fastify.post('/api/_test/gstr2b', async (request, reply) => {
    const b = request.body || {};
    const period = b.period || todayStr().slice(0, 7);
    await insert('gstr2b_snapshots', {
      id: uid('g2b'), company_id: request.user.company_id, period, gstin: b.gstin || null,
      total_itc: 0, itc_cgst: 0, itc_sgst: 0, itc_igst: 0,
      data_json: JSON.stringify(b.data_json || []), cdnr_json: JSON.stringify(b.cdnr_json || []),
      source: 'gstn-live', fetched_at: nowIso(),
    });
    reply.ok({ inserted: true, period });
  });
}

module.exports = { bootstrapTestTenant, registerTestHooks };
