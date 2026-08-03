'use strict';

const API = {
  token: localStorage.getItem('khataos_token') || '',
  user: JSON.parse(localStorage.getItem('khataos_user') || 'null'),

  async req(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = 'Bearer ' + this.token;
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
      if (resp.status === 401 && this.token) {
        // Stale/invalid session (e.g. server DB reset) — clear it and let the
        // app return to the login screen.
        this.logout();
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
    this.token = data.token;
    this.user = data.user;
    localStorage.setItem('khataos_token', this.token);
    localStorage.setItem('khataos_user', JSON.stringify(this.user));
    return data.user;
  },
  logout() {
    this.token = '';
    this.user = null;
    localStorage.removeItem('khataos_token');
    localStorage.removeItem('khataos_user');
  },
};
