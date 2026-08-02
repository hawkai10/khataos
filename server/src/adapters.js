'use strict';

// ============================================================================
// Integration adapters — every external system behind one interface.
// Each adapter has a MOCK implementation that is deterministic and realistic
// (Indian banks, modes, narrations, GSTINs, Tally semantics). Swapping in the
// real provider = implementing the same interface and flipping a config flag.
// ============================================================================

const { db, insert, update, run, all, get } = require('./db');
const { mulberry32, uid, nowIso, todayStr, daysAgo, addDays, inr, shortRef } = require('./util');

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

// ----------------------------------------------------------------------------
// Job queue (event-driven architecture, in-process for the MVP)
// ----------------------------------------------------------------------------
class JobQueue {
  constructor() {
    this.handlers = new Map();
    this.timers = new Map();
  }
  on(type, fn) { this.handlers.set(type, fn); }
  enqueue(companyId, type, payload, opts = {}) {
    const id = uid('job');
    insert('jobs', {
      id, company_id: companyId, type,
      payload: JSON.stringify(payload || {}),
      status: 'queued', attempts: 0,
      run_at: new Date(Date.now() + (opts.delayMs || 0)).toISOString(),
      created_at: nowIso(),
    });
    const timer = setTimeout(() => this._run(id), opts.delayMs || 0);
    this.timers.set(id, timer);
    return id;
  }
  async _run(id) {
    const job = get('SELECT * FROM jobs WHERE id = ?', [id]);
    if (!job || job.status === 'done') return;
    const handler = this.handlers.get(job.type);
    if (!handler) { run("UPDATE jobs SET status='failed', last_error=? WHERE id=?", ['no handler', id]); return; }
    run("UPDATE jobs SET status='running', attempts = attempts + 1 WHERE id=?", [id]);
    try {
      await handler(job, JSON.parse(job.payload));
      run("UPDATE jobs SET status='done', finished_at=? WHERE id=?", [nowIso(), id]);
    } catch (err) {
      const attempts = job.attempts + 1;
      if (attempts < 3) {
        run("UPDATE jobs SET status='queued', last_error=?, run_at=? WHERE id=?", [String(err.message || err), new Date(Date.now() + attempts * 2500).toISOString(), id]);
        const t = setTimeout(() => this._run(id), attempts * 2500);
        this.timers.set(id, t);
      } else {
        run("UPDATE jobs SET status='failed', last_error=?, finished_at=? WHERE id=?", [String(err.message || err), nowIso(), id]);
      }
    }
  }
}
const queue = new JobQueue();

// ----------------------------------------------------------------------------
// BANK DATA PROVIDER (Account Aggregator + direct APIs)
// ----------------------------------------------------------------------------
const AA_CONSENTS = new Map(); // consentId -> {companyId, accountId, bankCode, status}

const BankDataProvider = {
  name: 'mock-aa-sahamati',

  // Step 1: start consent (FIU -> AA network). Returns consent id + fake Aadhaar link.
  startConsent(companyId, bankCode, accountNumber) {
    const consentId = 'AA-CONSENT-' + String(Math.floor(Math.random() * 90000000) + 10000000);
    AA_CONSENTS.set(consentId, { companyId, bankCode, accountNumber, status: 'pending_otp' });
    return { consentId, status: 'pending_otp', otpSentTo: '+91-98XXXXXX12', expiresAt: new Date(Date.now() + 15 * 60000).toISOString() };
  },

  // Step 2: verify OTP (any 6-digit OTP passes in mock)
  verifyConsent(consentId, otp) {
    const c = AA_CONSENTS.get(consentId);
    if (!c) throw new Error('Invalid consent id');
    if (!/^\d{6}$/.test(String(otp))) throw new Error('OTP must be 6 digits');
    c.status = 'approved';
    return { consentId, status: 'approved', dataAccess: 'balance+transactions', durationDays: 365 };
  },

  // Fetch bank transactions for an account (mock: generated deterministic history)
  fetchTransactions(companyId, account, opts = {}) {
    return generateAccountHistory(companyId, account, opts);
  },

  refresh(companyId, account) {
    const txns = generateAccountHistory(companyId, account, { recentOnly: true });
    update('bank_accounts', account.id, { last_synced_at: nowIso(), status: 'active' });
    return txns;
  },
};

