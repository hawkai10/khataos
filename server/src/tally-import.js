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

const { all, insert, update } = require('./db');
const { uid, nowIso } = require('./util');
const Tally = require('./tally');

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][0-9A-Z]{3}$/;

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
  const groups = (await all('SELECT name FROM tally_groups WHERE company_id = ?', [companyId])).map((r) => r.name);
  const ledgers = (await all('SELECT name FROM tally_ledgers WHERE company_id = ?', [companyId])).map((r) => r.name);
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
          message: `Voucher ${ref} unbalanced: debit \u20B9${bal.debit.toLocaleString('en-IN')} / credit \u20B9${bal.credit.toLocaleString('en-IN')}`,
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
// the summary counters. opts: { table, idPrefix, keyOf, fields }.
async function upsertRecords(type, incomingRows, rows, companyId, summary, opts) {
  const { table, idPrefix, keyOf, fields } = opts;
  const byGuid = new Map();
  const byName = new Map();
  for (const r of rows) {
    if (r.tally_guid) byGuid.set(r.tally_guid, r);
    byName.set(keyOf(r), r);
  }
  const seen = new Set();
  for (const inc of incomingRows) {
    const key = keyOf(inc);
    if (seen.has(key)) { summary[type].skipped++; continue; }
    seen.add(key);
    const row = (inc.tally_guid && byGuid.get(inc.tally_guid)) || byName.get(key);
    const alter = Number(inc.tally_alterid) || 0;
    if (!row) {
      const id = uid(idPrefix);
      await insert(table, { id, company_id: companyId, ...fields(inc), tally_guid: inc.tally_guid || null, tally_alterid: alter });
      byGuid.set(inc.tally_guid, { id, tally_alterid: alter });
      byName.set(key, { id, tally_alterid: alter });
      summary[type].imported++;
    } else if (alter > (Number(row.tally_alterid) || 0)) {
      await update(table, row.id, { ...fields(inc), tally_guid: inc.tally_guid || null, tally_alterid: alter });
      byGuid.set(inc.tally_guid, { id: row.id, tally_alterid: alter });
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
async function importExport(companyId, data, rejectedVouchers = new Set()) {
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

  const existingGroupRows = await all('SELECT id, name, tally_guid, tally_alterid FROM tally_groups WHERE company_id = ?', [companyId]);
  const existingLedgerRows = await all('SELECT id, name, tally_guid, tally_alterid FROM tally_ledgers WHERE company_id = ?', [companyId]);
  const existingVoucherRows = await all('SELECT id, voucher_number, date, tally_guid, tally_alterid FROM tally_vouchers WHERE company_id = ?', [companyId]);

  await upsertRecords('groups', allGroups, existingGroupRows, companyId, summary, {
    table: 'tally_groups', idPrefix: 'tg', keyOf: (g) => g.name,
    fields: (g) => ({ name: g.name, parent: g.parent || null }),
  });

  const knownGroups = new Set([...existingGroupRows.map((r) => r.name), ...allGroups.map((g) => g.name)]);
  const dataLedgers = [];
  for (const l of data.ledgers) {
    if (l.group_name && !knownGroups.has(l.group_name)) { summary.ledgers.skipped++; continue; }
    dataLedgers.push(l);
  }
  const ledgerRows = [...dataLedgers, ...auto.map((a) => ({ name: a.name, group_name: a.group, opening_balance: 0, gstin: null }))];
  await upsertRecords('ledgers', ledgerRows, existingLedgerRows, companyId, summary, {
    table: 'tally_ledgers', idPrefix: 'tl', keyOf: (l) => l.name,
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
  await upsertRecords('vouchers', voucherRows, existingVoucherRows, companyId, summary, {
    table: 'tally_vouchers', idPrefix: 'tv', keyOf: (v) => `${v.voucher_number}|${v.date}`,
    fields: (v) => ({
      voucher_number: v.voucher_number,
      voucher_type: v.voucher_type,
      date: v.date,
      amount: v.amount,
      party_name: v.party_name,
      entry_json: JSON.stringify(v.entries),
      imported_at: nowIso(),
    }),
  });
  return summary;
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
