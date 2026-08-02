'use strict';

// Deterministic-ish demo tenant: Acme Industries Pvt Ltd, GSTIN 29AABCA1234F1Z5.
// Seeds users, banks/accounts, vendors, invoices in every workflow state,
// payments, bank history (via adapter), reconciliation, GSTR-2B, Tally health.

const { db, insert, all, get } = require('./db');
const { mulberry32, uid, nowIso, todayStr, daysAgo, addDays, inr, hashPassword } = require('./util');
const { BankDataProvider, GstDataProvider, TallyConnector } = require('./adapters');

const rng = mulberry32(20260802);

function pinv(r) { return Math.round(r * 100) / 100; }

function seedIfEmpty() {
  const existing = get('SELECT COUNT(*) AS c FROM companies');
  if (existing.c > 0) return false;
  seed();
  return true;
}

function seed() {
  const now = nowIso();
  const coId = 'co_acme';
  const gstin = '29AABCA1234F1Z5';
  const pan = 'AABCA1234F';
  const today = todayStr();

  insert('companies', {
    id: coId, name: 'Acme Industries Pvt Ltd', gstin, pan,
    city: 'Bengaluru', plan: 'standard',
    trial_ends_at: addDays(today, 9),
    settings: JSON.stringify({ cfo_approval_threshold: 100000, payment_approval_threshold: 500000, tally_version: 'TallyPrime 4.2' }),
    created_at: now,
  });

  const users = [
    { id: 'u_cfo', name: 'Ananya Iyer', email: 'cfo@acme.in', role: 'cfo', department: 'Finance' },
    { id: 'u_mgr', name: 'Rohit Sharma', email: 'manager@acme.in', role: 'finance_manager', department: 'Accounts Payable' },
    { id: 'u_exec', name: 'Priya Nair', email: 'exec@acme.in', role: 'finance_executive', department: 'Accounts Payable' },
  ];
  for (const u of users) {
    insert('users', {
      id: u.id, company_id: coId, name: u.name, email: u.email,
      password: hashPassword('demo1234'), role: u.role, department: u.department,
      active: 1, created_at: now,
    });
  }

  // Supported bank directory (AA + direct API coverage)
  const bankRows = [
    ['ICIC', 'ICICI Bank', 'aa', 1], ['HDFC', 'HDFC Bank', 'aa', 1], ['AXIS', 'Axis Bank', 'aa', 1],
    ['KKBK', 'Kotak Mahindra Bank', 'aa', 1], ['YESB', 'Yes Bank', 'aa', 1], ['SBIN', 'State Bank of India', 'aa', 1],
    ['PUNB', 'Punjab National Bank', 'aa', 1], ['BARB', 'Bank of Baroda', 'aa', 1], ['UBIN', 'Union Bank of India', 'aa', 1],
    ['CNRB', 'Canara Bank', 'aa', 1], ['IDFB', 'IDFC First Bank', 'aa', 1], ['INDB', 'IndusInd Bank', 'aa', 1],
    ['FDRL', 'Federal Bank', 'aa', 1], ['DCBL', 'DCB Bank', 'aa', 1], ['RATN', 'RBL Bank', 'aa', 1],
    ['AUBL', 'AU Small Finance Bank', 'aa', 1], ['DBSS', 'DBS Bank India', 'aa', 1],
  ];
  for (const [code, name, kind, aa] of bankRows) insert('banks', { code, name, kind, aa_supported: aa });

  // Accounts
  const accounts = [
    { id: 'acc_icici', bank_code: 'ICIC', name: 'ICICI Current - Operations', num: '002201045678', type: 'current', ifsc: 'ICIC0000022', source: 'aa', opening: 4200000 },
    { id: 'acc_hdfc', bank_code: 'HDFC', name: 'HDFC Current - Payables', num: '502100456789', type: 'current', ifsc: 'HDFC0001234', source: 'aa', opening: 2800000 },
    { id: 'acc_axis', bank_code: 'AXIS', name: 'Axis Current - Collections', num: '918010045678', type: 'current', ifsc: 'UTIB0000045', source: 'aa', opening: 1650000 },
    { id: 'acc_kotak', bank_code: 'KKBK', name: 'Kotak Current - Statutory', num: '041201234567', type: 'current', ifsc: 'KKBK0000820', source: 'aa', opening: 900000 },
    { id: 'acc_yes', bank_code: 'YESB', name: 'Yes Bank Current - Ops B', num: '089301234567', type: 'current', ifsc: 'YESB0000046', source: 'direct_api', opening: 540000 },
    { id: 'acc_sbi', bank_code: 'SBIN', name: 'SBI Current - Salary', num: '35021234567', type: 'current', ifsc: 'SBIN0000456', source: 'aa', opening: 1250000 },
  ];
  for (const a of accounts) {
    insert('bank_accounts', {
      id: a.id, company_id: coId, bank_code: a.bank_code, account_name: a.name,
      account_number: a.num, type: a.type, ifsc: a.ifsc, status: 'active',
      source: a.source, consent_id: a.source === 'aa' ? `AA-CONSENT-${a.num.slice(-6)}` : null,
      opened_at: daysAgo(400),
    });
  }

  // Vendors
  const vendors = [
    { id: 'v_cement', name: 'Shree Cement Traders', gstin: '29AABCS2345K1Z2', pan: 'AABCS2345K', bank_account: '50210045678912', ifsc: 'HDFC0001234', upi: 'shreecement@hdfcbank', email: 'billing@shreecementtraders.in', ledger: 'Sundry Creditors - Shree Cement Traders', tds_section: '194C', tds_rate: 0.02, credit_days: 30, category: 'Raw Material' },
    { id: 'v_kumar', name: 'Kumar Logistics LLP', gstin: '29AABFK1234P1Z8', pan: 'AABFK1234P', bank_account: '002201098765', ifsc: 'ICIC0000022', upi: 'kumarlogistics@icici', email: 'accounts@kumarlogistics.in', ledger: 'Sundry Creditors - Kumar Logistics', tds_section: '194C', tds_rate: 0.02, credit_days: 15, category: 'Logistics' },
    { id: 'v_apex', name: 'Apex Steel Works', gstin: '29AAJPA5678K1Z7', pan: 'AAJPA5678K', bank_account: '918010099887', ifsc: 'UTIB0000045', upi: 'apexsteel@axisbank', email: 'billing@apexsteel.in', ledger: 'Sundry Creditors - Apex Steel', tds_section: '194C', tds_rate: 0.02, credit_days: 45, category: 'Raw Material' },
    { id: 'v_mehta', name: 'Mehta Packaging Pvt Ltd', gstin: '27AAECM4321Q1Z3', pan: 'AAECM4321Q', bank_account: '041201555666', ifsc: 'KKBK0000820', upi: 'mehtapackaging@kotak', email: 'finance@mehtapackaging.in', ledger: 'Sundry Creditors - Mehta Packaging', tds_section: '194C', tds_rate: 0.02, credit_days: 30, category: 'Packaging' },
    { id: 'v_global', name: 'Global Freight LLP', gstin: '29AABFG8765P1Z1', pan: 'AABFG8765P', bank_account: '089301122334', ifsc: 'YESB0000046', upi: 'globalfreight@yesbank', email: 'ops@globalfreight.in', ledger: 'Sundry Creditors - Global Freight', tds_section: '194C', tds_rate: 0.02, credit_days: 20, category: 'Logistics' },
    { id: 'v_vijay', name: 'Vijay Electricals & Co', gstin: '29AAHFV3344M1Z9', pan: 'AAHFV3344M', bank_account: '350211223344', ifsc: 'SBIN0000456', upi: 'vijayelectricals@sbi', email: 'contact@vijayelectricals.in', ledger: 'Sundry Creditors - Vijay Electricals', tds_section: '194C', tds_rate: 0.02, credit_days: 30, category: 'Services' },
    { id: 'v_legal', name: 'Krishna & Associates (Legal)', gstin: '29AAECK5566P1Z5', pan: 'AAECK5566P', bank_account: '918010077665', ifsc: 'UTIB0000045', upi: 'krishnalegal@axisbank', email: 'billing@krishnalegal.in', ledger: 'Sundry Creditors - Krishna Legal', tds_section: '194J', tds_rate: 0.10, credit_days: 15, category: 'Professional' },
    { id: 'v_sai', name: 'Sai Traders & Co', gstin: '29AABFS7788K1Z4', pan: 'AABFS7788K', bank_account: '002201234567', ifsc: 'ICIC0000022', upi: 'saitraders@icici', email: 'sai@saitraders.in', ledger: 'Sundry Creditors - Sai Traders', tds_section: '194C', tds_rate: 0.02, credit_days: 30, category: 'Raw Material' },
  ];
  for (const v of vendors) {
    insert('vendors', {
      id: v.id, company_id: coId, name: v.name, gstin: v.gstin, pan: v.pan,
      bank_account: v.bank_account, ifsc: v.ifsc, upi_id: v.upi, email: v.email,
      ledger_name: v.ledger, tds_section: v.tds_section, tds_rate: v.tds_rate,
      credit_days: v.credit_days, category: v.category, active: 1,
    });
  }

  // Invoices across every state
  const inv = (i, opts) => {
    const taxable = inr(opts.taxable);
    const inter = opts.inter || false;
    const cgst = inter ? 0 : inr(taxable * 0.09);
    const sgst = inter ? 0 : inr(taxable * 0.09);
    const igst = inter ? inr(taxable * 0.18) : 0;
    const gross = inr(taxable + cgst + sgst + igst);
    const v = vendors.find(x => x.id === opts.vendor);
    const tds = inr(gross * (v ? v.tds_rate : 0));
    const id = `inv_${i}`;
    insert('invoices', {
      id, company_id: coId, invoice_no: opts.no, vendor_id: opts.vendor,
      invoice_date: opts.date, due_date: opts.due || addDays(opts.date, v ? v.credit_days : 30),
      source: opts.source || 'email', status: opts.status,
      gross_amount: gross, taxable_amount: taxable, cgst, sgst, igst, cess: 0,
      tds_amount: tds, net_payable: inr(gross - tds),
      gstin_vendor: v ? v.gstin : null,
      hsns: JSON.stringify([{ hsn: opts.hsn || '2523', description: opts.desc || 'Goods', qty: 1, rate: taxable }]),
      purchase_order_no: opts.po || null, receipt_note_no: opts.receipt || null,
      three_way_match: opts.twm || 'none',
      ocr_json: JSON.stringify({ engine: 'mock-ocr-indian-gst-v1', confidence: 0.95 }),
      notes: opts.notes || null,
      created_by: opts.created_by || 'email-forward',
      approved_by: opts.approved_by || null, approved_at: opts.approved_at || null,
      paid_at: opts.paid_at || null, created_at: now,
    });
    insert('invoice_lines', {
      id: uid('l'), invoice_id: id, hsn: opts.hsn || '2523', description: opts.desc || 'Goods',
      qty: 1, rate: taxable, taxable, cgst, sgst, igst, cess: 0,
    });
    return { id, gross, tds, net: inr(gross - tds), cgst, sgst, igst };
  };

  const appr = (invoiceId, level, role, status, approverId, approverName, comment, at) => {
    insert('approvals', {
      id: uid('app'), company_id: coId, invoice_id: invoiceId, level, required_role: role,
      threshold_note: level === 2 ? '> ₹1,00,000 requires CFO' : 'standard route',
      status, approver_id: approverId || null, approver_name: approverName || null,
      comment: comment || null, decided_at: at || null,
    });
  };

  // ---- paid invoices (linked to completed payments) ----
  inv(1, { no: 'INV-2026-0114', vendor: 'v_cement', date: daysAgo(31), status: 'paid', taxable: 1850000, source: 'email', po: 'PO-2026-118', receipt: 'RN-2026-031', twm: 'matched', paid_at: daysAgo(2) });
  inv(2, { no: 'INV-2026-0102', vendor: 'v_kumar', date: daysAgo(28), status: 'paid', taxable: 320000, source: 'pdf_upload', po: 'PO-2026-102', receipt: 'RN-2026-028', twm: 'matched', paid_at: daysAgo(4) });
  inv(3, { no: 'INV-2026-0095', vendor: 'v_apex', date: daysAgo(25), status: 'paid', taxable: 640000, source: 'manual', po: 'PO-2026-095', twm: 'matched', paid_at: daysAgo(6) });
  inv(4, { no: 'INV-2026-0128', vendor: 'v_mehta', date: daysAgo(19), status: 'paid', taxable: 210000, source: 'email', twm: 'none', paid_at: daysAgo(3) });

  // ---- approved, awaiting payment ----
  inv(5, { no: 'INV-2026-0134', vendor: 'v_cement', date: daysAgo(12), due: addDays(today, 2), status: 'approved', taxable: 760000, source: 'email', po: 'PO-2026-131', receipt: 'RN-2026-045', twm: 'matched', approved_by: 'u_cfo', approved_at: daysAgo(1) });
  inv(6, { no: 'INV-2026-0139', vendor: 'v_vijay', date: daysAgo(9), due: daysAgo(1), status: 'approved', taxable: 185000, source: 'pdf_upload', po: 'PO-2026-120', twm: 'mismatch', approved_by: 'u_mgr', approved_at: daysAgo(2), notes: 'Qty mismatch vs receipt note - flagged for review' });
  inv(7, { no: 'INV-2026-0145', vendor: 'v_legal', date: daysAgo(6), due: daysAgo(2), status: 'approved', taxable: 95000, inter: true, source: 'email', twm: 'none', approved_by: 'u_mgr', approved_at: daysAgo(1), notes: 'Professional fees - quarterly retainer' });

  // ---- pending approval ----
  inv(8, { no: 'INV-2026-0148', vendor: 'v_kumar', date: daysAgo(4), due: addDays(today, 8), status: 'pending_approval', taxable: 240000, source: 'email', po: 'PO-2026-140', twm: 'pending' });
  inv(9, { no: 'INV-2026-0152', vendor: 'v_cement', date: daysAgo(2), due: addDays(today, 28), status: 'pending_approval', taxable: 1250000, source: 'email', po: 'PO-2026-145', twm: 'pending' });
  inv(10, { no: 'INV-2026-0156', vendor: 'v_sai', date: daysAgo(1), due: addDays(today, 20), status: 'pending_approval', taxable: 88000, source: 'manual', twm: 'none' });

  // ---- captured / validation ----
  inv(11, { no: 'INV-2026-0158', vendor: 'v_global', date: today, due: addDays(today, 20), status: 'captured', taxable: 0, source: 'pdf_upload', twm: 'none', notes: 'OCR confidence low - awaiting data validation' });
  inv(12, { no: 'INV-2026-0130', vendor: 'v_apex', date: daysAgo(15), due: daysAgo(4), status: 'validation_failed', taxable: 420000, source: 'email', twm: 'none', notes: 'GSTIN mismatch with vendor master' });

  // ---- rejected ----
  inv(13, { no: 'INV-2026-0107', vendor: 'v_mehta', date: daysAgo(22), status: 'rejected', taxable: 75000, source: 'manual', twm: 'none', notes: 'Duplicate of INV-2026-0098' });

  // ---- scheduled for future payment ----
  inv(14, { no: 'INV-2026-0142', vendor: 'v_global', date: daysAgo(7), due: addDays(today, 6), status: 'scheduled', taxable: 455000, source: 'email', po: 'PO-2026-138', twm: 'matched', approved_by: 'u_mgr', approved_at: daysAgo(3) });

  // Approval rows for pending / approved / rejected invoices
  for (const iid of ['inv_5', 'inv_6', 'inv_7', 'inv_14']) appr(iid, 1, 'finance_manager', 'approved', 'u_mgr', 'Rohit Sharma', 'Checked against PO', daysAgo(2));
  appr('inv_5', 2, 'cfo', 'approved', 'u_cfo', 'Ananya Iyer', 'Within budget', daysAgo(1));
  appr('inv_8', 1, 'finance_manager', 'pending', null, null, null, null);
  appr('inv_9', 1, 'finance_manager', 'pending', null, null, null, null);
  appr('inv_9', 2, 'cfo', 'pending', null, null, null, null);
  appr('inv_10', 1, 'finance_manager', 'pending', null, null, null, null);
  appr('inv_13', 1, 'finance_manager', 'rejected', 'u_mgr', 'Rohit Sharma', 'Duplicate invoice', daysAgo(12));

  // Payments
  const pay = (i, opts) => {
    const id = `pay_${i}`;
    const net = inr(opts.amount - (opts.amount * (opts.tdsRate || 0)));
    insert('payments', {
      id, company_id: coId, vendor_id: opts.vendor, invoice_ids: opts.invoices.join(','),
      amount: opts.amount, mode: opts.mode, type: opts.type || 'batch',
      status: opts.status, scheduled_date: opts.scheduled || null,
      bank_account_id: opts.account, reference: opts.ref || null,
      gateway: 'razorpayx', gateway_txn_id: opts.utr || null,
      gst_ledger: vendors.find(v => v.id === opts.vendor).ledger,
      tds_section: opts.tdsSection || '194C', tds_amount: inr(opts.amount * (opts.tdsRate || 0)),
      net_amount: net, initiated_by: opts.by || 'u_exec',
      approved_by: opts.approvedBy || null, failure_reason: opts.failure || null,
      initiated_at: opts.at || now, processed_at: opts.processedAt || null,
      created_at: opts.at || now,
    });
    return id;
  };

  const pay1 = pay(1, { vendor: 'v_cement', invoices: ['inv_1'], amount: 1850000, mode: 'NEFT', status: 'completed', account: 'acc_icici', ref: 'NEFT-88213450', utr: 'UTR8123445501', at: daysAgo(8), processedAt: daysAgo(2) + 'T10:24:00Z' });
  const pay2 = pay(2, { vendor: 'v_kumar', invoices: ['inv_2'], amount: 320000, mode: 'IMPS', status: 'completed', account: 'acc_hdfc', ref: 'IMPS-55120987', utr: 'UTR8123445502', at: daysAgo(7), processedAt: daysAgo(4) + 'T14:02:00Z' });
  const pay3 = pay(3, { vendor: 'v_apex', invoices: ['inv_3'], amount: 640000, mode: 'RTGS', status: 'completed', account: 'acc_icici', ref: 'RTGS-77213001', utr: 'UTR8123445503', at: daysAgo(9), processedAt: daysAgo(6) + 'T09:41:00Z' });
  const pay4 = pay(4, { vendor: 'v_mehta', invoices: ['inv_4'], amount: 210000, mode: 'UPI', status: 'completed', account: 'acc_hdfc', ref: 'UPI-93021884', utr: 'UTR8123445504', at: daysAgo(5), processedAt: daysAgo(3) + 'T16:30:00Z' });
  const pay5 = pay(5, { vendor: 'v_global', invoices: ['inv_14'], amount: 455000, mode: 'NEFT', status: 'approved', account: 'acc_icici', ref: 'NEFT-99012345', scheduled: addDays(today, 2), approvedBy: 'u_mgr', at: daysAgo(1) });
  const pay6 = pay(6, { vendor: 'v_cement', invoices: ['inv_5'], amount: 760000, mode: 'NEFT', status: 'pending_approval', account: 'acc_icici', ref: 'NEFT-99123456', scheduled: addDays(today, 3), at: today, tdsRate: 0.02 });
  const pay7 = pay(7, { vendor: 'v_vijay', invoices: ['inv_6'], amount: 185000, mode: 'IMPS', status: 'failed', account: 'acc_hdfc', ref: 'IMPS-66778899', failure: 'Bank declined: insufficient funds in debit account', at: daysAgo(2), processedAt: daysAgo(1) + 'T11:00:00Z' });

  // Bank history per account (persists txns + daily balances inside adapter)
  const accountRows = all('SELECT * FROM bank_accounts WHERE company_id = ?', [coId]);
  for (const a of accountRows) {
    const base = accounts.find(x => x.id === a.id);
    BankDataProvider.fetchTransactions(coId, { ...a, opening_balance: base.opening });
  }

  // Reconciliation pass + GSTR-2B + Tally health
  require('./recon').matchAll(coId);
  const period = today.slice(0, 7);
  const prevPeriod = addDays(today.slice(0, 7) + '-01', -2).slice(0, 7);
  GstDataProvider.fetchGstr2b(coId, period);
  GstDataProvider.fetchGstr2b(coId, prevPeriod);
  GstDataProvider.scanMismatches(coId, period);

  TallyConnector.heartbeat(coId);
  TallyConnector.logSync(coId, 'ledger', 'vendors', 'pull', 'synced');
  TallyConnector.logSync(coId, 'voucher', 'inv_1', 'create', 'synced');
  TallyConnector.logSync(coId, 'voucher', 'inv_2', 'create', 'synced');
  TallyConnector.logSync(coId, 'voucher', 'inv_3', 'create', 'synced');
  TallyConnector.logSync(coId, 'voucher', 'inv_4', 'create', 'synced');
  TallyConnector.logSync(coId, 'payment', 'pay1', 'create', 'synced');
  TallyConnector.logSync(coId, 'payment', 'pay2', 'create', 'synced');
  TallyConnector.logSync(coId, 'payment', 'pay3', 'create', 'synced');
  TallyConnector.logSync(coId, 'payment', 'pay4', 'create', 'synced');

  // Onboarding all complete (bank + Tally + email + vendor import)
  const steps = [
    ['connect_bank', '2 accounts via AA, 1 via direct API', 14],
    ['install_tally', 'Connector v0.1.0 installed, first sync OK', 26],
    ['email_routing', 'forward@invoices.khataos.in active', 9],
    ['vendor_import', '8 vendors imported from Tally', 12],
  ];
  for (const [step, detail, mins] of steps) {
    insert('onboarding_steps', { company_id: coId, step, status: 'done', detail, at: addDays(today, -Math.max(1, mins - 1)) });
  }

  // Usage history for DAU/MAU metric (30 days)
  for (let k = 29; k >= 0; k--) {
    insert('usage_daily', {
      company_id: coId, date: daysAgo(k),
      dau: k === 0 ? 2 : rng() < 0.15 ? 2 : 3,
      mau: 3,
    });
  }

  // Audit trail
  insert('audit_logs', { id: uid('aud'), company_id: coId, user_id: 'u_cfo', user_name: 'Ananya Iyer', action: 'seed.demo_tenant', entity: 'company', entity_id: coId, details: 'Demo tenant provisioned', at: now });
  return coId;
}

module.exports = { seedIfEmpty, seed };