// Deterministic 90-day transaction history for an account.
function generateAccountHistory(companyId, account, opts = {}) {
  const rng = mulberry32(hashCode(account.account_number));
  const dayCount = opts.recentOnly ? 7 : 90;
  const startBalance = account.opening_balance != null ? account.opening_balance : 800000 + rng() * 3400000;
  let balance = startBalance;
  const txns = [];
  const vendorNames = ['Shree Cement Traders', 'Kumar Logistics', 'Apex Steel Works', 'Mehta Packaging', 'Global Freight LLP', 'Vijay Electricals', 'Sai Traders & Co'];
  const customerNames = ['Nexus Retail Pvt Ltd', 'City Mart Distributors', 'Bharat Pharma', 'Reliance Digital Outlets', 'Sunrise Agro', 'Metro Superstores'];
  const expenseNotes = ['RENT-PAYMENT', 'ELECTRICITY BILL', 'FUEL-DIESEL', 'COURIER CHARGES', 'OFFICE SUPPLIES', 'PEST CONTROL', 'FIRE SAFETY RENEWAL', 'INTERNET BILL'];

  for (let d = -dayCount + 1; d <= 0; d++) {
    const date = daysAgo(Math.abs(d));
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const r = rng();
      let amount, mode, desc, status = 'posted';
      if (r < 0.32) {
        // customer receipt
        amount = inr((200000 + rng() * 2200000) * 100) / 100;
        mode = rng() < 0.55 ? 'NEFT' : rng() < 0.8 ? 'RTGS' : 'UPI';
        desc = `${mode === 'UPI' ? 'UPI/CREDIT' : mode + '/CREDIT'} ${customerNames[Math.floor(rng() * customerNames.length)]}`;
      } else if (r < 0.62) {
        // vendor payment
        amount = -inr((15000 + rng() * 700000) * 100) / 100;
        mode = rng() < 0.4 ? 'NEFT' : rng() < 0.7 ? 'IMPS' : rng() < 0.9 ? 'UPI' : 'RTGS';
        desc = `${mode}/OUTWARD ${vendorNames[Math.floor(rng() * vendorNames.length)]}`;
      } else if (r < 0.82) {
        // operating expense
        amount = -inr((1500 + rng() * 110000) * 100) / 100;
        mode = rng() < 0.5 ? 'NEFT' : 'UPI';
        desc = `${mode} ${expenseNotes[Math.floor(rng() * expenseNotes.length)]}`;
      } else if (r < 0.9) {
        // statutory
        amount = -inr((20000 + rng() * 300000) * 100) / 100;
        mode = 'NEFT';
        desc = `NEFT GST-DEPOSIT / TDS-${rng() < 0.5 ? '194C' : '194J'}`;
      } else if (r < 0.96) {
        // salary
        amount = -inr((450000 + rng() * 900000) * 100) / 100;
        mode = 'RTGS';
        desc = 'RTGS SALARY-CREDITS MONTHLY';
      } else {
        // misc / bank charges
        amount = -inr((100 + rng() * 1200) * 100) / 100;
        mode = 'NEFT';
        desc = rng() < 0.5 ? 'BANK CHARGES' : 'NEFT CHARGES';
      }
      if (d > -3 && r > 0.97) {
        status = 'uncleared'; // cheque in clearing
        desc = 'CHQ IN CLEARING';
        mode = 'CHQ';
      }
      balance = inr(balance + amount);
      const refNo = shortRef(mode === 'UPI' ? 'UPI' : mode === 'CHQ' ? 'CHQ' : '', rng);
      txns.push({
        external_id: `BTX-${account.account_number.slice(-4)}-${Math.abs(hashCode(date + i + ''))}`,
        txn_date: date,
        value_date: date,
        amount,
        balance_after: balance,
        description: desc,
        mode,
        ref_no: mode === 'CHQ' ? `CHQ NO ${shortRef('', rng)}` : refNo,
        status,
      });
    }
  }
  // Inject platform payment debits (so reconciliation auto-matches) unless
  // this is a recent-only refresh (those txns already exist).
  if (!opts.recentOnly) {
    const payments = all(`SELECT * FROM payments WHERE company_id = ? AND status IN ('completed','processing')`, [companyId]);
    for (const p of payments) {
      if (p.bank_account_id !== account.id) continue;
      const date = (p.processed_at || p.scheduled_date || todayStr()).slice(0, 10);
      if (date < daysAgo(dayCount - 1)) continue;
      const mode = p.mode === 'UPI' ? 'UPI' : p.mode;
      txns.push({
        external_id: `PAY-REF-${p.reference}`,
        txn_date: date,
        value_date: date,
        amount: -p.net_amount,
        balance_after: null,
        description: `${mode}/OUTWARD ${p.reference}`,
        mode,
        ref_no: p.reference,
        status: 'posted',
      });
    }
    txns.sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.external_id.localeCompare(b.external_id));
    let bal = startBalance;
    for (const t of txns) {
      if (t.balance_after == null) { bal = inr(bal + t.amount); t.balance_after = bal; }
      else bal = t.balance_after;
    }
  }

  if (!opts.recentOnly) {
    // persist bank transactions + 30-day closing balance rollups
    for (const t of txns) {
      insert('bank_transactions', {
        id: uid('btx'), company_id: companyId, account_id: account.id,
        external_id: t.external_id, txn_date: t.txn_date, value_date: t.value_date,
        amount: t.amount, balance_after: t.balance_after, description: t.description,
        mode: t.mode, ref_no: t.ref_no, status: t.status,
        raw_json: JSON.stringify(t), created_at: nowIso(),
      });
    }
    const dayBalances = new Map();
    for (const t of txns) dayBalances.set(t.txn_date, t.balance_after);
    const start = daysAgo(29);
    let carry = dayBalances.has(start) ? dayBalances.get(start) : startBalance;
    for (let k = 0; k < 30; k++) {
      const date = addDays(start, k);
      if (dayBalances.has(date)) carry = dayBalances.get(date);
      insert('cash_daily', {
        id: uid('cd'), company_id: companyId, account_id: account.id,
        date, closing_balance: carry, source: 'aa',
      });
    }
    update('bank_accounts', account.id, { last_synced_at: nowIso(), status: 'active' });
  }
  return txns;
}

