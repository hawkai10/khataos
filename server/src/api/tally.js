'use strict';

// Tally domain (Fastify plugin): connector health, sync logs, XML import and
// vendor-ledger mapping.

const { all, get, run, update } = require('../db');
const { nowIso } = require('../util');
const { ApiError, audit, requireRole } = require('../auth');
const { TallyConnector } = require('../adapters');
const TallyImport = require('../tally-import');
const TallyMapping = require('../tally-mapping');
const { bodyOf, requireNonEmptyString } = require('./validators');
const { companyOf } = require('./helpers');

async function register(fastify) {
  fastify.get('/api/tally/health', async (request, reply) => {
    reply.ok(await TallyConnector.health(companyOf(request.user)));
  });

  fastify.get('/api/tally/sync-logs', async (request, reply) => {
    const rows = await all('SELECT * FROM tally_sync_logs WHERE company_id = ? ORDER BY queued_at DESC LIMIT 100', [companyOf(request.user)]);
    reply.ok(rows);
  });

  fastify.post('/api/tally/pull-ledgers', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const ledgers = await TallyConnector.pullLedgers(coId);
    await audit(coId, user, 'tally.pull_ledgers', 'tally', null, { ledgers: ledgers.ledgers, mapped: ledgers.mapped });
    reply.ok(ledgers);
  });

  // Cloud-only path: user exports Groups/Ledgers/Vouchers from Tally as XML
  // and uploads it. Validated, then imported in sequence (Groups -> Ledgers
  // -> Vouchers). Works without any live Tally connection.
  fastify.post('/api/tally/import-xml', {
    schema: {
      body: {
        type: 'object',
        required: ['xml'],
        properties: { xml: { type: 'string', minLength: 1 } },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const xml = requireNonEmptyString(bodyOf(request).xml, 'xml payload');
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
    reply.ok({ ...result, mapping });
  });

  fastify.get('/api/tally/mappings', async (request, reply) => {
    reply.ok(await TallyMapping.report(companyOf(request.user)));
  });

  fastify.post('/api/tally/mappings/auto', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const result = await TallyMapping.autoMap(coId);
    await audit(coId, user, 'tally.auto_map', 'tally', null, { updated: result.updated.length });
    await TallyConnector.logSync(coId, 'ledger', 'mapping', 'map', 'synced', `auto-mapped ${result.updated.length} vendor(s)`);
    reply.ok(result);
  });

  fastify.post('/api/tally/mappings', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const coId = companyOf(user);
    const { vendor_id, ledger_name } = bodyOf(request);
    if (!vendor_id) throw new ApiError(400, 'vendor_id required');
    const result = await TallyMapping.setMapping(coId, vendor_id, ledger_name);
    await audit(coId, user, 'tally.mapping_set', 'vendor', vendor_id, { ledger_name: result.ledger_name });
    reply.ok(result);
  });

  fastify.post('/api/tally/retry/:id', async (request, reply) => {
    const user = request.user;
    requireRole(user, ['cfo', 'finance_manager']);
    const log = await get('SELECT * FROM tally_sync_logs WHERE id = ? AND company_id = ?', [request.params.id, companyOf(user)]);
    if (!log) throw new ApiError(404, 'sync log not found');
    await update('tally_sync_logs', log.id, { status: 'queued', error: null, queued_at: nowIso() });
    setTimeout(async () => {
      await run("UPDATE tally_sync_logs SET status='synced', synced_at=? WHERE id=?", [nowIso(), log.id]);
      await TallyConnector.heartbeat(companyOf(user));
    }, 1000);
    reply.ok({ retried: true });
  });
}

module.exports = { register };
