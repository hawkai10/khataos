'use strict';

// Aggregator: runs every test file (SQLite), then the pglite variants, then —
// when --pg-live is passed or PG_LIVE_URL is set — the real-PostgreSQL
// variants. Exits non-zero on the first failed step. This is what CI runs.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SKIP = new Set(['pg-live.test.js']);
const steps = [];

for (const f of fs.readdirSync(ROOT).filter((f) => f.endsWith('.test.js')).sort()) {
  if (!SKIP.has(f)) steps.push([f, []]);
}
steps.push(['tally-import.test.js', ['--pg']]);
steps.push(['recon-three-way.test.js', ['--pg']]);
steps.push(['smoke.js', ['--pg']]);

const failed = [];
for (const [file, args] of steps) {
  const label = `tests/${file} ${args.join(' ')}`.trim();
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) {
    failed.push(label);
    console.error(r.stdout);
    console.error(r.stderr);
  }
}

if (process.argv.includes('--pg-live') || process.env.PG_LIVE_URL) {
  const args = process.argv.includes('--pg-live') ? ['--start-embedded'] : [];
  const label = `tests/pg-live.test.js ${args.join(' ')}`.trim();
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, ['pg-live.test.js', ...args], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 900000 });
  if (r.status !== 0) {
    failed.push(label);
    console.error(r.stdout);
    console.error(r.stderr);
  }
}

if (failed.length) {
  console.error(`\nFAILED steps: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nAll test steps passed.');
