'use strict';

// Vendor <-> Tally ledger mapping.
//
// The vendors table carries ledger_name (payments use it as the GST ledger
// and invoice capture uses the vendor's TDS treatment). After a Tally XML
// import, KhataOS auto-matches vendors to imported ledgers by name / GSTIN
// so invoices and payments automatically tag the correct Tally ledger.
// Ambiguous or weak matches are left for manual review in the UI.

const { all, get, withTransaction, T } = require('./db');
const { eq, and } = require('drizzle-orm');

const STOP_TOKENS = new Set(['and', 'co', 'pvt', 'ltd', 'llp', 'private', 'limited', 'the', 'of', '&']);
const GROUP_PREFIXES = ['sundrycreditors', 'sundrydebtors'];
const LEGAL_SUFFIXES = ['andco', 'privatelimited', 'pvtltd', 'co', 'pvt', 'ltd', 'llp', 'limited'];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_TOKENS.has(t));
}

function coreName(s) {
  let n = normalize(s);
  for (const p of GROUP_PREFIXES) {
    if (n.startsWith(p)) { n = n.slice(p.length); break; }
  }
  for (const suf of LEGAL_SUFFIXES) {
    if (n.endsWith(suf)) { n = n.slice(0, -suf.length); break; }
  }
  return n;
}

// 0 (no match) .. 1.0 (exact). Name-first, then GSTIN.
function scoreMatch(vendor, ledger) {
  const vn = normalize(vendor.name);
  const ln = normalize(ledger.name);
  if (!vn || !ln) return 0;
  if (vn === ln) return 1.0;
  if (vendor.gstin && ledger.gstin && normalize(vendor.gstin) === normalize(ledger.gstin)) return 0.95;
  const vt = tokens(vendor.name);
  const lt = tokens(coreName(ledger.name));
  if (vt.length >= 2 && lt.length >= 2) {
    const [small, big] = vt.length <= lt.length ? [vt, lt] : [lt, vt];
    if (small.every((t) => big.includes(t))) return 0.9; // token overlap
  }
  if (coreName(vendor.name) === coreName(ledger.name)) return 0.88;
  if (vn.includes(ln) || ln.includes(vn)) return 0.85;
  return 0;
}

// Match priority, in order: GSTIN exact -> name exact -> fuzzy.
function matchTier(vendor, ledger) {
  const vn = normalize(vendor.name);
  const ln = normalize(ledger.name);
  if (!vn || !ln) return null;
  if (vendor.gstin && ledger.gstin && normalize(vendor.gstin) === normalize(ledger.gstin)) return 'gstin';
  if (vn === ln) return 'exact';
  return 'fuzzy';
}

// Pure ranking of a vendor against an already-fetched ledger list. Callers
// pass the ledgers so the fetch and the decision stay on the same DB handle
// (report reads via the wrapper; autoMap reads via its transaction — a wrapper
// read inside an open Drizzle tx would hang single-connection engines).
function rankMatch(vendor, ledgers) {
  const gstinHits = [];
  const exactHits = [];
  const fuzzy = [];
  for (const ledger of ledgers) {
    const tier = matchTier(vendor, ledger);
    if (tier === 'gstin') gstinHits.push(ledger);
    else if (tier === 'exact') exactHits.push(ledger);
    else {
      const s = scoreMatch(vendor, ledger);
      if (s > 0) fuzzy.push({ ledger, score: s });
    }
  }
  if (gstinHits.length) return { ledger: gstinHits.length === 1 ? gstinHits[0] : null, tier: 'gstin', score: 1, ties: gstinHits.length };
  if (exactHits.length) return { ledger: exactHits.length === 1 ? exactHits[0] : null, tier: 'exact', score: 1, ties: exactHits.length };
  fuzzy.sort((a, b) => b.score - a.score);
  const best = fuzzy[0];
  if (!best) return { ledger: null, tier: 'fuzzy', score: 0, ties: 0 };
  const ties = fuzzy.filter((f) => f.score === best.score).length;
  return { ledger: ties === 1 ? best.ledger : null, tier: 'fuzzy', score: best.score, ties };
}

async function bestMatch(vendor, companyId) {
  const ledgers = await all('SELECT name, group_name, gstin FROM tally_ledgers WHERE company_id = ?', [companyId]);
  return rankMatch(vendor, ledgers);
}

