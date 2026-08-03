'use strict';

// ============================================================================
// Tally XML toolkit — cloud-only.
//
// KhataOS runs in the cloud, so it never talks to Tally over the LAN port.
// The supported path is file-based: the user exports Groups, Ledgers and
// Vouchers from Tally as XML and uploads the file. This module is the parser
// and voucher builders for that path (import pipeline: server/src/tally-import.js).
//
// Parser is deliberately tolerant of real Tally exports, which vary by
// release and export type:
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
//   - entries:         each entry also carries ISDEEMEDPOSITIVE (debit side)
//                      and BILLALLOCATIONS.LIST references (Agst Ref)
//   - entities:        &amp; etc. are decoded; BOM / missing <ENVELOPE>
//                      wrappers are tolerated; attributes on tags ignored.
// ============================================================================

// ---- XML escaping + tiny parser (Tally's responses are predictable) ----
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (v) => String(v ?? '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Inner content of every <TAG ...>...</TAG> block (attributes tolerated).
function extractBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

// Blocks plus the raw opening-tag attributes (for VCHTYPE etc.).
function extractBlocksWithAttrs(xml, tag) {
  const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', inner: m[2] });
  return out;
}

function attr(attrs, name) {
  const m = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? unesc(m[1]) : null;
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? unesc(m[1].trim()) : null;
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
function extractEntries(inner) {
  const out = [];
  const parseEntry = (e) => {
    const ledger = tag(e, 'LEDGERNAME');
    if (!ledger) return null;
    const amount = num(tag(e, 'AMOUNT'));
    const posRaw = tag(e, 'ISDEEMEDPOSITIVE');
    const positive = /^yes$/i.test(posRaw || '') ? true : /^no$/i.test(posRaw || '') ? false : null;
    const billRefs = extractBlocks(e, 'BILLALLOCATIONS.LIST').map((b) => tag(b, 'NAME')).filter(Boolean);
    return { ledger, amount, positive, bill_refs: billRefs };
  };
  for (const e of extractBlocks(inner, 'LEDGERENTRY')) {
    const entry = parseEntry(e);
    if (entry) out.push(entry);
  }
  for (const e of extractBlocks(inner, 'LEDGERENTRIES.LIST')) {
    // Skip flat lists that wrap nested LEDGERENTRY blocks (handled above) so
    // the same entry is never counted twice.
    if (extractBlocks(e, 'LEDGERENTRY').length) continue;
    const entry = parseEntry(e);
    if (entry) out.push(entry);
  }
  for (const inv of extractBlocks(inner, 'ALLINVENTORYENTRIES.LIST')) {
    for (const a of extractBlocks(inv, 'ACCOUNTINGALLOCATIONS.LIST')) {
      const entry = parseEntry(a);
      if (entry) out.push(entry);
    }
  }
  return out;
}

// ---- parse a Tally export file (ENVELOPE wrapper optional) ----
function parseExport(xml) {
  const out = { company: null, groups: [], ledgers: [], vouchers: [] };
  const text = String(xml || '').replace(/^\uFEFF/, '').replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  if (!text.trim()) return out;

  const companyBlock = extractBlocks(text, 'COMPANY')[0];
  if (companyBlock) out.company = tag(companyBlock, 'NAME');
  // Voucher-only exports (Export Data -> Voucher Register) carry the company
  // in <STATICVARIABLES><SVCURRENTCOMPANY>...</SVCURRENTCOMPANY>.
  if (!out.company) out.company = tag(text, 'SVCURRENTCOMPANY') || null;

  for (const b of extractBlocks(text, 'GROUP')) {
    const name = tag(b, 'NAME');
    if (!name) continue;
    out.groups.push({
      name,
      parent: tag(b, 'PARENT') || null,
      tally_guid: tag(b, 'GUID') || null,
      tally_alterid: num(tag(b, 'ALTERID')) || 0,
    });
  }

  for (const b of extractBlocks(text, 'LEDGER')) {
    const name = tag(b, 'NAME') || tag(b, 'LEDGERNAME');
    if (!name) continue;
    out.ledgers.push({
      name,
      group_name: tag(b, 'PARENT') || null,
      opening_balance: num(tag(b, 'OPENINGBALANCE')) ?? 0,
      gstin: tag(b, 'GSTIN') || null,
      tally_guid: tag(b, 'GUID') || null,
      tally_alterid: num(tag(b, 'ALTERID')) || 0,
    });
  }

  for (const v of extractBlocksWithAttrs(text, 'VOUCHER')) {
    const inner = v.inner;
    // Strip the entries/inventory sections so voucher-level fields
    // (VOUCHERNUMBER, DATE, AMOUNT, PARTYLEDGERNAME) are never confused with
    // values nested inside them (e.g. the first entry's <AMOUNT>).
    // Entries can be <LEDGERENTRIES> or <LEDGERENTRIES.LIST>; inventory
    // vouchers also carry <ALLINVENTORYENTRIES.LIST> line-item amounts.
    const clean = String(inner)
      .replace(/<LEDGERENTRIES(?:\.[A-Z]+)?>[\s\S]*?<\/LEDGERENTRIES(?:\.[A-Z]+)?>/gi, '')
      .replace(/<ALLINVENTORYENTRIES(?:\.[A-Z]+)?>[\s\S]*?<\/ALLINVENTORYENTRIES(?:\.[A-Z]+)?>/gi, '');
    const party = tag(clean, 'PARTYLEDGERNAME') || tag(clean, 'PARTYNAME') || null;
    const entries = extractEntries(inner);
    const explicit = num(tag(clean, 'AMOUNT'));
    out.vouchers.push({
      voucher_number: tag(clean, 'VOUCHERNUMBER') || tag(clean, 'VCHNUM') || null,
      voucher_type: tag(clean, 'VOUCHERTYPENAME') || attr(v.attrs, 'VCHTYPE') || null,
      date: normalizeTallyDate(tag(clean, 'DATE') || tag(clean, 'VCHDATE')),
      amount: explicit != null ? explicit : (entries.length ? deriveAmount(entries, party) : 0),
      party_name: party,
      entries,
      tally_guid: tag(clean, 'GUID') || null,
      tally_alterid: num(tag(clean, 'ALTERID')) || 0,
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
  _internals: { extractBlocks, extractBlocksWithAttrs, attr, tag, num, deriveAmount, extractEntries },
};
