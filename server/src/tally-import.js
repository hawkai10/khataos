'use strict';

// ============================================================================
// Tally XML cloud-import pipeline.
//
// For cloud-only deployments (KhataOS cannot reach the on-premise Tally port),
// the user exports Ledgers + Groups + Vouchers from Tally as XML and uploads
// the file here. The pipeline:
//   1. Parse  — Tally export XML -> { company, groups, ledgers, vouchers }
//   2. Validate — every reference resolves (groups -> ledgers -> vouchers),
//                 dates/amounts are numeric, GSTINs well-formed; invalid
//                 records are reported and skipped, never silently dropped.
//   3. Import — sequenced Groups -> Ledgers -> Vouchers, deduplicated per
//               company, preserving the accounting structure.
// ============================================================================

const { getDrizzle, DB_ENGINE, withTransaction } = require('./db');
const { sqlite, pg } = require('./db/schema');
const { eq } = require('drizzle-orm');
const { uid, nowIso, formatINR } = require('./util');
const Tally = require('./tally');

// Drizzle schema for the active engine (single-engine per process, mirroring
// db.js's engine selection).
const T = DB_ENGINE === 'sqlite' ? sqlite : pg;

// GSTIN = 15 chars: 2-digit state code, 10-char PAN (5 letters, 4 digits,
// 1 letter), entity code, 'Z', check character.
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Standard Tally groups used when a voucher-only export references ledgers
// that were not uploaded as masters. KhataOS auto-creates those ledgers under
// the closest standard group so a single Voucher Register export imports
// cleanly; each auto-created ledger is flagged in the result for review.
const AUTO_GROUPS = [
  'Sundry Debtors', 'Sundry Creditors', 'Bank Accounts', 'Cash-in-Hand',
  'Sales Accounts', 'Purchase Accounts', 'Duties & Taxes', 'Indirect Expenses',
  'Fixed Assets', 'Current Assets', 'Current Liabilities',
];

// Deterministic name-first inference, falling back to the voucher type:
// bank/cash/tax/sales/purchase/expense/asset names map to their standard
// Tally group; a Sales/Receipt party defaults to Sundry Debtors and a
// Purchase/Payment party to Sundry Creditors.
function inferLedgerGroup(name, vchType) {
  const n = String(name || '').toLowerCase();
  if (/(bank|hdfc|icici|axis|sbi|kota|overdraft|current a\/c)/.test(n)) return 'Bank Accounts';
  if (/cash/.test(n)) return 'Cash-in-Hand';
  if (/cgst|sgst|igst|tds|gst|vat|cess|duties|tax/.test(n)) return 'Duties & Taxes';
  if (/sales/.test(n)) return 'Sales Accounts';
  if (/purchase/.test(n)) return 'Purchase Accounts';
  if (/depreciation|salary|rent|electricity|insurance|repair|travell|advertis|commission|professional|bank charge|expense/.test(n)) return 'Indirect Expenses';
  if (/equipment|furniture|computer|vehicle|building|machinery|asset/.test(n)) return 'Fixed Assets';
  const t = String(vchType || '').toLowerCase();
  if (t === 'sales' || t === 'receipt') return 'Sundry Debtors';
  if (t === 'purchase' || t === 'payment') return 'Sundry Creditors';
  return 'Sundry Debtors';
}

// Every ledger referenced by a voucher (party + entries) that is not part of
// the uploaded masters. These get auto-created under an inferred group.
function planAutoLedgers(data) {
  const plan = new Map(); // ledger name -> group
  for (const v of data.vouchers) {
    const refs = [];
    if (v.party_name) refs.push(v.party_name);
    for (const e of v.entries || []) if (e.ledger) refs.push(e.ledger);
    for (const ref of refs) {
      if (!plan.has(ref) && !data.ledgers.some((l) => l.name === ref)) {
        plan.set(ref, inferLedgerGroup(ref, v.voucher_type));
      }
    }
  }
  return [...plan].map(([name, group]) => ({ name, group }));
}