async function report(companyId) {
  const vendors = await all('SELECT id, name, gstin, ledger_name, tds_section, category FROM vendors WHERE company_id = ? AND active = 1 ORDER BY name', [companyId]);
  const ledgers = await all('SELECT name, group_name FROM tally_ledgers WHERE company_id = ? ORDER BY name', [companyId]);
  const ledgerNames = new Set(ledgers.map((l) => l.name));
  const rows = [];
  for (const vendor of vendors) {
    const m = await bestMatch(vendor, companyId);
    const matched = m.ledger ? m.ledger.name : null;
    // A real reference is dangling when it points at a ledger that is no
    // longer in the imported chart (vendor.name is a "no mapping" placeholder).
    const dangling = !!vendor.ledger_name && vendor.ledger_name !== vendor.name && !ledgerNames.has(vendor.ledger_name);
    let status;
    if (dangling) status = 'dangling';
    else if (matched && vendor.ledger_name === matched) status = (m.tier === 'gstin' || m.tier === 'exact') ? 'auto' : 'manual';
    else if (vendor.ledger_name && vendor.ledger_name !== vendor.name) status = 'manual';
    else if (m.tier === 'gstin' || m.tier === 'exact') status = m.ties === 1 ? 'suggested' : 'review';
    else status = m.score > 0 ? 'review' : 'unmatched';
    rows.push({
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      vendor_gstin: vendor.gstin,
      category: vendor.category,
      tds_section: vendor.tds_section,
      current_ledger: vendor.ledger_name,
      matched_ledger: matched,
      confidence: m.score,
      tier: m.tier,
      status,
    });
  }
  const summary = {
    vendors: vendors.length,
    ledgers: ledgers.length,
    mapped: rows.filter((r) => r.status === 'auto' || r.status === 'manual').length,
    suggested: rows.filter((r) => r.status === 'suggested').length,
    review: rows.filter((r) => r.status === 'review').length,
    dangling: rows.filter((r) => r.status === 'dangling').length,
    unmatched: rows.filter((r) => r.status === 'unmatched').length,
  };
  return { rows, ledgers, summary };
}

// Apply auto-mapping: update vendor.ledger_name only for unambiguous GSTIN
// or exact-name matches. Fuzzy matches always stay in the review queue.
// All updates in a run commit atomically. `db` is the enclosing transaction
// when called from TallyConnector.pullLedgers; otherwise it opens its own.
// The ledger lookup runs on the same handle as the updates — never a wrapper
// read inside the open transaction (hangs single-connection engines).
async function autoMap(companyId, db) {
  const updated = [];
  const body = async (d) => {
    // Vendors + ledgers both read on the same handle as the updates — when
    // autoMap runs inside another transaction (pullLedgers) the wrapper is not
    // involved at all, which is required on single-connection engines.
    const vendors = await d.select({ id: T.vendors.id, name: T.vendors.name, gstin: T.vendors.gstin, ledger_name: T.vendors.ledger_name }).from(T.vendors).where(and(eq(T.vendors.company_id, companyId), eq(T.vendors.active, 1)));
    const ledgers = await d.select({ name: T.tally_ledgers.name, group_name: T.tally_ledgers.group_name, gstin: T.tally_ledgers.gstin }).from(T.tally_ledgers).where(eq(T.tally_ledgers.company_id, companyId));
    for (const vendor of vendors) {
      const m = rankMatch(vendor, ledgers);
      if ((m.tier === 'gstin' || m.tier === 'exact') && m.ties === 1 && m.ledger && vendor.ledger_name !== m.ledger.name) {
        const from = vendor.ledger_name;
        await d.update(T.vendors).set({ ledger_name: m.ledger.name }).where(eq(T.vendors.id, vendor.id));
        updated.push({ vendor_id: vendor.id, from, to: m.ledger.name, tier: m.tier });
      }
    }
    return { updated };
  };
  if (db) return body(db);
  return withTransaction((tx) => body(tx));
}

async function setMapping(companyId, vendorId, ledgerName, db) {
  const body = async (d) => {
    const vendor = (await d.select({ id: T.vendors.id, name: T.vendors.name }).from(T.vendors).where(and(eq(T.vendors.id, vendorId), eq(T.vendors.company_id, companyId))).limit(1))[0];
    if (!vendor) throw new Error('vendor not found');
    const name = String(ledgerName || '').trim();
    if (name) {
      const ledger = (await d.select({ name: T.tally_ledgers.name }).from(T.tally_ledgers).where(and(eq(T.tally_ledgers.company_id, companyId), eq(T.tally_ledgers.name, name))).limit(1))[0];
      if (!ledger) throw new Error(`Tally ledger "${name}" is not in this company's import`);
    }
    await d.update(T.vendors).set({ ledger_name: name || vendor.name }).where(eq(T.vendors.id, vendorId));
    return { vendor_id: vendorId, ledger_name: name || vendor.name };
  };
  if (db) return body(db);
  return withTransaction((tx) => body(tx));
}

module.exports = { report, autoMap, setMapping, scoreMatch, matchTier, rankMatch, _internals: { normalize, tokens, coreName } };
