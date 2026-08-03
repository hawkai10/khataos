'use strict';

// ============================================================================
// GSTN / GSP adapter — GSTR-2B fetch + e-invoice (IRN) contract.
//
// Real-world surface this models (documented GSTN/GSP shapes):
//   Auth:   POST {base}/gus/taxpayerapi/v1.0/authenticate
//           body { action:"AUTHTOKEN", username, app_key, otp }  -> auth_token
//           token valid ~6h; GSP SDKs handle app_key/otp encryption.
//   OTP:    POST {base}/gus/taxpayerapi/v1.0/otp/request  -> SMS/email OTP
//   GSTR-2B:GET/POST {gstr2bPath}/{gstin} (GSP-specific; returns `b2b` rows:
//           ctin, docno/docdt, txval, cgst, sgst, igst, cess, supfildt)
//   e-Invoice (IRP): POST {einvoiceBase}/einv/v1.0/irn/generate
//           headers gstin/client_id/client_secret/user_name/txn
//
// Modes:
//   live     — real HTTP against GSTN_GSP_BASE_URL when credentials are set.
//   disabled — no credentials; every call is refused (503) so no simulated
//              GSTR-2B payload can enter the system.
// ============================================================================

const { todayStr, inr, nowIso } = require('./util');
const { env, hasAll } = require('./config');

// Read at call time so credentials can be set/changed after require.
const baseUrl = () => env('GSTN_GSP_BASE_URL', 'https://api.setu.co/gstn').replace(/\/$/, '');
const einvBase = () => env('GSTN_EINVOICE_BASE_URL', 'https://einvoice1.gst.gov.in').replace(/\/$/, '');
const authPath = () => env('GSTN_AUTH_PATH', '/gus/taxpayerapi/v1.0/authenticate');
const otpPath = () => env('GSTN_OTP_PATH', '/gus/taxpayerapi/v1.0/otp/request');
const gstr2bPath = () => env('GSTN_GSTR2B_PATH', '/taxpayerapi/v2.0/gstr2b');
const cfg = () => ({
  gstin: env('GSTN_GSTIN'),
  username: env('GSTN_USERNAME'),
  app_key: env('GSTN_APP_KEY'),
  client_id: env('GSTN_CLIENT_ID'),
  client_secret: env('GSTN_CLIENT_SECRET'),
  ip_usr: env('GSTN_IP_USR', '127.0.0.1'),
});

const stateCd = () => (cfg().gstin || '00').slice(0, 2);
const hasCreds = () => hasAll('GSTN_GSTIN', 'GSTN_USERNAME', 'GSTN_APP_KEY', 'GSTN_CLIENT_ID', 'GSTN_CLIENT_SECRET');
const mode = () => (hasCreds() ? 'live' : 'disabled');

function notConfigured() {
  const err = new Error('GSTN not configured — set GSTN_GSTIN, GSTN_USERNAME, GSTN_APP_KEY, GSTN_CLIENT_ID and GSTN_CLIENT_SECRET (see .env.example)');
  err.status = 503;
  return err;
}

function config() {
  const missing = ['GSTN_GSTIN', 'GSTN_USERNAME', 'GSTN_APP_KEY', 'GSTN_CLIENT_ID', 'GSTN_CLIENT_SECRET'].filter(k => !process.env[k]);
  const c = cfg();
  return {
    provider: 'gstn-via-gsp',
    mode: mode(),
    base_url: baseUrl(),
    einvoice_base_url: einvBase(),
    gstin: c.gstin || null,
    auth_endpoint: authPath(),
    gstr2b_endpoint: gstr2bPath() + '/{gstin}',
    token_valid_minutes: 360,
    enabled: mode() === 'live',
    missing_env: mode() === 'live' ? [] : missing,
  };
}

// ---- auth token cache (live mode) ----
let auth = { token: null, expiresAt: 0, otpRef: null };

