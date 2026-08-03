// Shared cross-engine parity script: insert + select the same data through
// Drizzle and print the result as JSON. The engine is chosen from env
// (sqlite / pglite / postgres) so the same script runs on every engine.
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
  const d = await db.getDrizzle();
  await d.insert(T.tally_groups).values({ id: 'g1', company_id: 'c1', name: 'Sundry Creditors', parent: 'Current Liabilities', tally_guid: 'guid-g1', tally_alterid: 1 });
  await d.insert(T.tally_ledgers).values({ id: 'l1', company_id: 'c1', name: 'Vendor A', group_name: 'Sundry Creditors', opening_balance: 92040.5, gstin: '29AABCA1111K1Z5', tally_guid: 'guid-l1', tally_alterid: 3 });
  await d.insert(T.tally_vouchers).values({ id: 'v1', company_id: 'c1', voucher_number: 'PU-1', voucher_type: 'Purchase', date: '2026-07-30', amount: 118000, party_name: 'Vendor A', entry_json: '[]', tally_guid: 'guid-v1', tally_alterid: 7, cancelled: 1, imported_at: '2026-08-03T00:00:00.000Z' });
  await d.insert(T.gstr2b_snapshots).values({ id: 'g2b1', company_id: 'c1', period: '2026-07', gstin: '29AABCA1111K1Z5', total_itc: 18000, itc_cgst: 9000, itc_sgst: 9000, itc_igst: 0, data_json: '[]', cdnr_json: '[{"docno":"CN-1"}]', source: 'gstn-live', fetched_at: '2026-08-03T00:00:00.000Z' });
  const out = {
    // Scope to company c1 so the check is valid even when other suites have
    // already written rows to the same (live) database.
    groups: await d.select().from(T.tally_groups).where(eq(T.tally_groups.company_id, 'c1')),
    vouchers: await d.select({ no: T.tally_vouchers.voucher_number, guid: T.tally_vouchers.tally_guid, alt: T.tally_vouchers.tally_alterid, cancelled: T.tally_vouchers.cancelled, amount: T.tally_vouchers.amount }).from(T.tally_vouchers).where(eq(T.tally_vouchers.company_id, 'c1')),
    snap: await d.select({ cdnr: T.gstr2b_snapshots.cdnr_json }).from(T.gstr2b_snapshots).where(eq(T.gstr2b_snapshots.company_id, 'c1')),
  };
  console.log(JSON.stringify({ vouchers: out.vouchers, snap: out.snap, groups: out.groups }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
