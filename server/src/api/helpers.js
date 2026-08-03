'use strict';

// Shared plumbing for domain routers: company scoping and query-string parsing.

function companyOf(user) { return user.company_id; }

function parseUrl(req) { return new URL(req.url, 'http://x'); }

function queryParam(u, name, fallback = '') {
  const v = u.searchParams.get(name);
  return v == null ? fallback : v;
}

function queryInt(u, name, fallback) {
  const raw = u.searchParams.get(name);
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { companyOf, parseUrl, queryParam, queryInt };
