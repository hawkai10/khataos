'use strict';

const API = {
  user: JSON.parse(localStorage.getItem('khataos_user') || 'null'),

  // Fresh key per request: a browser double-click produces two different keys,
  // so the server-side conditional-update guards are what stop the duplicate
  // dispatch. Clients that implement retry should reuse the same key across
  // attempts of the same logical action to get response replay.
  idemKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  },

  async req(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (method === 'POST' || method === 'PUT') headers['idempotency-key'] = this.idemKey();
    const resp = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await resp.json(); } catch { /* non-JSON */ }
    if (!resp.ok) {
      const msg = json && json.error ? json.error.message : `Request failed (${resp.status})`;
      const err = new Error(msg);
      err.status = resp.status;
      if (resp.status === 401) {
        // Stale/invalid session — clear it and let the app return to login.
        this.user = null;
        localStorage.removeItem('khataos_user');
        document.dispatchEvent(new CustomEvent('khataos:unauthorized'));
      }
      throw err;
    }
    return json.data;
  },
  get(path) { return this.req('GET', path); },
  post(path, body) { return this.req('POST', path, body); },
  put(path, body) { return this.req('PUT', path, body); },

  async login(email, password) {
    const data = await this.req('POST', '/api/auth/login', { email, password });
    this.user = data.user;
    localStorage.removeItem('khataos_token'); // sessions are httpOnly cookies now
    localStorage.setItem('khataos_user', JSON.stringify(this.user));
    return data.user;
  },
  async logout() {
    try { await this.req('POST', '/api/auth/logout', {}); } catch { /* cookie may already be gone */ }
    this.user = null;
    localStorage.removeItem('khataos_token');
    localStorage.removeItem('khataos_user');
  },
};
