'use strict';

// ============================================================================
// Tally XML toolkit — cloud-only.
//
// KhataOS runs in the cloud, so it never talks to Tally over the LAN port.
// The supported path is file-based: the user exports Groups, Ledgers and
// Vouchers from Tally as XML and uploads the file. This module is the parser
// and voucher builders for that path (import pipeline: server/src/tally-import.js).
//
// Raw XML -> object conversion is delegated to fast-xml-parser; this module
// only re-implements the Tally normalization layer on top of that output:
//   - voucher number:  <VOUCHERNUMBER> or <VCHNUM>
//   - voucher date:    <DATE> or <VCHDATE> (YYYYMMDD or YYYY-MM-DD)
//   - voucher type:    <VOUCHERTYPENAME> or the VCHTYPE attribute
//   - entries:         <LEDGERENTRIES><LEDGERENTRY> (nested),
//                      <LEDGERENTRIES.LIST> (flat, one block per entry), or
//                      <ALLINVENTORYENTRIES.LIST> accounting allocations
//   - amount:          a genuine voucher-level <AMOUNT> wins; else the
//                      party-ledger entry; else the largest entry (ties
//                      resolve to the positive side)
//   - identity:        <GUID> + <ALTERID> on masters/vouchers, used for
//                      upsert (edit detection on re-export)
//   - cancellation:    <ISCANCELLED>Yes</ISCANCELLED> marks a cancelled
//                      voucher; the flag is stored for audit and excluded
//                      from aging/recon/GST consumers (never from storage)
//   - entries:         each entry also carries ISDEEMEDPOSITIVE (debit side)
//                      and BILLALLOCATIONS.LIST references (Agst Ref)
//   - entities:        &amp; etc. are decoded by the parser; BOM / missing
//                      <ENVELOPE> wrappers are tolerated; attributes kept.
//
// fast-xml-parser coverage notes (v5):
//   - Tally uses mixed-case tags (<LEDGER>, <Ledger>, <VOUCHER>) — the parser
//     preserves case, so every lookup here is case-insensitive (the old
//     regex parser matched case-insensitively too).
//   - Tag values are kept as raw strings (parseTagValue/parseAttributeValue
//     false) so number normalization stays exactly where it was.
//   - Repeated tags come back as arrays only when repeated; `asArray` coerces
//     single nodes so the rest of the code can always iterate.
//   - Malformed input makes the parser throw; parseExport swallows that and
//     returns the empty structure, exactly like the old regex parser.
// ============================================================================

const { XMLParser } = require('fast-xml-parser');

// ---- XML escaping (builders only) ----
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- raw XML -> object (fast-xml-parser) ----
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,      // keep raw strings; num() owns number coercion
  parseAttributeValue: false,
  trimValues: true,
});

function parseXml(text) {
  try {
    const root = parser.parse(text);
    return root && typeof root === 'object' ? root : {};
  } catch {
    return {}; // malformed fragments parse to nothing, never throw
  }
}

// ---- normalization helpers over the parsed object tree ----

function asArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

// Depth-first visit of every element node (attributes are skipped). Keeps
// document order for repeated elements, mirroring the old regex scan.
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_')) continue; // attribute keys, not elements
      visit(key, value);
      walk(value, visit);
    }
  }
}

// Every element named `tagName` anywhere in the tree (case-insensitive,
// single occurrences coerced to arrays), in document order.
function blocksOf(root, tagName) {
  const upper = String(tagName).toUpperCase();
  const out = [];
  walk(root, (key, value) => {
    if (key.toUpperCase() !== upper) return;
    for (const b of asArray(value)) if (b && typeof b === 'object') out.push(b);
  });
  return out;
}

function hasKey(node, name) {
  if (node == null || typeof node !== 'object') return false;
  const upper = String(name).toUpperCase();
  return Object.keys(node).some((k) => !k.startsWith('@_') && k.toUpperCase() === upper);
}

// Text value of a direct child element (case-insensitive), or null.
function valueOf(node, name) {
  if (node == null || typeof node !== 'object') return null;
  const upper = String(name).toUpperCase();
  const key = Object.keys(node).find((k) => !k.startsWith('@_') && k.toUpperCase() === upper);
  if (key == null) return null;
  const v = node[key];
  if (v == null) return null;
  if (typeof v === 'object') {
    if (Object.prototype.hasOwnProperty.call(v, '#text')) return String(v['#text']).trim();
    return null; // nested element, not a text value
  }
  return String(v).trim();
}

// Attribute value (case-insensitive), or null. Entities are already decoded
// by fast-xml-parser.
function attrOf(node, name) {
  if (node == null || typeof node !== 'object') return null;
  const upper = String(name).toUpperCase();
  const key = Object.keys(node).find((k) => k.startsWith('@_') && k.slice(2).toUpperCase() === upper);
  return key == null ? null : String(node[key]).trim();
}