// ----------------------------------------------------------------------------
// PAYMENT GATEWAY (RazorpayX first, Cashfree fallback)
// ----------------------------------------------------------------------------
const PaymentGateway = {
  name: 'mock-razorpayx',

  async createBatch(companyId, payments) {
    // Real: RAZORPAYX Payout Batch API. Here: schedule jobs with async lifecycle.
    for (const p of payments) {
      const delay = p.type === 'instant' ? 600 : (p.scheduled_date && p.scheduled_date > todayStr()) ? 8000 : 2500;
      queue.enqueue(companyId, 'gateway.execute', { paymentId: p.id }, { delayMs: delay });
    }
    return { accepted: payments.length };
  },

  async execute(paymentId) {
    const p = get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (!p) throw new Error('payment not found');
    update('payments', paymentId, { status: 'processing', processed_at: nowIso() });

    const fail = hashCode(paymentId) % 25 === 0; // deterministic ~4% failure for demo
    const latency = p.mode === 'UPI' || p.mode === 'IMPS' ? 1200 : p.mode === 'RTGS' ? 2200 : 1800;
    return new Promise((resolve) => {
      setTimeout(() => {
        if (fail) {
          update('payments', paymentId, { status: 'failed', failure_reason: 'Bank declined: insufficient funds in debit account' });
          queue.enqueue(p.company_id, 'tally.syncPayment', { paymentId, status: 'failed' });
          resolve({ status: 'failed' });
        } else {
          const utr = 'UTR' + String(Math.floor(Math.random() * 90000000000) + 10000000000);
          update('payments', paymentId, {
            status: 'completed', gateway_txn_id: utr, processed_at: nowIso(),
            reference: p.reference || utr,
          });
          const ids = (p.invoice_ids || '').split(',').map(s => s.trim()).filter(Boolean);
          if (ids.length) {
            run(`UPDATE invoices SET status='paid', paid_at=? WHERE id IN (${ids.map(() => '?').join(',')})`, [nowIso(), ...ids]);
          }
          queue.enqueue(p.company_id, 'tally.syncPayment', { paymentId, status: 'completed' });
          resolve({ status: 'completed', utr });
        }
      }, latency);
    });
  },
};

