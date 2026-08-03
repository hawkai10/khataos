'use strict';

// Tiny regex-based router shared by all domain routers. Patterns support
// `:param` segments; `find` returns { handler, params }.
class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    this.routes.push({ method, rx, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  find(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.rx);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function ok(res, data) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); }

module.exports = { Router, ok };