async function existingNames(companyId) {
  const d = await getDrizzle();
  const groups = (await d.select({ name: T.tally_groups.name }).from(T.tally_groups).where(eq(T.tally_groups.company_id, companyId))).map((r) => r.name);
  const ledgers = (await d.select({ name: T.tally_ledgers.name }).from(T.tally_ledgers).where(eq(T.tally_ledgers.company_id, companyId))).map((r) => r.name);
  return { groups: new Set(groups), ledgers: new Set(ledgers) };
}

// Validate references against the import set AND already-imported masters so
// partial re-exports don't fail. Returns { errors, warnings }.
async function validateExport(companyId, data) {
  const existing = await existingNames(companyId);
  const auto = planAutoLedgers(data);
  const groupNames = new Set([...data.groups.map((g) => g.name), ...AUTO_GROUPS, ...existing.groups]);
  const ledgerNames = new Set([...data.ledgers.map((l) => l.name), ...auto.map((a) => a.name), ...existing.ledgers]);
  const errors = [];
  const warnings = [];

  if (data.vouchers.length && !data.ledgers.length && !data.groups.length) {
    warnings.push({
      level: 'warning', type: 'export', record: null,
      message: 'Voucher-only export detected - missing ledgers will be auto-created under standard Tally groups; verify the group mapping after import',
    });
  }
  for (const a of auto) {
    warnings.push({
      level: 'warning', type: 'auto-ledger', record: a.name,
      message: `Ledger "${a.name}" is not in the masters - auto-created under group "${a.group}" (verify mapping)`,
    });
  }

  for (const g of data.groups) {
    if (g.parent && !groupNames.has(g.parent)) {
      errors.push({ level: 'error', type: 'group', record: g.name, message: `Group "${g.name}" references missing parent "${g.parent}"` });
    }
  }
  for (const l of data.ledgers) {
    if (!l.group_name) {
      warnings.push({ level: 'warning', type: 'ledger', record: l.name, message: 'Ledger has no PARENT group — Tally requires ledgers under a group' });
    }
    if (l.group_name && !groupNames.has(l.group_name)) {
      errors.push({ level: 'error', type: 'ledger', record: l.name, message: `Ledger "${l.name}" references missing group "${l.group_name}"` });
    }
    if (!Number.isFinite(l.opening_balance)) {
      errors.push({ level: 'error', type: 'ledger', record: l.name, message: 'Opening balance is not a number' });
    }
    if (l.gstin && !GSTIN_RE.test(l.gstin)) {
      warnings.push({ level: 'warning', type: 'ledger', record: l.name, message: `GSTIN "${l.gstin}" does not look like a valid GSTIN` });
    }
  }
  for (const v of data.vouchers) {
    const ref = v.voucher_number || '(unnamed voucher)';
    if (!v.voucher_number) errors.push({ level: 'error', type: 'voucher', record: ref, message: 'Voucher without a number' });
    if (!v.date) errors.push({ level: 'error', type: 'voucher', record: ref, message: 'Voucher date missing or malformed' });
    if (!Number.isFinite(v.amount)) errors.push({ level: 'error', type: 'voucher', record: ref, message: 'Voucher amount is not a number' });
    if (v.entries && v.entries.length) {
      const bal = Tally.voucherBalance(v);
      if (!bal.balanced) {
        errors.push({
          level: 'error', type: 'voucher', record: ref,
          message: `Voucher ${ref} unbalanced: debit ${formatINR(bal.debit)} / credit ${formatINR(bal.credit)}`,
        });
      }
    }
    if (v.party_name && !ledgerNames.has(v.party_name)) {
      errors.push({
        level: 'error', type: 'voucher', record: ref,
        message: `Voucher party "${v.party_name}" is not an imported/known ledger - export Tally Masters (Groups + Ledgers) as XML and upload before vouchers`,
      });
    }
    for (const e of v.entries) {
      if (e.ledger && !ledgerNames.has(e.ledger)) {
        errors.push({ level: 'error', type: 'voucher', record: ref, message: `Voucher entry references ledger "${e.ledger}" that is not imported/known` });
      }
    }
  }
  return { errors, warnings };
}