queue.on('gateway.execute', async (job, payload) => { await PaymentGateway.execute(payload.paymentId); });

// ----------------------------------------------------------------------------
// TALLY CONNECTOR (Windows service, ODBC + XML; TallyPrime >= 2.1)
// ----------------------------------------------------------------------------
const TallyConnector = {
  name: 'mock-tallyprime-odbc',
  version: 'TallyPrime 4.2',

  health(companyId) {
    const h = get('SELECT * FROM tally_health WHERE company_id = ?', [companyId]);
    const q = get(`SELECT COUNT(*) AS c FROM tally_sync_logs WHERE company_id = ? AND status IN ('queued','retrying')`, [companyId]);
    return {
      ...(h || {}),
      queue_depth: q ? q.c : 0,
      connected: !!(h && h.status === 'connected'),
    };
  },

  heartbeat(companyId) {
    const h = get('SELECT * FROM tally_health WHERE company_id = ?', [companyId]);
    const uptime = h && h.uptime_30d != null ? h.uptime_30d : 99.72;
    const now = nowIso();
    if (h) {
      update('tally_health', h.company_id, {
        last_sync_at: now, last_success_at: now, status: 'connected',
        uptime_30d: Math.min(99.9, inr(uptime + 0.001)),
      });
    } else {
      insert('tally_health', { company_id: companyId, last_sync_at: now, last_success_at: now, status: 'connected', uptime_30d: 99.72 });
    }
  },

  logSync(companyId, entity, entityId, action, status, error) {
    insert('tally_sync_logs', {
      id: uid('tsl'), company_id: companyId, entity, entity_id: entityId, action,
      status, error: error || null, queued_at: nowIso(),
      synced_at: status === 'synced' ? nowIso() : null,
    });
  },

  // Invoice approved -> create purchase voucher in Tally
  createPurchaseVoucher(invoiceId) {
    const inv = get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!inv) return;
    TallyConnector.logSync(inv.company_id, 'voucher', invoiceId, 'create', 'queued');
    // simulated single-user contention: brief queue before syncing
    setTimeout(() => {
      run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE entity_id=? AND entity='voucher' AND status='queued'", [nowIso(), invoiceId]);
      TallyConnector.heartbeat(inv.company_id);
    }, 900);
  },

  syncPaymentToTally(paymentId) {
    const p = get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (!p) return;
    const synced = p.status === 'completed';
    TallyConnector.logSync(p.company_id, 'voucher', paymentId, 'create', synced ? 'queued' : 'failed', synced ? null : 'payment failed, voucher not created');
    if (synced) {
      setTimeout(() => {
        run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE entity_id=? AND entity='voucher' AND status='queued'", [nowIso(), paymentId]);
        TallyConnector.heartbeat(p.company_id);
      }, 1000);
    }
  },
};

queue.on('tally.syncVoucher', async (job, payload) => { TallyConnector.createPurchaseVoucher(payload.invoiceId); });
queue.on('tally.syncPayment', async (job, payload) => { TallyConnector.syncPaymentToTally(payload.paymentId); });

