'use strict';

// Central environment access. Values are read at CALL time (not require time)
// so tests can change credentials mid-process and multi-tenant config can
// evolve without re-requiring modules.

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : v;
}

function hasAll(...names) {
  return names.every((n) => !!process.env[n]);
}

module.exports = { env, hasAll };
