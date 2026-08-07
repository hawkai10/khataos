'use strict';

// ============================================================================
// Indian tax computation for invoice capture — TDS and GST. Pure functions,
// unit-tested with worked examples (tests/tax-compliance.test.js). The rules
// here are the ONLY place tax numbers are produced: capture never guesses a
// rate, a state, or a base — if the input can't determine one, it throws a
// 400 via ApiError.
//
// All amounts are paise (Number or BigInt in, BigInt-safe math out via Money);
// the functions return plain Numbers (safe integers) for persistence.
//
// TDS (Circular 23/2017): deducted on the amount EXCLUDING GST when GST is
// separately indicated (the default), or on the gross when the invoice does
// not separate GST (vendor.tds_on_gross). Section thresholds: 194C ₹30k
// single / ₹1L FY aggregate, 194J ₹30k single. A Section 197 lower-deduction
// certificate (vendor.tds_cert_rate) overrides the section rate and skips the
// threshold exemption.
//
// GST: the rate is always explicit (invoice-level gst_rate or a per-line
// gst_rate). Intra/inter-state is derived from the company and supplier GSTIN
// state codes (first two digits): same state -> CGST+SGST, different -> IGST.
// Cess is passed explicitly. Missing data -> 400, never a guess.
// ============================================================================

const { Money } = require('../money');
const { ApiError } = require('../auth');

// Section thresholds in rupees: TDS does NOT apply while the single payment
// stays under `single` AND (for sections with an aggregate cap) the FY
// aggregate stays under `aggregate`.
const TDS_SECTIONS = {
  '194C': { single: 30000, aggregate: 100000 },
  '194J': { single: 30000 },
};

// Sanity ceiling for a GST rate percent (28% standard + cess; allow a little
// headroom for composite/compensation slabs).
const GST_MAX_RATE_PCT = 40;

// State code = first two digits of a 15-char GSTIN; null when absent/invalid.
function gstState(gstin) {
  const s = String(gstin || '').trim();
  return /^\d{2}/.test(s) ? s.slice(0, 2) : null;
}

