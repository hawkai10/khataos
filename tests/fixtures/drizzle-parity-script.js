// Shared cross-engine parity script: insert + select the same data through
// Drizzle and print the result as JSON. The engine is chosen from env
// (sqlite / pglite / postgres) so the same script runs on every engine.
//
// Every row is namespaced by PARITY_NS (a per-run value supplied by the test
// runner). The same namespace is used for both sides of a comparison, so the
// output stays byte-identical, while distinct runs against a shared/live
// database never collide on primary keys or unique indexes.
const path = require('path');
const os = require('os');
const fs = require('fs');
const dbFile = path.join(os.tmpdir(), 'khataos-data', 'drizzle-parity-' + process.pid + '.db');
process.env.KHATAOS_DB = dbFile;
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
const db = require('./src/db');
const schema = require('./src/db/schema');
const { eq } = require('drizzle-orm');
(async () => {
  const T = ['pglite', 'postgres'].includes(process.env.KHATAOS_DB_ENGINE) ? schema.pg : schema.sqlite;
  const ns = process.env.PARITY_NS || 'c1';
  const co = 'c1-' + ns;
  const g = 'g1-' + ns;
  const l = 'l1-' + ns;
  const v = 'v1-' + ns;
  const g2b = 'g2b1-' + ns;
  const d = await db.getDrizzle();
  // Idempotent within a namespace: clear rows left by an earlier aborted run
  // with the same PARITY_NS before inserting fresh ones.
  for (const t of [T.gstr2b_snapshots, T.tally_vouchers, T.tally_ledgers, T.tally_groups]) {
    await d.delete(t).where(eq(t.company_id, co));
  }
  await d.insert(T.tally_groups).values({ id: g, company_id: co, name: 'Sundry Creditors', parent: 'Current Liabilities', tally_guid: 'guid-g1-' + ns, tally_alterid: 1 });
  await d.insert(T.tally_ledgers).values({ id: l, company_id: co, name: 'Vendor A', group_name: 'Sundry Creditors', opening_balance: 9204050, gstin: '29AABCA1111K1Z5', tally_guid: 'guid-l1-' + ns, tally_alterid: 3 });
  await d.insert(T.tally_vouchers).values({ id: v, company_id: co, voucher_number: 'PU-1', voucher_type: 'Purchase', date: '2026-07-30', amount: 11800000, party_name: 'Vendor A', entry_json: '[]', tally_guid: 'guid-v1-' + ns, tally_alterid: 7, cancelled: 1, imported_at: '2026-08-03T00:00:00.000Z' });
  await d.insert(T.gstr2b_snapshots).values({ id: g2b, company_id: co, period: '2026-07', gstin: '29AABCA1111K1Z5', total_itc: 1800000, itc_cgst: 900000, itc_sgst: 900000, itc_igst: 0, data_json: '[]', cdnr_json: '[{"docno":"CN-1"}]', source: 'gstn-live', fetched_at: '2026-08-03T00:00:00.000Z' });
  const out = {
    // Scope to this run's company so the check is valid even when other
    // suites have already written rows to the same (live) database.
    groups: await d.select().from(T.tally_groups).where(eq(T.tally_groups.company_id, co)),
    vouchers: await d.select({ no: T.tally_vouchers.voucher_number, guid: T.tally_vouchers.tally_guid, alt: T.tally_vouchers.tally_alterid, cancelled: T.tally_vouchers.cancelled, amount: T.tally_vouchers.amount }).from(T.tally_vouchers).where(eq(T.tally_vouchers.company_id, co)),
    snap: await d.select({ cdnr: T.gstr2b_snapshots.cdnr_json }).from(T.gstr2b_snapshots).where(eq(T.gstr2b_snapshots.company_id, co)),
  };
  console.log(JSON.stringify({ vouchers: out.vouchers, snap: out.snap, groups: out.groups }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
