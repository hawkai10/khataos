'use strict';

// Unit tests for the KhataOS Copilot: provider config (DeepSeek V4 Flash),
// the deterministic output rail (JSON parsing + view allowlist) that keeps
// the LLM from deviating, and the offline rule-engine fallback contract.

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), 'khataos-data', 'ai-unit-' + process.pid + '.db');
process.env.KHATAOS_DB = TEST_DB;
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const Assistant = require('../server/src/ai');
const { parseLlm, VIEWS, AI_ENABLED, DEEPSEEK_MODEL, DEEPSEEK_URL } = Assistant._internals;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' \u2014 ' + e.message); }
}

check('config: DeepSeek V4 Flash is the default model + URL', () => {
  assert.strictEqual(DEEPSEEK_MODEL, 'deepseek-v4-flash');
  assert.strictEqual(DEEPSEEK_URL, 'https://api.deepseek.com');
});

check('config: disabled without an API key (deterministic engine)', () => {
  assert.strictEqual(AI_ENABLED, false);
  const s = Assistant.intent_status();
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.provider, 'deterministic-engine');
  assert.ok(Array.isArray(s.guardrails) && s.guardrails.length >= 5);
});

check('prompts: catalogue exposed', () => {
  assert.ok(Array.isArray(Assistant.PROMPTS) && Assistant.PROMPTS.length >= 4);
});

check('output rail: parses plain JSON object', () => {
  const out = parseLlm('{"intent":"cash","answer":"You have ₹22.05 Cr.","actions":[{"label":"View cash","view":"cash"}]}');
  assert.strictEqual(out.intent, 'cash');
  assert.ok(out.answer.includes('₹'));
  assert.strictEqual(out.actions.length, 1);
});

check('output rail: parses fenced JSON', () => {
  const out = parseLlm('```json\n{"intent":"gst","answer":"ITC ₹1.02 Cr.","actions":[]}\n```');
  assert.strictEqual(out.intent, 'gst');
  assert.strictEqual(out.actions.length, 0);
});

check('output rail: refuses garbage without throwing', () => {
  assert.strictEqual(parseLlm('sorry, I cannot answer that'), null);
  assert.strictEqual(parseLlm('{"answer": 42}'), null);
  assert.strictEqual(parseLlm(''), null);
});

check('output rail: drops actions outside the view allowlist', () => {
  const out = parseLlm('{"intent":"general","answer":"ok","actions":[{"label":"Go","view":"payables"},{"label":"Hack","view":"admin"},{"label":"Chat","view":"settings"},{"label":"X","view":"payments"},{"label":"Y","view":"system"}]}');
  assert.deepStrictEqual(out.actions.map((a) => a.view), ['payables', 'settings', 'payments']);
});

check('output rail: caps actions to 3 and unknown intent -> general', () => {
  const out = parseLlm('{"intent":"random","answer":"hi","actions":[{"label":"1","view":"cash"},{"label":"2","view":"gst"},{"label":"3","view":"recon"},{"label":"4","view":"tally"}]}');
  assert.strictEqual(out.intent, 'general');
  assert.strictEqual(out.actions.length, 3);
});

(async () => {
  await check('fallback: rule engine answers cash question offline', async () => {
    const user = { company_id: 'nobody', role: 'cfo' };
    const r = await Assistant.ask(user, 'How much cash do we have?');
    assert.strictEqual(r.intent, 'cash');
    assert.ok(r.answer.includes('₹'));
    assert.strictEqual(r.generative, false);
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
