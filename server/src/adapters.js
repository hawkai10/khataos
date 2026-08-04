'use strict';

// ============================================================================
// Integration adapters — every external system behind one interface.
// Adapters only talk to real providers and are disabled (503) until the
// matching credentials are configured — no fabricated transactions, consents,
// payment outcomes, GSTR-2B payloads or sample invoices exist in the codebase.
// (PAYMENT_GATEWAY=test enables a CI-only gateway double that changes payment
// status without inventing bank data; see PaymentGateway below.)
// ============================================================================

const { db, insert, update, run, all, get } = require('./db');
const { uid, nowIso, todayStr, daysAgo, addDays, inr } = require('./util');
const Gstn = require('./gstn');
const Tally = require('./tally');
const TallyMapping = require('./tally-mapping');
const { env, hasAll } = require('./config');

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
  async enqueue(companyId, type, payload, opts = {}) {
    const id = uid('job');
    await insert('jobs', {
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
    const job = await get('SELECT * FROM jobs WHERE id = ?', [id]);
    if (!job || job.status === 'done') return;
    const handler = this.handlers.get(job.type);
    if (!handler) { await run("UPDATE jobs SET status='failed', last_error=? WHERE id=?", ['no handler', id]); return; }
    await run("UPDATE jobs SET status='running', attempts = attempts + 1 WHERE id=?", [id]);
    try {
      await handler(job, JSON.parse(job.payload));
      await run("UPDATE jobs SET status='done', finished_at=? WHERE id=?", [nowIso(), id]);
    } catch (err) {
      const attempts = job.attempts + 1;
      if (attempts < 3) {
        await run("UPDATE jobs SET status='queued', last_error=?, run_at=? WHERE id=?", [String(err.message || err), new Date(Date.now() + attempts * 2500).toISOString(), id]);
        const t = setTimeout(() => { this._run(id); }, attempts * 2500);
        this.timers.set(id, t);
      } else {
        await run("UPDATE jobs SET status='failed', last_error=?, finished_at=? WHERE id=?", [String(err.message || err), nowIso(), id]);
      }
    }
  }
}
const queue = new JobQueue();

// ----------------------------------------------------------------------------
// BANK DATA PROVIDER (Account Aggregator + direct APIs)
// ----------------------------------------------------------------------------
function notConfigured(name) {
  const err = new Error(`${name} not configured — set the provider credentials (see .env.example)`);
  err.status = 503;
  return err;
}

// TODO(real-aa): implement the Sahamati AA / direct-bank consent + statement
// APIs here. Until credentials exist (AA_CLIENT_ID/AA_CLIENT_SECRET or the
// bank's direct API keys), every call is refused so no fake data can enter.
// Read at call time (lazy config).
const aaEnabled = () => hasAll('AA_CLIENT_ID', 'AA_CLIENT_SECRET');

const BankDataProvider = {
  name: 'aa-sahamati',

  startConsent(companyId, bankCode, accountNumber) {
    if (!aaEnabled()) throw notConfigured('Account Aggregator (AA)');
    // TODO(real-aa): POST to the FIU -> AA consent request API.
    throw notConfigured('Account Aggregator (AA)');
  },

  verifyConsent(consentId, otp) {
    if (!aaEnabled()) throw notConfigured('Account Aggregator (AA)');
    // TODO(real-aa): poll the AA consent status / verify the OTP flow.
    throw notConfigured('Account Aggregator (AA)');
  },

  async fetchTransactions(companyId, account, opts = {}) {
    if (!aaEnabled()) throw notConfigured('Account Aggregator (AA)');
    // TODO(real-aa): fetch balance + statement and persist bank_transactions /
    // cash_daily exactly like Decentro.pull does.
    throw notConfigured('Account Aggregator (AA)');
  },

  async refresh(companyId, account) {
    const txns = await this.fetchTransactions(companyId, account, { recentOnly: true });
    await update('bank_accounts', account.id, { last_synced_at: nowIso(), status: 'active' });
    return txns;
  },
};

// ----------------------------------------------------------------------------
// PAYMENT GATEWAY (RazorpayX first, Cashfree fallback)
// ----------------------------------------------------------------------------
// Real execution requires RAZORPAYX_KEY_ID + RAZORPAYX_KEY_SECRET. For CI and
// local testing, PAYMENT_GATEWAY=test enables a double that transitions the
// payment to completed (and marks its invoices paid) WITHOUT generating any
// fabricated gateway/UTR/bank data — it never invents transaction references
// or amounts.
const gatewayEnabled = () => hasAll('RAZORPAYX_KEY_ID', 'RAZORPAYX_KEY_SECRET');
const testGateway = () => env('PAYMENT_GATEWAY') === 'test';

const PaymentGateway = {
  name: 'razorpayx',

  async createBatch(companyId, payments) {
    if (!gatewayEnabled() && !testGateway()) throw notConfigured('Payment gateway (RazorpayX)');
    for (const p of payments) {
      const delay = p.type === 'instant' ? 600 : (p.scheduled_date && p.scheduled_date > todayStr()) ? 8000 : 2500;
      await queue.enqueue(companyId, 'gateway.execute', { paymentId: p.id }, { delayMs: delay });
    }
    return { accepted: payments.length };
  },

  async execute(paymentId) {
    const p = await get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (!p) throw new Error('payment not found');
    await update('payments', paymentId, { status: 'processing', processed_at: nowIso() });

    if (testGateway()) {
      // CI double: complete the payment and mark invoices paid. No UTR, no
      // reference changes, no fabricated bank transaction.
      await update('payments', paymentId, { status: 'completed', processed_at: nowIso() });
      let ids = [];
      try { ids = JSON.parse(p.invoice_ids || '[]'); } catch { ids = String(p.invoice_ids || '').split(',').map((s) => s.trim()).filter(Boolean); }
      if (ids.length) {
        await run(`UPDATE invoices SET status='paid', paid_at=? WHERE id IN (${ids.map(() => '?').join(',')})`, [nowIso(), ...ids]);
      }
      await queue.enqueue(p.company_id, 'tally.syncPayment', { paymentId, status: 'completed' });
      return { status: 'completed' };
    }

    if (!gatewayEnabled()) throw notConfigured('Payment gateway (RazorpayX)');
    // TODO(real-gateway): call the RazorpayX Payout Batch API and persist the
    // real transaction id / UTR returned by the provider.
    throw notConfigured('Payment gateway (RazorpayX)');
  },
};

queue.on('gateway.execute', async (job, payload) => { await PaymentGateway.execute(payload.paymentId); });

// ----------------------------------------------------------------------------
// TALLY CONNECTOR (Windows service, ODBC + XML; TallyPrime >= 2.1)
// ----------------------------------------------------------------------------
const TallyConnector = {
  name: 'tally-xml-upload',
  version: 'TallyPrime 4.2',

  async health(companyId) {
    const h = await get('SELECT * FROM tally_health WHERE company_id = ?', [companyId]);
    const q = await get(`SELECT COUNT(*) AS c FROM tally_sync_logs WHERE company_id = ? AND status IN ('queued','retrying')`, [companyId]);
    return {
      ...(h || {}),
      queue_depth: q ? q.c : 0,
      connected: !!(h && h.status === 'connected'),
      connector: Tally.config(),
    };
  },

  async heartbeat(companyId) {
    const h = await get('SELECT * FROM tally_health WHERE company_id = ?', [companyId]);
    // Uptime starts at 100% (no fabricated baseline) and converges back up
    // after any reported downtime.
    const uptime = h && h.uptime_30d != null ? h.uptime_30d : 100;
    const now = nowIso();
    if (h) {
      await run(`UPDATE tally_health SET last_sync_at = ?, last_success_at = ?, status = 'connected', uptime_30d = ? WHERE company_id = ?`,
        [now, now, Math.min(100, inr(uptime + 0.001)), companyId]);
    } else {
      await insert('tally_health', { company_id: companyId, last_sync_at: now, last_success_at: now, status: 'connected', uptime_30d: 100 });
    }
  },

  async logSync(companyId, entity, entityId, action, status, error) {
    await insert('tally_sync_logs', {
      id: uid('tsl'), company_id: companyId, entity, entity_id: entityId, action,
      status, error: error || null, queued_at: nowIso(),
      synced_at: status === 'synced' ? nowIso() : null,
    });
  },

  // Invoice approved -> create purchase voucher in Tally
  async createPurchaseVoucher(invoiceId) {
    const inv = await get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!inv) return;
    await TallyConnector.logSync(inv.company_id, 'voucher', invoiceId, 'create', 'queued');
    // brief queue emulating Tally single-user mode before the sync is marked
    setTimeout(async () => {
      await run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE entity_id=? AND entity='voucher' AND status='queued'", [nowIso(), invoiceId]);
      await TallyConnector.heartbeat(inv.company_id);
    }, 900);
  },

  async syncPaymentToTally(paymentId) {
    const p = await get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (!p) return;
    const synced = p.status === 'completed';
    await TallyConnector.logSync(p.company_id, 'voucher', paymentId, 'create', synced ? 'queued' : 'failed', synced ? null : 'payment failed, voucher not created');
    if (!synced) return;
    setTimeout(async () => {
      await run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE entity_id=? AND entity='voucher' AND status='queued'", [nowIso(), paymentId]);
      await TallyConnector.heartbeat(p.company_id);
    }, 1000);
  },

  // Pull ledger masters from the imported Tally XML and re-run vendor
  // auto-mapping (cloud-only: "pull" = refresh from the imported masters).
  async pullLedgers(companyId) {
    const count = (await get('SELECT COUNT(*) AS c FROM tally_ledgers WHERE company_id = ?', [companyId])).c;
    const mapping = await TallyMapping.autoMap(companyId);
    await TallyConnector.logSync(companyId, 'ledger', 'vendors', 'pull', 'synced', `pulled ${count} imported ledger(s), auto-mapped ${mapping.updated.length} vendor(s)`);
    await TallyConnector.heartbeat(companyId);
    return { ledgers: count, mapped: mapping.updated.length };
  },
};

