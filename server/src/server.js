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
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`KhataOS MVP running: http://localhost:${PORT}`);
  console.log('Reference data seeded. No demo tenant is created — data only arrives through the real channels (Tally XML, bank statements, GSTR-2B, forwarded invoices).');
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