// ----------------------------------------------------------------------------
// OCR ENGINE (trained on Indian GST invoice formats)
// ----------------------------------------------------------------------------
const OcrEngine = {
  name: 'mock-ocr-indian-gst-v1',

  // Returns structured fields from invoice text. Tolerant of Indian layouts
  // (GSTIN, HSN, CGST/SGST/IGST, TDS) and bilingual narration.
  extract(text, meta = {}) {
    const t = String(text || '');
    const num = (re) => { const m = t.match(re); return m ? m[1].replace(/[₹,\s]/g, '') : null; };
    const gstin = (t.match(/GSTIN\s*[:\-\s]*([0-9A-Z]{15})/i) || t.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z]{1}\d[Z][0-9A-Z]{3})\b/i) || [])[1];
    const invoiceNo = (t.match(/Invoice\s*(?:No|Number|#)\s*[:\-\s]*([A-Za-z0-9\-/]+)/i) || [])[1];
    const invoiceDate = (t.match(/Invoice\s*Date\s*[:\-\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i) || t.match(/(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/))[1];
    const dueDate = (t.match(/Due\s*Date\s*[:\-\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i) || [])[1];
    const supplier = (t.match(/Supplier\s*[:\-\s]*([^\n,]+)/i) || t.match(/Vendor\s*[:\-\s]*([^\n,]+)/i) || [])[1];
    const taxable = num(/Taxable\s*(?:Value|Amount|Amt)\s*[:\-\s]*([\d,.]+)/i);
    const cgst = num(/CGST\s*[:\-\s]*([\d,.]+)/i);
    const sgst = num(/SGST\s*[:\-\s]*([\d,.]+)/i);
    const igst = num(/IGST\s*[:\-\s]*([\d,.]+)/i);
    const tds = num(/TDS\s*[:\-\s]*([\d,.]+)/i);
    const grand = num(/(?:Grand\s*)?Total\s*[:\-\s]*([\d,.]+)/i) || num(/Total\s*Invoice\s*(?:Value|Amount)\s*[:\-\s]*([\d,.]+)/i);

    const hsns = [];
    const hsnRe = /(\d{4,8})\s+([A-Za-z0-9&%.,\s\-/]+?)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/g;
    let m;
    while ((m = hsnRe.exec(t)) && hsns.length < 8) {
      hsns.push({ hsn: m[1], description: m[2].trim().slice(0, 60), qty: 1, rate: parseFloat(m[3].replace(/,/g, '')), taxable: parseFloat(m[4].replace(/,/g, '')), cgst: parseFloat(m[5].replace(/,/g, '')) || 0 });
    }

    return {
      invoice_no: invoiceNo || meta.invoiceNo || null,
      invoice_date: invoiceDate ? normalizeDate(invoiceDate) : null,
      due_date: dueDate ? normalizeDate(dueDate) : null,
      supplier_name: supplier ? supplier.trim() : null,
      gstin,
      taxable_amount: taxable != null ? parseFloat(taxable) : null,
      cgst: cgst != null ? parseFloat(cgst) : null,
      sgst: sgst != null ? parseFloat(sgst) : null,
      igst: igst != null ? parseFloat(igst) : null,
      tds_amount: tds != null ? parseFloat(tds) : null,
      grand_total: grand != null ? parseFloat(grand) : null,
      hsns,
      confidence: t.includes('GSTIN') ? 0.96 : 0.72,
      engine: this.name,
    };
  },

  // Sample invoice email used by the demo (realistic Indian B2B invoice).
  // template: 'cement' | 'apex' | 'freight'
  sampleEmail(template = 'cement') {
    const tpl = {
      cement: {
        from: 'billing@shreecementtraders.in',
        supplier: 'Shree Cement Traders',
        gstin: '29AABCS2345K1Z2',
        po: 'PO-2026-118',
        taxable: '18,50,000.00', cgst: '1,58,760.00', sgst: '1,66,500.00',
        tds: '46,250.00', grand: '21,19,010.00',
        line1: 'HSN 2523 | Portland Cement 43 Grade | 4500 bags | 392.00 | 1764000.00 | CGST 9% 158760.00',
        line2: 'HSN 2523 | Cement transport & handling | 1 | 86000.00 | 86000.00 | SGST 9% 7740.00',
        bank: 'A/C 50210045678912, IFSC HDFC0001234',
      },
      apex: {
        from: 'billing@apexsteel.in',
        supplier: 'Apex Steel Works',
        gstin: '29AAJPA5678K1Z7',
        po: 'PO-2026-142',
        taxable: '5,40,000.00', cgst: '48,600.00', sgst: '48,600.00',
        tds: '13,500.00', grand: '6,37,200.00',
        line1: 'HSN 7214 | TMT Bars Fe 500D 12mm | 12000 kg | 41.00 | 492000.00 | CGST 9% 44280.00',
        line2: 'HSN 7214 | TMT Bars Fe 500D 16mm | 1000 kg | 48.00 | 48000.00 | SGST 9% 4320.00',
        bank: 'A/C 918010099887, IFSC UTIB0000045',
      },
      freight: {
        from: 'ops@globalfreight.in',
        supplier: 'Global Freight LLP',
        gstin: '29AABFG8765P1Z1',
        po: 'PO-2026-139',
        taxable: '2,30,000.00', cgst: '20,700.00', sgst: '20,700.00',
        tds: '5,750.00', grand: '2,71,400.00',
        line1: 'HSN 9965 | Surface transport of goods - Bangalore to Chennai | 12 trips | 19166.67 | 230000.00 | CGST 9% 20700.00',
        line2: 'HSN 9965 | Fuel adjustment surcharge | 1 | 0.00 | 0.00 | SGST 9% 0.00',
        bank: 'A/C 089301122334, IFSC YESB0000046',
      },
    }[template] || null;
    if (!tpl) return null;
    const invNo = 'INV-2026-' + (100 + Math.floor(Math.random() * 800));
    const dt = todayStr().split('-').reverse().join('/');
    const due = addDays(todayStr(), 30).split('-').reverse().join('/');
    return {
      from: tpl.from,
      subject: `Invoice ${invNo} from ${tpl.supplier} - GST INV`,
      body: `Dear Team,

Please find attached tax invoice ${invNo} supplied against ${tpl.po}.

Supplier: ${tpl.supplier}
GSTIN: ${tpl.gstin}
Invoice Date: ${dt}   Due Date: ${due}

${tpl.line1}
${tpl.line2}

Taxable Amount: ${tpl.taxable}
CGST: ${tpl.cgst}
SGST: ${tpl.sgst}
IGST: 0.00
TDS (194C): ${tpl.tds}
Grand Total: ${tpl.grand}

Kindly process for payment on due date. Payment via NEFT to ${tpl.bank}.
Regards,
Billing Desk, ${tpl.supplier}`,
    };
  },
};

function normalizeDate(s) {
  const p = s.split(/[-/]/);
  if (p.length !== 3) return s;
  let dd = parseInt(p[0], 10), mm = parseInt(p[1], 10), yyyy = parseInt(p[2], 10);
  if (yyyy < 100) yyyy += 2000;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// GST DATA PROVIDER (GSTN e-invoice + GSTR-2B)
// ----------------------------------------------------------------------------
const GstDataProvider = {
  name: 'mock-gstn-gstr2b',

  currentPeriod() { return todayStr().slice(0, 7); },

  fetchGstr2b(companyId, period) {
    const company = get('SELECT * FROM companies WHERE id = ?', [companyId]);
    const monthStart = period + '-01';
    const monthEnd = addDays(monthStart, 31).slice(0, 10);
    const invs = all(`SELECT * FROM invoices WHERE company_id = ? AND invoice_date >= ? AND invoice_date <= ? AND gstin_vendor IS NOT NULL`,
      [companyId, monthStart, monthEnd]);
    const itc = (r) => inr(invs.reduce((s, i) => s + (i[r] || 0), 0));
    const snapshot = {
      id: uid('g2b'), company_id: companyId, period,
      gstin: company.gstin,
      total_itc: inr(itc('cgst') + itc('sgst') + itc('igst')),
      itc_cgst: itc('cgst'), itc_sgst: itc('sgst'), itc_igst: itc('igst'),
      data_json: JSON.stringify(invs.map(i => ({ invoice_no: i.invoice_no, gstin: i.gstin_vendor, taxable: i.taxable_amount, cgst: i.cgst, sgst: i.sgst, igst: i.igst }))),
      source: 'gstr2b', fetched_at: nowIso(),
    };
    insert('gstr2b_snapshots', snapshot);
    return snapshot;
  },

  // Scan for mismatches between platform invoices and GSTR-2B snapshot.
  scanMismatches(companyId, period) {
    const snap = get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? AND period = ? ORDER BY fetched_at DESC LIMIT 1', [companyId, period]);
    if (!snap) return [];
    const invs = all(`SELECT i.*, v.name AS vendor_name FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE i.company_id = ? AND i.invoice_date LIKE ? AND i.gstin_vendor IS NOT NULL`, [companyId, period + '%']);
    const g2b = JSON.parse(snap.data_json || '[]');
    const g2bMap = new Map(g2b.map(g => [g.invoice_no, g]));
    const mismatches = [];
    for (const i of invs) {
      const g = g2bMap.get(i.invoice_no);
      const platformItc = (i.cgst || 0) + (i.sgst || 0) + (i.igst || 0);
      if (!g) {
        mismatches.push({ invoice_no: i.invoice_no, vendor_gstin: i.gstin_vendor, vendor_name: i.vendor_name || '', platform_amount: platformItc, gstr2b_amount: 0, variance: platformItc, note: 'Supplier invoice not yet reflected in GSTR-2B' });
      } else if (Math.abs((g.cgst + g.sgst + g.igst) - platformItc) > 1) {
        mismatches.push({ invoice_no: i.invoice_no, vendor_gstin: i.gstin_vendor, vendor_name: i.vendor_name || '', platform_amount: platformItc, gstr2b_amount: g.cgst + g.sgst + g.igst, variance: inr(platformItc - (g.cgst + g.sgst + g.igst)), note: 'ITC amount differs from GSTR-2B' });
      }
    }
    for (const mm of mismatches) {
      insert('gst_mismatches', { id: uid('gm'), company_id: companyId, period, invoice_no: mm.invoice_no, vendor_gstin: mm.vendor_gstin, vendor_name: mm.vendor_name, platform_amount: mm.platform_amount, gstr2b_amount: mm.gstr2b_amount, variance: mm.variance, status: 'open', note: mm.note });
    }
    return mismatches;
  },

  exportGstr3b(companyId, period) {
    const snap = get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? AND period = ? ORDER BY fetched_at DESC LIMIT 1', [companyId, period]);
    const invs = all(`SELECT * FROM invoices WHERE company_id = ? AND invoice_date LIKE ?`, [companyId, period + '%']);
    const outSales = invs.filter(i => i.status !== 'rejected').reduce((s, i) => s + i.taxable_amount, 0);
    const outGst = invs.filter(i => i.status !== 'rejected').reduce((s, i) => s + (i.cgst || 0) + (i.sgst || 0) + (i.igst || 0), 0);
    const itc = snap ? snap.total_itc : 0;
    const rows = [
      ['Period', period],
      ['Outward taxable supplies (3.1a)', inr(outSales)],
      ['Outward CGST (3.1a)', inr(invs.reduce((s, i) => s + (i.cgst || 0), 0))],
      ['Outward SGST (3.1a)', inr(invs.reduce((s, i) => s + (i.sgst || 0), 0))],
      ['Outward IGST (3.1a)', inr(invs.reduce((s, i) => s + (i.igst || 0), 0))],
      ['ITC available from GSTR-2B (4A)', inr(itc)],
      ['Net GST payable', Math.max(0, inr(outGst - itc))],
    ];
    return rows.map(r => r.join(',')).join('\n');
  },
};

// ----------------------------------------------------------------------------
// EMAIL INBOX (invoice capture via forwarding rule)
// ----------------------------------------------------------------------------
const EmailInbox = {
  forwardingRule: 'forward@invoices.khataos.in',
  forward(companyId, from, subject, body) {
    const id = uid('mail');
    insert('email_inbox', {
      id, company_id: companyId, from_email: from, subject, body,
      attachments: JSON.stringify([{ name: 'tax_invoice.pdf' }]),
      received_at: nowIso(), processed: 0,
    });
    return processEmail(id);
  },
};

function processEmail(mailId) {
  const mail = get('SELECT * FROM email_inbox WHERE id = ?', [mailId]);
  if (!mail) throw new Error('mail not found');
  const ocr = OcrEngine.extract(mail.body);
  const invId = uid('inv');
  const vendor = get('SELECT * FROM vendors WHERE company_id = ? AND (gstin = ? OR lower(name) LIKE ?) LIMIT 1',
    [mail.company_id, ocr.gstin || '', `%${(ocr.supplier_name || '').split(' ')[0]}%`]);
  const taxable = ocr.taxable_amount != null ? ocr.taxable_amount : 0;
  const cgst = ocr.cgst || 0, sgst = ocr.sgst || 0, igst = ocr.igst || 0;
  const tds = ocr.tds_amount || 0;
  const gross = ocr.grand_total != null ? ocr.grand_total : taxable + cgst + sgst + igst;
  insert('invoices', {
    id: invId, company_id: mail.company_id,
    invoice_no: ocr.invoice_no || 'MAN-' + String(Date.now()).slice(-6),
    vendor_id: vendor ? vendor.id : null,
    invoice_date: ocr.invoice_date || todayStr(),
    due_date: ocr.due_date || addDays(todayStr(), 30),
    source: 'email', status: 'captured',
    gross_amount: inr(gross), taxable_amount: inr(taxable),
    cgst: inr(cgst), sgst: inr(sgst), igst: inr(igst), cess: 0,
    tds_amount: inr(tds), net_payable: inr(gross - tds),
    gstin_vendor: ocr.gstin,
    hsns: JSON.stringify(ocr.hsns),
    three_way_match: 'none',
    ocr_json: JSON.stringify(ocr),
    created_by: 'email-forward', created_at: nowIso(),
  });
  for (const line of ocr.hsns) {
    insert('invoice_lines', { id: uid('l'), invoice_id: invId, hsn: line.hsn, description: line.description, qty: line.qty || 1, rate: line.rate || 0, taxable: line.taxable || 0, cgst: line.cgst || 0, sgst: line.sgst || 0, igst: 0, cess: 0 });
  }
  run(`UPDATE email_inbox SET processed = 1, invoice_id = ? WHERE id = ?`, [invId, mailId]);
  run(`UPDATE invoices SET status='pending_approval' WHERE id = ?`, [invId]);
  createApprovalChain(mail.company_id, invId);
  return get('SELECT * FROM invoices WHERE id = ?', [invId]);
}

// Build the multi-level approval chain per tenant rules:
// <= threshold -> one level (finance manager); > threshold -> level 2 CFO too.
function createApprovalChain(companyId, invoiceId) {
  const inv = get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  const settings = get('SELECT settings FROM companies WHERE id = ?', [companyId]);
  const cfg = JSON.parse(settings.settings || '{}');
  const threshold = cfg.cfo_approval_threshold || 100000;
  insert('approvals', { id: uid('app'), company_id: companyId, invoice_id: invoiceId, level: 1, required_role: 'finance_manager', threshold_note: `<= ₹${threshold.toLocaleString('en-IN')} route`, status: 'pending' });
  if (inv.gross_amount > threshold) {
    insert('approvals', { id: uid('app'), company_id: companyId, invoice_id: invoiceId, level: 2, required_role: 'cfo', threshold_note: `> ₹${threshold.toLocaleString('en-IN')} requires CFO`, status: 'pending' });
  }
}

module.exports = {
  queue, BankDataProvider, PaymentGateway, TallyConnector,
  OcrEngine, GstDataProvider, EmailInbox, createApprovalChain, hashCode,
};
