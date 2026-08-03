'use strict';

// ---- deterministic PRNG (mulberry32) so demo data is stable per seed ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- dates ----
function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) { return todayStr(-n); }
function daysAhead(n) { return todayStr(n); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db - da) / 86400000);
}

// Minutes elapsed since an ISO timestamp (UTC-safe).
function minsSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function nowIso() { return new Date().toISOString(); }

// ---- money ----
function inr(amount) { return Number(amount.toFixed(2)); }

// Indian number formatting: 12,34,567.89
function formatINR(amount) {
  const neg = amount < 0;
  const v = Math.abs(amount);
  const s = v.toFixed(2);
  const [intPart, decPart] = s.split('.');
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return (neg ? '-' : '') + '₹' + grouped + (decPart ? '.' + decPart : '');
}

// ---- ids ----
let seq = 1000;
function uid(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

function shortRef(prefix, rng) {
  const n = rng ? Math.floor(rng() * 90000000) + 10000000 : Math.floor(Math.random() * 90000000) + 10000000;
  return `${prefix}${n}`;
}

// ---- password hashing (scrypt, with legacy sha256:salt upgrade path) ----
const crypto = require('crypto');
function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), s, 32).toString('hex');
  return `scrypt$${s}$${h}`;
}
function verifyPassword(pw, stored) {
  const storedStr = String(stored || '');
  const parts = storedStr.split('$');
  if (parts[0] === 'scrypt') {
    return hashPassword(pw, parts[1]) === storedStr;
  }
  // Legacy sha256:salt format — verified so old rows can be upgraded on login.
  const [salt, hash] = parts;
  return crypto.createHash('sha256').update(`${salt}:${pw}`).digest('hex') === hash;
}

module.exports = {
  mulberry32, todayStr, daysAgo, daysAhead, addDays, diffDays, minsSince, nowIso,
  inr, formatINR, uid, shortRef, hashPassword, verifyPassword,
};