// Upsert one record type by Tally GUID + ALTERID, falling back to the
// name / number+date key for exports without GUIDs. Returns nothing; mutates
// the summary counters. opts: { table, idPrefix, keyOf, fields }. `db` is the
// enclosing import transaction so all three passes commit atomically.
async function upsertRecords(db, type, incomingRows, rows, companyId, summary, opts) {
  const { table, idPrefix, keyOf, fields } = opts;
  const byGuid = new Map();
  const byName = new Map();
  for (const r of rows) {
    if (r.tally_guid) byGuid.set(r.tally_guid, r);
    byName.set(keyOf(r), r);
  }
  const seen = new Set();
  for (const inc of incomingRows) {
    const alter = Number(inc.tally_alterid) || 0;
    // GUID identity first: a voucher/ledger/group with a known GUID is matched
    // by GUID alone and never routed through the fallback key, so two records
    // sharing the same fallback key (e.g. Payment "001" and Receipt "001" on
    // the same date) can never skip each other when both carry distinct GUIDs.
    const guidRow = inc.tally_guid ? byGuid.get(inc.tally_guid) : null;
    if (guidRow) {
      if (alter > (Number(guidRow.tally_alterid) || 0)) {
        await db.update(table).set({ ...fields(inc), tally_guid: inc.tally_guid || null, tally_alterid: alter }).where(eq(table.id, guidRow.id));
        byGuid.set(inc.tally_guid, { id: guidRow.id, tally_alterid: alter });
        byName.set(keyOf(inc), { id: guidRow.id, tally_alterid: alter });
        summary[type].updated++;
      } else {
        summary[type].skipped++;
      }
      continue;
    }
    // Fallback identity: only GUID-less records (or GUIDs not seen before) use
    // the composite key; the `seen` set dedupes genuine duplicates in one
    // import batch and is checked strictly after the GUID attempt above.
    const key = keyOf(inc);
    if (seen.has(key)) { summary[type].skipped++; continue; }
    seen.add(key);
    const row = byName.get(key);
    if (!row) {
      const id = uid(idPrefix);
      await db.insert(table).values({ id, company_id: companyId, ...fields(inc), tally_guid: inc.tally_guid || null, tally_alterid: alter });
      if (inc.tally_guid) byGuid.set(inc.tally_guid, { id, tally_alterid: alter });
      byName.set(key, { id, tally_alterid: alter });
      summary[type].imported++;
    } else if (alter > (Number(row.tally_alterid) || 0)) {
      await db.update(table).set({ ...fields(inc), tally_guid: inc.tally_guid || null, tally_alterid: alter }).where(eq(table.id, row.id));
      if (inc.tally_guid) byGuid.set(inc.tally_guid, { id: row.id, tally_alterid: alter });
      byName.set(key, { id: row.id, tally_alterid: alter });
      summary[type].updated++;
    } else {
      summary[type].skipped++;
    }
  }
}

