'use strict';

// Minimal .env loader — no dependency. Reads KEY=VALUE lines from the repo
// root and server/ .env files into process.env without overriding variables
// that are already set (shell env wins). Called before any other module loads
// so adapter config picks up DEEPSEEK_* / GSTN_* / DECENTRO_* / KHATAOS_*.

const fs = require('fs');
const path = require('path');

function parseLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const eq = t.indexOf('=');
  if (eq <= 0) return null;
  const key = t.slice(0, eq).trim();
  let value = t.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  const comment = value.search(/\s+#/);
  if (comment > 0) value = value.slice(0, comment).trim();
  return [key, value];
}

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const kv = parseLine(line);
    if (kv && !(kv[0] in process.env)) process.env[kv[0]] = kv[1];
  }
}

function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '..', '.env'), // repo root
    path.join(__dirname, '..', '.env'), // server/
  ];
  for (const file of candidates) loadEnvFile(file);
}

module.exports = { loadEnv, loadEnvFile };
