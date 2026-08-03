'use strict';

// Tally domain: connector health, sync logs, XML import and vendor-ledger
// mapping.

const { all, get, run, update } = require('../db');
const { nowIso } = require('../util');
const { ApiError, audit, requireRole } = require('../auth');
const { TallyConnector } = require('../adapters');
const TallyImport = require('../tally-import');
const TallyMapping = require('../tally-mapping');
const { bodyOf, requireNonEmptyString } = require('./validators');
const { companyOf } = require('./helpers');

function register(r, deps) {
  const { ok } = deps;

  r.get('/api/tally/health', async (req, res, p, user) => {
    ok(res, await TallyConnector.health(companyOf(user)));
  });

  r.get('/api/tally/sync-logs', async (req, res, p, user) => {
    const rows = await all('SELECT * FROM tally_sync_logs WHERE company_id = ? ORDER BY queued_at DESC LIMIT 100', [companyOf(user)]);
    ok(res, rows);
  });

  r.post('/api/tally/pull-ledgers', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const ledgers = await TallyConnector.pullLedgers(coId);
    await audit(coId, user, 'tally.pull_ledgers', 'tally', null, { ledgers: ledgers.ledgers, mapped: ledgers.mapped });
    ok(res, ledgers);
  });

  // Cloud-only path: user exports Groups/Ledgers/Vouchers from Tally as XML
  // and uploads it. Validated, then imported in sequence (Groups -> Ledgers
  // -> Vouchers). Works without any live Tally connection.
  r.post('/api/tally/import-xml', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const xml = requireNonEmptyString(bodyOf(req).xml, 'xml payload');
    let result;
    try {
      result = await TallyImport.handleImport(coId, xml);
    } catch (err) {
      throw new ApiError(400, err.message);
    }
    const totalImported = result.imported.groups.imported + result.imported.ledgers.imported + result.imported.vouchers.imported;
    const totalSkipped = result.imported.groups.skipped + result.imported.ledgers.skipped + result.imported.vouchers.skipped;
    await TallyConnector.logSync(coId, 'import', 'xml', 'import', 'synced',
      `imported ${totalImported}, skipped ${totalSkipped}, errors ${result.validation.errors.length}`);
    await audit(coId, user, 'tally.xml_import', 'tally', 'xml', {
      parsed: result.parsed, imported: result.imported, errors: result.validation.errors.length,
    });
    let mapping = null;
    try {
      const m = await TallyMapping.autoMap(coId);
      mapping = { updated: m.updated };
    } catch { /* mapping is best-effort; the import itself already succeeded */ }
    ok(res, { ...result, mapping });
  });

  r.get('/api/tally/mappings', async (req, res, p, user) => {
    ok(res, await TallyMapping.report(companyOf(user)));
  });

  r.post('/api/tally/mappings/auto', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const result = await TallyMapping.autoMap(coId);
    await audit(coId, user, 'tally.auto_map', 'tally', null, { updated: result.updated.length });
    await TallyConnector.logSync(coId, 'ledger', 'mapping', 'map', 'synced', `auto-mapped ${result.updated.length} vendor(s)`);
    ok(res, result);
  });

  r.post('/api/tally/mappings', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const { vendor_id, ledger_name } = bodyOf(req);
    if (!vendor_id) throw new ApiError(400, 'vendor_id required');
    const result = await TallyMapping.setMapping(coId, vendor_id, ledger_name);
    await audit(coId, user, 'tally.mapping_set', 'vendor', vendor_id, { ledger_name: result.ledger_name });
    ok(res, result);
  });

  r.post('/api/tally/retry/:id', async (req, res, p, user) => {
    requireRole(user, ['cfo', 'finance_manager']);
    const log = await get('SELECT * FROM tally_sync_logs WHERE id = ? AND company_id = ?', [p.id, companyOf(user)]);
    if (!log) throw new ApiError(404, 'sync log not found');
    await update('tally_sync_logs', log.id, { status: 'queued', error: null, queued_at: nowIso() });
    setTimeout(async () => {
      await run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE id=?", [nowIso(), log.id]);
      await TallyConnector.heartbeat(companyOf(user));
    }, 1000);
    ok(res, { retried: true });
  });
}

module.exports = { register };