// First text value of an element anywhere in the tree (document order).
function firstValueOf(root, name) {
  const upper = String(name).toUpperCase();
  let found = null;
  walk(root, (key, value) => {
    if (found != null) return;
    if (key.toUpperCase() !== upper) return;
    if (value != null && typeof value !== 'object') found = String(value).trim();
  });
  return found;
}

// Parse a number safely: null when missing/empty/non-numeric, otherwise the
// value with commas/whitespace stripped. Never throws.
function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeTallyDate(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`; // YYYYMMDD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

// Voucher amount: the party-ledger entry (e.g. +455000 for a Payment to the
// vendor), else the largest entry (ties resolve to the positive side, so a
// Journal/Contra with +/- equal legs reports the positive total). Only used
// when the voucher has no genuine voucher-level <AMOUNT>.
function deriveAmount(entries, party) {
  if (!entries.length) return 0;
  const partyEntry = party ? entries.find((e) => e.ledger === party && e.amount != null) : null;
  if (partyEntry) return partyEntry.amount;
  return entries.reduce((best, e) => (e.amount != null && Math.abs(e.amount) >= Math.abs(best) ? e.amount : best), 0);
}

// Sum the debit (ISDEEMEDPOSITIVE=Yes) and credit (No) legs of a voucher.
// Missing flags fall back to amount sign (negative = debit), which matches
// Tally's export convention. Returns { debit, credit, balanced }.
function voucherBalance(v) {
  let debit = 0;
  let credit = 0;
  for (const e of (v && v.entries) || []) {
    const amt = Math.abs(e.amount || 0);
    const isDebit = e.positive != null ? e.positive : (e.amount != null && e.amount < 0);
    if (isDebit) debit += amt; else credit += amt;
  }
  return { debit, credit, balanced: Math.abs(debit - credit) < 0.01 };
}

// Voucher ledger entries appear in several real Tally export shapes:
//   1. nested:  <LEDGERENTRIES><LEDGERENTRY><LEDGERNAME>..</LEDGERNAME><AMOUNT>..</AMOUNT></LEDGERENTRY></LEDGERENTRIES>
//   2. flat:    <LEDGERENTRIES.LIST><LEDGERNAME>..</LEDGERNAME><AMOUNT>..</AMOUNT></LEDGERENTRIES.LIST> (one per entry)
//   3. stock:   <ALLINVENTORYENTRIES.LIST>..<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>..</LEDGERNAME><AMOUNT>..</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
function extractEntries(voucherNode) {
  const out = [];
  const parseEntry = (e) => {
    const ledger = valueOf(e, 'LEDGERNAME');
    if (!ledger) return null;
    const amount = num(valueOf(e, 'AMOUNT'));
    const posRaw = valueOf(e, 'ISDEEMEDPOSITIVE');
    const positive = /^yes$/i.test(posRaw || '') ? true : /^no$/i.test(posRaw || '') ? false : null;
    const billRefs = blocksOf(e, 'BILLALLOCATIONS.LIST').map((b) => valueOf(b, 'NAME')).filter(Boolean);
    return { ledger, amount, positive, bill_refs: billRefs };
  };
  for (const e of blocksOf(voucherNode, 'LEDGERENTRY')) {
    const entry = parseEntry(e);
    if (entry) out.push(entry);
  }
  for (const e of blocksOf(voucherNode, 'LEDGERENTRIES.LIST')) {
    // Skip flat lists that wrap nested LEDGERENTRY blocks (handled above) so
    // the same entry is never counted twice.
    if (hasKey(e, 'LEDGERENTRY')) continue;
    const entry = parseEntry(e);
    if (entry) out.push(entry);
  }
  for (const a of blocksOf(voucherNode, 'ACCOUNTINGALLOCATIONS.LIST')) {
    const entry = parseEntry(a);
    if (entry) out.push(entry);
  }
  return out;
}

// ---- parse a Tally export file (ENVELOPE wrapper optional) ----
function parseExport(xml) {
  const out = { company: null, groups: [], ledgers: [], vouchers: [] };
  const text = String(xml || '').replace(/^\uFEFF/, '').replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  if (!text.trim()) return out;
  const root = parseXml(text);
  if (!Object.keys(root).length) return out;

  const companyBlock = blocksOf(root, 'COMPANY')[0];
  if (companyBlock) out.company = valueOf(companyBlock, 'NAME');
  // Voucher-only exports (Export Data -> Voucher Register) carry the company
  // in <STATICVARIABLES><SVCURRENTCOMPANY>...</SVCURRENTCOMPANY>.
  if (!out.company) out.company = firstValueOf(root, 'SVCURRENTCOMPANY') || null;

  for (const b of blocksOf(root, 'GROUP')) {
    const name = valueOf(b, 'NAME');
    if (!name) continue;
    out.groups.push({
      name,
      parent: valueOf(b, 'PARENT') || null,
      tally_guid: valueOf(b, 'GUID') || null,
      tally_alterid: num(valueOf(b, 'ALTERID')) || 0,
    });
  }

  for (const b of blocksOf(root, 'LEDGER')) {
    const name = valueOf(b, 'NAME') || valueOf(b, 'LEDGERNAME');
    if (!name) continue;
    out.ledgers.push({
      name,
      group_name: valueOf(b, 'PARENT') || null,
      opening_balance: num(valueOf(b, 'OPENINGBALANCE')) ?? 0,
      gstin: valueOf(b, 'GSTIN') || null,
      tally_guid: valueOf(b, 'GUID') || null,
      tally_alterid: num(valueOf(b, 'ALTERID')) || 0,
    });
  }

  for (const v of blocksOf(root, 'VOUCHER')) {
    // Voucher-level fields are direct children of the VOUCHER node; entries
    // live under LEDGERENTRIES / LEDGERENTRIES.LIST / ALLINVENTORYENTRIES.LIST,
    // so they can never be confused with voucher-level values.
    const party = valueOf(v, 'PARTYLEDGERNAME') || valueOf(v, 'PARTYNAME') || null;
    const entries = extractEntries(v);
    const explicit = num(valueOf(v, 'AMOUNT'));
    out.vouchers.push({
      voucher_number: valueOf(v, 'VOUCHERNUMBER') || valueOf(v, 'VCHNUM') || null,
      voucher_type: valueOf(v, 'VOUCHERTYPENAME') || attrOf(v, 'VCHTYPE') || null,
      date: normalizeTallyDate(valueOf(v, 'DATE') || valueOf(v, 'VCHDATE')),
      amount: explicit != null ? explicit : (entries.length ? deriveAmount(entries, party) : 0),
      party_name: party,
      entries,
      tally_guid: valueOf(v, 'GUID') || null,
      tally_alterid: num(valueOf(v, 'ALTERID')) || 0,
      cancelled: /^yes$/i.test(valueOf(v, 'ISCANCELLED') || ''),
    });
  }
  return out;
}

// ---- voucher builders (Tally-format XML for reference/import elsewhere) ----
function buildPurchaseVoucher(inv, vendor) {
  const party = (vendor && (vendor.ledger_name || vendor.name)) || 'Sundry Creditors';
  const gross = inv.gross_amount || 0;
  const cgst = inv.cgst || 0;
  const sgst = inv.sgst || 0;
  const igst = inv.igst || 0;
  const tds = inv.tds_amount || 0;
  const net = inv.net_payable != null ? inv.net_payable : gross;
  const entries = [['Sundry Creditors', net]];
  if (cgst) entries.push(['Input CGST', -cgst]);
  if (sgst) entries.push(['Input SGST', -sgst]);
  if (igst) entries.push(['Input IGST', -igst]);
  if (tds) entries.push(['TDS Payable', tds]);
  const ledgers = entries
    .map(([name, amt]) => `      <LEDGERENTRY>\n        <LEDGERNAME>${esc(name)}</LEDGERNAME>\n        <AMOUNT>${Number(amt) || 0}</AMOUNT>\n      </LEDGERENTRY>`)
    .join('\n');
  return (
    `<VOUCHER VCHTYPE="Purchase" ACTION="Create">\n` +
    `  <DATE>${esc(inv.invoice_date || '')}</DATE>\n` +
    `  <VOUCHERNUMBER>${esc(inv.invoice_no || '')}</VOUCHERNUMBER>\n` +
    `  <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>\n` +
    `  <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>\n` +
    `  <LEDGERENTRIES>\n${ledgers}\n  </LEDGERENTRIES>\n` +
    `</VOUCHER>`
  );
}

function buildPaymentVoucher(payment, vendor) {
  const party = (vendor && (vendor.ledger_name || vendor.name)) || 'Sundry Creditors';
  return (
    `<VOUCHER VCHTYPE="Payment" ACTION="Create">\n` +
    `  <DATE>${esc((payment.processed_at || payment.initiated_at || '').slice(0, 10))}</DATE>\n` +
    `  <VOUCHERNUMBER>${esc(payment.reference || '')}</VOUCHERNUMBER>\n` +
    `  <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>\n` +
    `  <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>\n` +
    `  <LEDGERENTRIES>\n` +
    `      <LEDGERENTRY><LEDGERNAME>${esc(party)}</LEDGERNAME><AMOUNT>${Number(payment.amount) || 0}</AMOUNT></LEDGERENTRY>\n` +
    `      <LEDGERENTRY><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>-${Number(payment.net_amount) || 0}</AMOUNT></LEDGERENTRY>\n` +
    `  </LEDGERENTRIES>\n` +
    `</VOUCHER>`
  );
}

function config() {
  return {
    provider: 'tally-xml-upload',
    protocol: 'Tally Export -> XML file -> cloud import',
    mode: 'cloud-upload',
    enabled: true,
    note: 'Cloud-only deployment: no live Tally connection; upload Tally XML exports (Groups, Ledgers, Vouchers).',
  };
}

module.exports = {
  config, parseExport, normalizeTallyDate, buildPurchaseVoucher, buildPaymentVoucher, voucherBalance,
  _internals: { asArray, blocksOf, hasKey, valueOf, attrOf, firstValueOf, num, deriveAmount, extractEntries, parseExport },
};