// Sequenced import: Groups -> Ledgers -> Vouchers, upserted by GUID/ALTERID.
// Records rejected by validation (e.g. unbalanced vouchers) are skipped and
// counted, never partially written.
// The whole import is ONE transaction: a failure at any pass (e.g. a duplicate
// tally_guid violating a unique index) rolls back every group/ledger/voucher
// written so far — no half-imported export with dangling ledger references.
async function importExport(companyId, data, rejectedVouchers = new Set()) {
  return withTransaction(async (tx) => {
    const auto = planAutoLedgers(data);
    const allGroups = [...data.groups];
    for (const a of auto) {
      if (!allGroups.some((g) => g.name === a.group)) allGroups.push({ name: a.group, parent: null });
    }
    const summary = {
      groups: { total: allGroups.length, imported: 0, updated: 0, skipped: 0 },
      ledgers: { total: data.ledgers.length + auto.length, imported: 0, updated: 0, skipped: 0 },
      vouchers: { total: data.vouchers.length, imported: 0, updated: 0, skipped: 0 },
    };

    const existingGroupRows = await tx.select({ id: T.tally_groups.id, name: T.tally_groups.name, tally_guid: T.tally_groups.tally_guid, tally_alterid: T.tally_groups.tally_alterid }).from(T.tally_groups).where(eq(T.tally_groups.company_id, companyId));
    const existingLedgerRows = await tx.select({ id: T.tally_ledgers.id, name: T.tally_ledgers.name, tally_guid: T.tally_ledgers.tally_guid, tally_alterid: T.tally_ledgers.tally_alterid }).from(T.tally_ledgers).where(eq(T.tally_ledgers.company_id, companyId));
    const existingVoucherRows = await tx.select({ id: T.tally_vouchers.id, voucher_number: T.tally_vouchers.voucher_number, date: T.tally_vouchers.date, voucher_type: T.tally_vouchers.voucher_type, tally_guid: T.tally_vouchers.tally_guid, tally_alterid: T.tally_vouchers.tally_alterid }).from(T.tally_vouchers).where(eq(T.tally_vouchers.company_id, companyId));

    await upsertRecords(tx, 'groups', allGroups, existingGroupRows, companyId, summary, {
      table: T.tally_groups, idPrefix: 'tg', keyOf: (g) => g.name,
      fields: (g) => ({ name: g.name, parent: g.parent || null }),
    });

    const knownGroups = new Set([...existingGroupRows.map((r) => r.name), ...allGroups.map((g) => g.name)]);
    const dataLedgers = [];
    for (const l of data.ledgers) {
      if (l.group_name && !knownGroups.has(l.group_name)) { summary.ledgers.skipped++; continue; }
      dataLedgers.push(l);
    }
    const ledgerRows = [...dataLedgers, ...auto.map((a) => ({ name: a.name, group_name: a.group, opening_balance: 0, gstin: null }))];
    await upsertRecords(tx, 'ledgers', ledgerRows, existingLedgerRows, companyId, summary, {
      table: T.tally_ledgers, idPrefix: 'tl', keyOf: (l) => l.name,
      fields: (l) => ({
        name: l.name, group_name: l.group_name || null,
        opening_balance: Number.isFinite(l.opening_balance) ? l.opening_balance : 0,
        gstin: l.gstin || null,
      }),
    });

    const knownLedgers = new Set([...existingLedgerRows.map((r) => r.name), ...ledgerRows.map((l) => l.name)]);
    const voucherRows = [];
    for (const v of data.vouchers) {
      if (rejectedVouchers.has(v.voucher_number) || !v.voucher_number || !v.date || !Number.isFinite(v.amount) || (v.party_name && !knownLedgers.has(v.party_name))) {
        summary.vouchers.skipped++;
        continue;
      }
      voucherRows.push(v);
    }
    await upsertRecords(tx, 'vouchers', voucherRows, existingVoucherRows, companyId, summary, {
      table: T.tally_vouchers, idPrefix: 'tv',
      // Fallback identity includes voucher_type so a Payment "001" and Receipt
      // "001" on the same date (common with manual/loose numbering) never
      // collide on number|date alone.
      keyOf: (v) => `${v.voucher_number}|${v.date}|${v.voucher_type}`,
      fields: (v) => ({
        voucher_number: v.voucher_number,
        voucher_type: v.voucher_type,
        date: v.date,
        amount: v.amount,
        party_name: v.party_name,
        entry_json: JSON.stringify(v.entries),
        cancelled: v.cancelled ? 1 : 0,
        imported_at: nowIso(),
      }),
    });
    return summary;
  });
}

async function handleImport(companyId, xml) {
  const data = Tally.parseExport(xml);
  if (!data.groups.length && !data.ledgers.length && !data.vouchers.length) {
    throw new Error('No supported Tally records found in the XML (expected <GROUP>, <LEDGER> or <VOUCHER> elements)');
  }
  const validation = await validateExport(companyId, data);
  const rejectedVouchers = new Set(validation.errors.filter((e) => e.type === 'voucher' && e.record).map((e) => e.record));
  const imported = await importExport(companyId, data, rejectedVouchers);
  return {
    company: data.company || null,
    parsed: {
      groups: data.groups.length,
      ledgers: data.ledgers.length,
      vouchers: data.vouchers.length,
    },
    validation,
    imported,
  };
}

module.exports = { handleImport, validateExport, importExport };
