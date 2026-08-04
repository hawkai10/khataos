'use strict';

// Frozen copy of the original hand-rolled Tally XML parser (pre
// fast-xml-parser). Used ONLY by the equivalence test to prove the new parser
// produces byte-for-byte identical structured output for the same inputs.

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (v) => String(v ?? '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function extractBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

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

function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).replace(/[,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  // Frozen reference parser now mirrors the money model: decimal rupees ->
  // integer paise, so the equivalence test compares like-for-like.
  const neg = m[1] === '-';
  const int = BigInt(m[2]);
  const frac = m[3] || '';
  let paise = int * 100n + BigInt((frac + '00').slice(0, 2));
  if (frac.length > 2 && BigInt(frac[2]) >= 5n) paise += 1n;
  return Number(neg ? -paise : paise);
}

// Non-money integer ids (ALTERID) — never amounts.
function intOf(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeTallyDate(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

function deriveAmount(entries, party) {
  if (!entries.length) return 0;
  const partyEntry = party ? entries.find((e) => e.ledger === party && e.amount != null) : null;
  if (partyEntry) return partyEntry.amount;
  return entries.reduce((best, e) => (e.amount != null && Math.abs(e.amount) >= Math.abs(best) ? e.amount : best), 0);
}

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

function parseExport(xml) {
  const out = { company: null, groups: [], ledgers: [], vouchers: [] };
  const text = String(xml || '').replace(/^\uFEFF/, '').replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  if (!text.trim()) return out;

  const companyBlock = extractBlocks(text, 'COMPANY')[0];
  if (companyBlock) out.company = tag(companyBlock, 'NAME');
  if (!out.company) out.company = tag(text, 'SVCURRENTCOMPANY') || null;

  for (const b of extractBlocks(text, 'GROUP')) {
    const name = tag(b, 'NAME');
    if (!name) continue;
    out.groups.push({
      name,
      parent: tag(b, 'PARENT') || null,
      tally_guid: tag(b, 'GUID') || null,
      tally_alterid: intOf(tag(b, 'ALTERID')) || 0,
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
      tally_alterid: intOf(tag(b, 'ALTERID')) || 0,
    });
  }

  for (const v of extractBlocksWithAttrs(text, 'VOUCHER')) {
    const inner = v.inner;
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
      tally_alterid: intOf(tag(clean, 'ALTERID')) || 0,
      cancelled: /^yes$/i.test(tag(clean, 'ISCANCELLED') || ''),
    });
  }
  return out;
}

module.exports = { parseExport, normalizeTallyDate, voucherBalance, _internals: { extractBlocks, extractBlocksWithAttrs, attr, tag, num, deriveAmount, extractEntries } };
