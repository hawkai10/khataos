'use strict';

require('./env').loadEnv(); // load .env before any config is read

const { seedIfEmpty } = require('./seed');

const PORT = parseInt(process.env.PORT || '8080', 10);
const { buildApp } = require('./http/app');

(async () => {
  await seedIfEmpty();
  if (process.env.KHATAOS_TEST_TENANT === '1') {
    const { bootstrapTestTenant } = require('./test-hooks');
    await bootstrapTestTenant();
  }
  const app = await buildApp();
  // In-process job queue: after a restart every queued/running job is orphaned
  // (its timer died with the process). Mark them failed so payments with a
  // lost dispatch can be re-dispatched instead of being treated as in-flight.
  const { queue } = require('./adapters');
  await queue.resetOrphaned();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`KhataOS MVP running: http://localhost:${PORT}`);
  console.log('Reference data seeded. No demo tenant is created — data only arrives through the real channels (Tally XML, bank statements, GSTR-2B, forwarded invoices).');
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
