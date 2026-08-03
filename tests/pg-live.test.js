'use strict';

// Real-PostgreSQL verification for the Drizzle-converted module.
//
// Without Docker on dev machines we boot a genuine PostgreSQL server from the
// embedded-postgres devDependency (real postgres binaries, not pglite) via
// `node tests/pg-live.test.js --start-embedded`. CI uses a Postgres service
// container instead and passes PG_LIVE_URL. Either way, the converted Tally
// import pipeline (plus the three-way reconciliation, the schema-parity
// cross-engine check, and the E2E smoke suite) runs against a real server.

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const EMBEDDED_PORT = 55432;

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' - ' + e.message); }
}

function runTest(file, args, env) {
  const r = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`${file} ${args.join(' ')} exited ${r.status}`);
  }
}

(async () => {
  let pg = null;
  let url = process.env.PG_LIVE_URL;
  if (process.argv.includes('--start-embedded')) {
    // embedded-postgres lives in server/node_modules (ESM); import by file URL.
    const { pathToFileURL } = require('url');
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(ROOT, 'server', 'node_modules', 'embedded-postgres', 'dist', 'index.js')).href);
    const dir = path.join(os.tmpdir(), 'khataos-data', 'khataos-embedded-pg');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    pg = new EmbeddedPostgres({
      databaseDir: dir, user: 'khataos', password: 'khataos', port: EMBEDDED_PORT, persistent: false,
      // The Windows default locale initializes the cluster as WIN1252, which
      // cannot store UTF-8 characters (e.g. ₹); force a UTF-8 cluster.
      initdbFlags: ['-E', 'UTF8'],
    });
    await pg.initialise();
    await pg.start();
    url = `postgresql://khataos:khataos@127.0.0.1:${EMBEDDED_PORT}/postgres`;
    console.log(`embedded real PostgreSQL started on port ${EMBEDDED_PORT}`);
  }
  if (!url) {
    console.error('PG_LIVE_URL not set — pass --start-embedded to boot an embedded real PostgreSQL, or set PG_LIVE_URL (CI service container).');
    process.exit(2);
  }
  const pgEnv = { KHATAOS_DB_ENGINE: 'postgres', KHATAOS_DATABASE_URL: url };

  try {
    await check('tally-import pipeline on real PostgreSQL', () => runTest(path.join('tests', 'tally-import.test.js'), [], pgEnv));
    await check('three-way reconciliation on real PostgreSQL', () => runTest(path.join('tests', 'recon-three-way.test.js'), [], pgEnv));
    await check('drizzle schema parity: SQLite vs real PostgreSQL', () => runTest(path.join('tests', 'drizzle-schema.test.js'), [], { ...pgEnv, PG_LIVE_URL: url }));
    await check('E2E smoke suite on real PostgreSQL', () => runTest(path.join('tests', 'smoke.js'), [], pgEnv));
  } finally {
    if (pg) {
      try { await pg.stop(); } catch { /* already stopped */ }
      try { await pg.cleanup(); } catch { /* best effort */ }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