async function requestOtp() {
  if (!hasCreds()) throw notConfigured();
  const resp = await fetch(baseUrl() + otpPath(), {
    method: 'POST',
    headers: gspHeaders(),
    body: JSON.stringify({ action: 'OTPREQUEST', username: cfg().username, app_key: cfg().app_key }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`GSTN OTP request failed (${resp.status}): ${json.message || json.error || resp.statusText}`);
  auth.otpRef = json.otp_ref || json.otpRef || 'OTP-' + Date.now();
  return { status: 'OTP_REQUESTED', otp_ref: auth.otpRef, gstin: cfg().gstin, mode: 'live' };
}

async function validateOtp(otp) {
  const code = String(otp || '').trim();
  if (!hasCreds()) throw notConfigured();
  if (!auth.otpRef) throw Object.assign(new Error('Request an OTP first (POST /api/gstn/otp/request)'), { status: 400 });
  const resp = await fetch(baseUrl() + authPath(), {
    method: 'POST',
    headers: gspHeaders(),
    body: JSON.stringify({ action: 'AUTHTOKEN', username: cfg().username, app_key: cfg().app_key, otp: code }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.auth_token) throw new Error(`GSTN authentication failed (${resp.status}): ${json.message || json.error || resp.statusText}`);
  const expiry = Number(json.expiry || 120) * 60 * 1000;
  auth.token = json.auth_token;
  auth.expiresAt = Date.now() + expiry;
  return { status: 'AUTHENTICATED', mode: 'live', expiry_minutes: Math.round(expiry / 60000), auth_token: mask(json.auth_token) };
}

function mask(token) {
  return token ? token.slice(0, 6) + '…' + token.slice(-4) : null;
}

function gspHeaders(extra = {}) {
  const c = cfg();
  return {
    'content-type': 'application/json',
    'clientid': c.client_id,
    'client-secret': c.client_secret,
    'state-cd': stateCd(),
    'ip-usr': c.ip_usr,
    'txn': 'TXN-' + Date.now(),
    ...(auth.token ? { 'auth-token': auth.token } : {}),
    ...extra,
  };
}

function requireAuth() {
  if (!hasCreds()) throw notConfigured();
  if (!auth.token || auth.expiresAt < Date.now()) {
    throw Object.assign(new Error('GSTN auth token missing or expired — request an OTP and validate first'), { status: 401 });
  }
}

// ---- GSTR-2B ----
// Live: GET {GSTR2B_PATH}/{gstin} (GSP-specific query params for period).
// Mock: build a realistic GSP-shaped payload from platform invoices.
async function fetchGstr2bRaw(companyId, period, gstin) {
  if (!hasCreds()) throw notConfigured();
  requireAuth();
  const resp = await fetch(`${baseUrl()}${gstr2bPath()}/${encodeURIComponent(gstin)}?fp=${period}`, {
    method: 'GET',
    headers: gspHeaders(),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`GSTR-2B fetch failed (${resp.status}): ${json.message || json.error || resp.statusText}`);
  return json;
}

// Pure mapper: GSP GSTR-2B payload -> our snapshot rows (invoice_no, gstin,
// taxable, cgst, sgst, igst) plus totals. Unit-tested with a real fixture.
function mapGstr2b(payload, opts = {}) {
  // GSP payloads can return amounts as numbers or comma-formatted strings;
  // normalize both so a live fetch can never poison the ITC totals.
  const num = (v) => {
    if (v == null) return 0;
    const n = Number(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const period = opts.period || payload.fp || payload.period || todayStr().slice(0, 7);
  const gstin = opts.gstin || payload.gstin || null;
  const b2b = Array.isArray(payload.b2b) ? payload.b2b : [];
  const invoices = b2b.map(r => ({
    invoice_no: String(r.docno || r.doc_num || r.document_number || ''),
    gstin: r.ctin || r.supplier_gstin || null,
    taxable: inr(num(r.txval)),
    cgst: inr(num(r.cgst)),
    sgst: inr(num(r.sgst)),
    igst: inr(num(r.igst)),
    cess: inr(num(r.cess)),
    supplier_filed_on: r.supfildt || null,
  })).filter(r => r.invoice_no);
  // GSTR-2B CDNR section: credit/debit notes issued by suppliers. Same row
  // shape as b2b plus the GSTN document type (C = credit note, D = debit
  // note) so scanMismatches can compare them against imported note vouchers.
  const cdnr = (Array.isArray(payload.cdnr) ? payload.cdnr : []).map(r => ({
    invoice_no: String(r.docno || r.doc_num || r.document_number || ''),
    gstin: r.ctin || r.supplier_gstin || null,
    taxable: inr(num(r.txval)),
    cgst: inr(num(r.cgst)),
    sgst: inr(num(r.sgst)),
    igst: inr(num(r.igst)),
    cess: inr(num(r.cess)),
    doc_type: r.typ || r.doc_type || null,
  })).filter(r => r.invoice_no);
  const itc = (k) => inr(invoices.reduce((s, r) => s + (r[k] || 0), 0));
  return {
    period, gstin,
    total_itc: inr(itc('cgst') + itc('sgst') + itc('igst')),
    itc_cgst: itc('cgst'), itc_sgst: itc('sgst'), itc_igst: itc('igst'),
    invoices,
    cdnr,
    credit_notes: cdnr.length,
    source: 'gstn-live',
    fetched_at: nowIso(),
  };
}

// ---- e-invoice (IRP) contract stub ----
function buildEinvoiceBody(inv, opts = {}) {
  const seller = opts.seller || { gstin: cfg().gstin, name: 'Seller Company Pvt Ltd', addr: 'Bengaluru, Karnataka 560001' };
  const buyer = opts.buyer || { gstin: inv.gstin_vendor || '', name: inv.vendor_name || 'Buyer', addr: '' };
  const items = Array.isArray(inv.lines) && inv.lines.length ? inv.lines : [{ hsn: '9988', description: 'Goods & services', qty: 1, rate: inv.taxable_amount || 0, taxable: inv.taxable_amount || 0, cgst: inv.cgst || 0, sgst: inv.sgst || 0, igst: inv.igst || 0 }];
  return {
    Version: '1.03',
    TranDtls: { SupTyp: 'B2B', RegRev: 'N', EcmGstin: '', IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: inv.invoice_no, Dt: inv.invoice_date },
    SellerDtls: { Gstin: seller.gstin, LglNm: seller.name, TrdNm: seller.name, Addr1: seller.addr, Loc: 'Bengaluru', Pin: 560001, StCd: 29, Ph: '0800000000', Em: 'finance@company.in' },
    BuyerDtls: { Gstin: buyer.gstin, LglNm: buyer.name, TrdNm: buyer.name, Addr1: buyer.addr || 'Registered Address', Loc: '', Pin: 0, StCd: 0, Ph: '', Em: '' },
    ItemList: items.map((l, i) => ({
      SlNo: i + 1, PrdDesc: l.description || 'Goods & services', HsnCd: String(l.hsn || '9988'), Barcde: '',
      Qty: l.qty || 1, FreeQty: 0, Unit: 'NOS', UnitPrice: inr(l.rate || 0), TotAmt: inr(l.taxable || 0), Discount: 0,
      PreGstVal: inr(l.taxable || 0), AssAmt: inr(l.taxable || 0), GstRt: inv.igst ? 18 : 18, CgstAmt: inr(l.cgst || 0), SgstAmt: inr(l.sgst || 0), IgstAmt: inr(l.igst || 0),
      CesAmt: 0, StateCesAmt: 0, StateCesRt: 0, CesNonAdvolAmt: 0, TotInvValFc: 0,
    })),
    ValDtls: {
      AssVal: inr(inv.taxable_amount || 0), CgstVal: inr(inv.cgst || 0), SgstVal: inr(inv.sgst || 0), IgstVal: inr(inv.igst || 0),
      CesVal: 0, StateCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: inr(inv.gross_amount || 0), TotInvValFc: inr(inv.gross_amount || 0),
    },
    EwbDtls: null,
  };
}

async function generateIrn(invoice) {
  if (!hasCreds()) throw notConfigured();
  requireAuth();
  const body = buildEinvoiceBody(invoice);
  const c = cfg();
  const resp = await fetch(einvBase() + '/einv/v1.0/irn/generate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'gstin': c.gstin, 'client_id': c.client_id, 'client_secret': c.client_secret,
      'user_name': c.username, 'txn': 'TXN-' + Date.now(),
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`IRN generation failed (${resp.status}): ${json.message || json.error || resp.statusText}`);
  return { irn: json.irn, irp_status: json.irp_status || 'IRN_GENERATED', mode: 'live', signed_qr_code: json.signed_qr_code, signed_invoice: json.signed_invoice };
}

module.exports = { config, mode, requestOtp, validateOtp, fetchGstr2bRaw, mapGstr2b, buildEinvoiceBody, generateIrn, stateCd };