// Financial year range (Apr 1 - Mar 31) containing the given YYYY-MM-DD date.
function fyRange(dateStr) {
  const d = new Date(String(dateStr || '').slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new ApiError(400, `invalid invoice_date: ${dateStr}`);
  const fyStartYear = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { start: `${fyStartYear}-04-01`, end: `${fyStartYear + 1}-03-31` };
}

// ----------------------------------------------------------------------------
// GST
// ----------------------------------------------------------------------------

// Given the explicit inputs, compute the GST split. Returns
// { cgst, sgst, igst, cess, lineRows } with paise as plain Numbers. Throws
// 400 whenever the split cannot be derived from real inputs.
function computeGst(opts) {
  const { taxablePaise, lines = [], gstRatePct, explicit = {}, companyGstin, supplierGstin } = opts;
  const taxable = Money.fromPaise(taxablePaise).toPaise(); // BigInt
  const cs = gstState(companyGstin);
  const ss = gstState(supplierGstin);
  // Explicit totals only count when at least one is a real non-zero figure —
  // an all-zero/absent split means the caller never expressed a rate (and an
  // exempt invoice must be declared via gst_rate: 0, never by omission).
  const hasExplicit = ['cgst', 'sgst', 'igst', 'cess'].some((k) => explicit[k] != null && explicit[k] !== '' && Number(explicit[k]) !== 0);

  const toNum = (v) => Number(Money.fromPaise(v || 0).toPaise());

  // ---- per-line computation (HSN-driven rates) ----
  const lineRows = [];
  if (lines.length) {
    let sumTaxable = 0n, sumCgst = 0n, sumSgst = 0n, sumIgst = 0n, sumCess = 0n;
    for (const l of lines) {
      const lineTaxable = Money.fromPaise(l.taxable || 0).toPaise();
      let cgst = 0n, sgst = 0n, igst = 0n, cess = 0n;
      // Cess is orthogonal to the tax split — only cgst/sgst/igst decide
      // whether a line declares its own tax amounts vs. a rate.
      const hasLineTax = ['cgst', 'sgst', 'igst'].some((k) => l[k] != null && l[k] !== '');
      // Precedence: a per-line gst_rate, else per-line explicit tax, else the
      // invoice-level gst_rate as the line default.
      const effRate = l.gst_rate != null && l.gst_rate !== '' ? l.gst_rate : gstRatePct;
      if (effRate != null && effRate !== '' && !hasLineTax) {
        // Rate-driven: place of supply decides CGST/SGST vs IGST.
        if (cs == null || ss == null) {
          throw new ApiError(400, 'GST rate requires both the company and supplier GSTIN (to derive intra/inter-state); missing GSTIN or place of supply');
        }
        const rate = Number(effRate);
        if (!Number.isFinite(rate) || rate < 0 || rate > GST_MAX_RATE_PCT) {
          throw new ApiError(400, `invalid gst_rate ${effRate} on line ${l.hsn || ''} — must be 0-${GST_MAX_RATE_PCT}%`);
        }
        const tax = Money.fromPaise(lineTaxable).percentBps(Math.round(rate * 100)).toPaise();
        if (cs === ss) { const half = tax / 2n; cgst = half; sgst = tax - half; }
        else { igst = tax; }
        if (l.cess != null && l.cess !== '') cess = Money.fromPaise(l.cess).toPaise();
      } else if (hasLineTax) {
        cgst = Money.fromPaise(l.cgst || 0).toPaise();
        sgst = Money.fromPaise(l.sgst || 0).toPaise();
        igst = Money.fromPaise(l.igst || 0).toPaise();
        cess = Money.fromPaise(l.cess || 0).toPaise();
      } else {
        throw new ApiError(400, `line ${l.hsn || '(no hsn)'} needs a gst_rate or explicit cgst/sgst/igst/cess — capture does not guess tax`);
      }
      sumTaxable += lineTaxable; sumCgst += cgst; sumSgst += sgst; sumIgst += igst; sumCess += cess;
      lineRows.push({ hsn: l.hsn || null, description: l.description || null, qty: l.qty || 1, rate: l.rate || 0, taxable: Number(lineTaxable), cgst: Number(cgst), sgst: Number(sgst), igst: Number(igst), cess: Number(cess) });
    }
    if (Math.abs(Number(sumTaxable - taxable)) > 1) {
      throw new ApiError(400, `line taxable (${sumTaxable}) does not reconcile with taxable_amount (${taxable})`);
    }
    const totals = { cgst: Number(sumCgst), sgst: Number(sumSgst), igst: Number(sumIgst), cess: Number(sumCess) };
    reconcileExplicit(explicit, totals);
    validateSplit(totals, cs, ss);
    return { ...totals, lineRows };
  }

  // ---- no lines: invoice-level gst_rate or explicit totals ----
  if (gstRatePct != null && gstRatePct !== '') {
    const rate = Number(gstRatePct);
    if (!Number.isFinite(rate) || rate < 0 || rate > GST_MAX_RATE_PCT) {
      throw new ApiError(400, `invalid gst_rate ${gstRatePct} — must be 0-${GST_MAX_RATE_PCT}%`);
    }
    if (cs == null || ss == null) {
      throw new ApiError(400, 'gst_rate requires both the company and supplier GSTIN (to derive intra/inter-state); missing GSTIN or place of supply');
    }
    const tax = Money.fromPaise(taxable).percentBps(Math.round(rate * 100)).toPaise();
    const half = tax / 2n;
    const totals = cs === ss
      ? { cgst: Number(half), sgst: Number(tax - half), igst: 0, cess: toNum(explicit.cess) }
      : { cgst: 0, sgst: 0, igst: Number(tax), cess: toNum(explicit.cess) };
    reconcileExplicit(explicit, totals);
    return { ...totals, lineRows };
  }

  if (hasExplicit) {
    // Caller-declared split — use it, but verify it is consistent with the
    // derived place of supply when both GSTINs are known.
    let totals = { cgst: toNum(explicit.cgst), sgst: toNum(explicit.sgst), igst: toNum(explicit.igst), cess: toNum(explicit.cess) };
    // CGST and SGST rates are equal by statute: for an intra-state invoice
    // with only one side declared, the other side is derived — this is a legal
    // identity, not a guessed rate.
    if (cs != null && ss != null && cs === ss && totals.igst === 0) {
      if (totals.cgst > 0 && totals.sgst === 0) totals.sgst = totals.cgst;
      else if (totals.sgst > 0 && totals.cgst === 0) totals.cgst = totals.sgst;
    }
    validateSplit(totals, cs, ss);
    return { ...totals, lineRows };
  }

  // Nothing that determines tax: refuse to guess (gst_rate: 0 is the explicit
  // way to capture an exempt invoice).
  throw new ApiError(400, 'GST split missing — provide gst_rate (0 for exempt), per-line gst_rate/tax, or explicit cgst/sgst/igst/cess');
}

function reconcileExplicit(explicit, totals) {
  for (const k of ['cgst', 'sgst', 'igst', 'cess']) {
    const given = explicit[k];
    if (given != null && given !== '' && Math.abs(Number(given) - totals[k]) > 1) {
      throw new ApiError(400, `declared ${k} (${given}) does not match the computed ${k} (${totals[k]}) from the line rates`);
    }
  }
}

function validateSplit(totals, cs, ss) {
  if (cs == null || ss == null) return; // no place of supply derivable — trust the declared split
  if (cs === ss && totals.igst > 0) {
    throw new ApiError(400, `intra-state invoice (supplier GSTIN ${ss} same state as company) must use CGST+SGST, not IGST (${totals.igst})`);
  }
  if (cs !== ss && (totals.cgst > 0 || totals.sgst > 0)) {
    throw new ApiError(400, `inter-state invoice (supplier GSTIN ${ss} different state from company) must use IGST, not CGST/SGST`);
  }
}

// ----------------------------------------------------------------------------
// TDS
// ----------------------------------------------------------------------------

// Compute the TDS amount for one invoice. Returns
// { tds, ratePct, basePaise, exempt, reason } (paise as plain Numbers).
//   - base: taxable (excl. GST) per Circular 23/2017, or gross when
//     tdsOnGross is set (GST not separately indicated).
//   - rate: the Section 197 certificate rate when present, else the section
//     rate.
//   - thresholds: per TDS_SECTIONS, exempt when below; a 197 certificate
//     overrides the threshold exemption.
function computeTds(opts) {
  const { taxablePaise, grossPaise, tdsOnGross = 0, ratePct = 0, certRatePct, section, singlePaise, fyAggregatePaise = 0 } = opts;
  const taxable = Money.fromPaise(taxablePaise).toPaise(); // BigInt
  const gross = Money.fromPaise(grossPaise).toPaise();
  const base = tdsOnGross ? gross : taxable;
  const rate = certRatePct != null ? Number(certRatePct) : (Number(ratePct) || 0);
  // Validate BEFORE the zero/early return so a bad certificate rate (negative,
  // NaN, > 30%) is a 400, never a silent 0 or a 500.
  if (!Number.isFinite(rate) || rate < 0) {
    throw new ApiError(400, `invalid TDS rate ${certRatePct != null ? certRatePct : ratePct}`);
  }
  if (certRatePct != null && rate > 30) throw new ApiError(400, `invalid Section 197 certificate rate ${certRatePct}`);
  if (rate === 0) return { tds: 0, ratePct: 0, basePaise: Number(base), exempt: false, reason: 'no TDS rate configured' };

  const single = Money.fromPaise(singlePaise == null ? gross : singlePaise).toPaise();
  const fyAgg = Money.fromPaise(fyAggregatePaise || 0).toPaise();

  if (certRatePct == null) {
    const t = TDS_SECTIONS[section];
    if (t) {
      const singleExempt = single <= Money.fromRupees(t.single).toPaise();
      // Sections with an FY aggregate cap are exempt only while the aggregate
      // INCLUDING this invoice stays under the cap.
      const aggregateExempt = t.aggregate == null
        ? true
        : (fyAgg + single) <= Money.fromRupees(t.aggregate).toPaise();
      if (singleExempt && aggregateExempt) {
        return { tds: 0, ratePct: rate, basePaise: Number(base), exempt: true, reason: `${section}: below thresholds (single ₹${t.single} / FY ₹${t.aggregate ?? '—'})` };
      }
    }
  } else {
    // Section 197 certificate: deduct at the certified rate, no threshold
    // exemption.
    if (rate < 0 || rate > 30) throw new ApiError(400, `invalid Section 197 certificate rate ${certRatePct}`);
  }

  return { tds: Number(Money.fromPaise(base).percentBps(Math.round(rate * 10000)).toPaise()), ratePct: rate, basePaise: Number(base), exempt: false, reason: `${section || 'TDS'} at ${rate}% on ${tdsOnGross ? 'gross' : 'taxable'}` };
}

module.exports = { TDS_SECTIONS, GST_MAX_RATE_PCT, gstState, fyRange, computeGst, computeTds };