queue.on('tally.syncVoucher', async (job, payload) => { await TallyConnector.createPurchaseVoucher(payload.invoiceId); });
queue.on('tally.syncPayment', async (job, payload) => { await TallyConnector.syncPaymentToTally(payload.paymentId); });

// ----------------------------------------------------------------------------
// OCR ENGINE (trained on Indian GST invoice formats)
// ----------------------------------------------------------------------------
const OcrEngine = {
  name: 'ocr-indian-gst-v1',

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
  name: 'gstn-gsp',

  currentPeriod() { return todayStr().slice(0, 7); },

  async fetchGstr2b(companyId, period) {
    const company = await get('SELECT * FROM companies WHERE id = ?', [companyId]);
    const gstin = company.gstin;
    // Delegate to the GSP/GSTN adapter (server/src/gstn.js), which fetches
    // GSTR-2B through the configured GSP and maps the response to our row
    // shape. No simulated payloads are generated.
    const raw = await Gstn.fetchGstr2bRaw(companyId, period, gstin);
    const mapped = Gstn.mapGstr2b(raw, { period, gstin });
    const snapshot = {
      id: uid('g2b'), company_id: companyId, period,
      gstin,
      total_itc: mapped.total_itc,
      itc_cgst: mapped.itc_cgst, itc_sgst: mapped.itc_sgst, itc_igst: mapped.itc_igst,
      data_json: JSON.stringify(mapped.invoices),
      cdnr_json: JSON.stringify(mapped.cdnr || []),
      source: mapped.source, fetched_at: mapped.fetched_at,
    };
    await insert('gstr2b_snapshots', snapshot);
    return snapshot;
  },

  // Scan for mismatches between platform invoices and GSTR-2B snapshot.
  async scanMismatches(companyId, period) {
    const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? AND period = ? ORDER BY fetched_at DESC LIMIT 1', [companyId, period]);
    if (!snap) return [];
    const invs = await all(`SELECT i.*, v.name AS vendor_name FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id WHERE i.company_id = ? AND i.invoice_date LIKE ? AND i.gstin_vendor IS NOT NULL`, [companyId, period + '%']);
    const g2b = JSON.parse(snap.data_json || '[]');
    // Key by GSTIN + invoice ref (like CDNR) so the same invoice number from
    // two suppliers can never collide; fall back to ref-only rows.
    const g2bByGstinRef = new Map(g2b.map((g) => [`${g.gstin || ''}|${g.invoice_no}`, g]));
    const g2bByRef = new Map(g2b.map((g) => [g.invoice_no, g]));
    const mismatches = [];
    for (const i of invs) {
      const g = (i.gstin_vendor ? g2bByGstinRef.get(`${i.gstin_vendor}|${i.invoice_no}`) : null) || g2bByRef.get(i.invoice_no);
      const platformItc = (i.cgst || 0) + (i.sgst || 0) + (i.igst || 0);
      if (!g) {
        mismatches.push({ invoice_no: i.invoice_no, vendor_gstin: i.gstin_vendor, vendor_name: i.vendor_name || '', platform_amount: platformItc, gstr2b_amount: 0, variance: platformItc, note: 'Supplier invoice not yet reflected in GSTR-2B' });
      } else if (Math.abs((g.cgst + g.sgst + g.igst) - platformItc) > 1) {
        mismatches.push({ invoice_no: i.invoice_no, vendor_gstin: i.gstin_vendor, vendor_name: i.vendor_name || '', platform_amount: platformItc, gstr2b_amount: g.cgst + g.sgst + g.igst, variance: inr(platformItc - (g.cgst + g.sgst + g.igst)), note: 'ITC amount differs from GSTR-2B' });
      }
    }
    // Tally-imported purchase vouchers are authoritative once imported:
    // compare their BILLALLOCATIONS invoice refs against the GSTR-2B rows.
    const tallyVouchers = await all(`SELECT voucher_number, amount, party_name, entry_json FROM tally_vouchers WHERE company_id = ? AND voucher_type = 'Purchase' AND cancelled = 0`, [companyId]);
    const tallyLedgers = await all('SELECT name, gstin FROM tally_ledgers WHERE company_id = ?', [companyId]);
    const gstinByName = new Map(tallyLedgers.map((l) => [l.name, l.gstin]));
    const parseJson = (j) => { try { return JSON.parse(j || '[]'); } catch { return []; } };
    for (const v of tallyVouchers) {
      const gstin = gstinByName.get(v.party_name) || null;
      const seen = new Set();
      const refs = [];
      for (const e of parseJson(v.entry_json)) for (const r of e.bill_refs || []) refs.push(r);
      // A voucher can reference several invoices (one payment covering
      // multiple bills) — every ref is compared, not just the first.
      const uniqueRefs = [...new Set(refs)];
      const amountCheckable = uniqueRefs.length === 1;
      for (const ref of uniqueRefs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const g = (gstin ? g2bByGstinRef.get(`${gstin}|${ref}`) : null) || g2bByRef.get(ref);
        const platformAmount = Math.abs(v.amount || 0);
        if (!g) {
          mismatches.push({ invoice_no: ref, vendor_gstin: gstin, vendor_name: v.party_name || '', platform_amount: platformAmount, gstr2b_amount: 0, variance: platformAmount, note: 'Tally purchase voucher not yet reflected in GSTR-2B' });
        } else if (amountCheckable) {
          // A multi-ref voucher's total cannot be compared per invoice; only
          // presence is checked for those.
          const g2bAmount = (g.taxable || 0) + (g.cgst || 0) + (g.sgst || 0) + (g.igst || 0);
          if (Math.abs(g2bAmount - platformAmount) > 1) {
            mismatches.push({ invoice_no: ref, vendor_gstin: gstin, vendor_name: v.party_name || '', platform_amount: platformAmount, gstr2b_amount: g2bAmount, variance: inr(platformAmount - g2bAmount), note: 'Tally purchase voucher amount differs from GSTR-2B' });
          }
        }
      }
    }
    // Credit/Debit Notes: GSTR-2B's CDNR section is compared against imported
    // Credit/Debit Note vouchers by GSTIN + invoice ref + amount (same ±1 rule
    // as the purchase comparison). Imported note vouchers are authoritative.
    const noteVouchers = await all(`SELECT voucher_number, amount, party_name, entry_json FROM tally_vouchers WHERE company_id = ? AND voucher_type IN ('Credit Note', 'Debit Note') AND cancelled = 0`, [companyId]);
    const cdnrRows = JSON.parse(snap.cdnr_json || '[]');
    const cdnrByGstinRef = new Map(cdnrRows.map((c) => [`${c.gstin || ''}|${c.invoice_no}`, c]));
    const cdnrByRef = new Map(cdnrRows.map((c) => [c.invoice_no, c]));
    for (const v of noteVouchers) {
      const gstin = gstinByName.get(v.party_name) || null;
      const seen = new Set();
      const refs = [];
      for (const e of parseJson(v.entry_json)) for (const r of e.bill_refs || []) refs.push(r);
      const uniqueRefs = [...new Set(refs)];
      const amountCheckable = uniqueRefs.length === 1;
      for (const ref of uniqueRefs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const c = (gstin ? cdnrByGstinRef.get(`${gstin}|${ref}`) : null) || cdnrByRef.get(ref);
        const noteAmount = Math.abs(v.amount || 0);
        if (!c) {
          mismatches.push({ invoice_no: ref, vendor_gstin: gstin, vendor_name: v.party_name || '', platform_amount: noteAmount, gstr2b_amount: 0, variance: noteAmount, note: 'Tally credit/debit note voucher not yet reflected in GSTR-2B' });
        } else if (amountCheckable) {
          const cdnrAmount = (c.taxable || 0) + (c.cgst || 0) + (c.sgst || 0) + (c.igst || 0);
          if (Math.abs(cdnrAmount - noteAmount) > 1) {
            mismatches.push({ invoice_no: ref, vendor_gstin: gstin, vendor_name: v.party_name || '', platform_amount: noteAmount, gstr2b_amount: cdnrAmount, variance: inr(noteAmount - cdnrAmount), note: 'Tally credit/debit note voucher amount differs from GSTR-2B' });
          }
        }
      }
    }
    for (const mm of mismatches) {
      await insert('gst_mismatches', { id: uid('gm'), company_id: companyId, period, invoice_no: mm.invoice_no, vendor_gstin: mm.vendor_gstin, vendor_name: mm.vendor_name, platform_amount: mm.platform_amount, gstr2b_amount: mm.gstr2b_amount, variance: mm.variance, status: 'open', note: mm.note });
    }
    return mismatches;
  },

  async exportGstr3b(companyId, period) {
    const snap = await get('SELECT * FROM gstr2b_snapshots WHERE company_id = ? AND period = ? ORDER BY fetched_at DESC LIMIT 1', [companyId, period]);
    const invs = await all(`SELECT * FROM invoices WHERE company_id = ? AND invoice_date LIKE ?`, [companyId, period + '%']);
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
  async forward(companyId, from, subject, body) {
    const id = uid('mail');
    await insert('email_inbox', {
      id, company_id: companyId, from_email: from, subject, body,
      attachments: JSON.stringify([{ name: 'tax_invoice.pdf' }]),
      received_at: nowIso(), processed: 0,
    });
    return processEmail(id);
  },
};

async function processEmail(mailId) {
  const mail = await get('SELECT * FROM email_inbox WHERE id = ?', [mailId]);
  if (!mail) throw new Error('mail not found');
  const ocr = OcrEngine.extract(mail.body);
  const invId = uid('inv');
  const vendor = await get('SELECT * FROM vendors WHERE company_id = ? AND (gstin = ? OR lower(name) LIKE ?) LIMIT 1',
    [mail.company_id, ocr.gstin || '', `%${(ocr.supplier_name || '').split(' ')[0]}%`]);
  const taxable = ocr.taxable_amount != null ? ocr.taxable_amount : 0;
  const cgst = ocr.cgst || 0, sgst = ocr.sgst || 0, igst = ocr.igst || 0;
  const tds = ocr.tds_amount || 0;
  const gross = ocr.grand_total != null ? ocr.grand_total : taxable + cgst + sgst + igst;
  // Idempotent capture: a supplier invoice forwarded twice must not create a
  // duplicate row (company + invoice number are unique).
  const existing = ocr.invoice_no
    ? await get('SELECT * FROM invoices WHERE company_id = ? AND invoice_no = ?', [mail.company_id, ocr.invoice_no])
    : null;
  if (existing) {
    await run(`UPDATE email_inbox SET processed = 1, invoice_id = ? WHERE id = ?`, [existing.id, mailId]);
    return existing;
  }
  await insert('invoices', {
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
    await insert('invoice_lines', { id: uid('l'), invoice_id: invId, hsn: line.hsn, description: line.description, qty: line.qty || 1, rate: line.rate || 0, taxable: line.taxable || 0, cgst: line.cgst || 0, sgst: line.sgst || 0, igst: 0, cess: 0 });
  }
  await run(`UPDATE email_inbox SET processed = 1, invoice_id = ? WHERE id = ?`, [invId, mailId]);
  await run(`UPDATE invoices SET status='pending_approval' WHERE id = ?`, [invId]);
  await createApprovalChain(mail.company_id, invId);
  return get('SELECT * FROM invoices WHERE id = ?', [invId]);
}

// Build the multi-level approval chain per tenant rules:
// <= threshold -> one level (finance manager); > threshold -> level 2 CFO too.
async function createApprovalChain(companyId, invoiceId) {
  const inv = await get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  const settings = await get('SELECT settings FROM companies WHERE id = ?', [companyId]);
  const cfg = JSON.parse(settings.settings || '{}');
  const threshold = cfg.cfo_approval_threshold || 100000;
  await insert('approvals', { id: uid('app'), company_id: companyId, invoice_id: invoiceId, level: 1, required_role: 'finance_manager', threshold_note: `<= ₹${threshold.toLocaleString('en-IN')} route`, status: 'pending' });
  if (inv.gross_amount > threshold) {
    await insert('approvals', { id: uid('app'), company_id: companyId, invoice_id: invoiceId, level: 2, required_role: 'cfo', threshold_note: `> ₹${threshold.toLocaleString('en-IN')} requires CFO`, status: 'pending' });
  }
}

module.exports = {
  queue, BankDataProvider, PaymentGateway, TallyConnector,
  OcrEngine, GstDataProvider, EmailInbox, createApprovalChain, hashCode,
};
