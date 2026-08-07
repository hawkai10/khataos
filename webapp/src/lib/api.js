let user = JSON.parse(localStorage.getItem('khataos_user') || 'null');
let onUnauthorized = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export function getToken() {
  // Sessions are httpOnly cookies now; the header path is only for API
  // clients. Nothing sensitive is stored in localStorage.
  return '';
}

export function getUser() {
  return user;
}

export function setSession(t, u) {
  user = u;
  localStorage.removeItem('khataos_token'); // migrate away from stored tokens
  localStorage.setItem('khataos_user', JSON.stringify(u));
}

export function clearSession() {
  user = null;
  localStorage.removeItem('khataos_token');
  localStorage.removeItem('khataos_user');
}

// Fresh key per request (see web/js/api.js for the retry contract): the
// server's conditional-update guards stop double-click duplicates; clients
// that retry should reuse the key of the original attempt.
function idemKey() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (method === 'POST' || method === 'PUT') headers['idempotency-key'] = idemKey();
  const resp = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await resp.json();
  } catch {
    /* non-JSON response */
  }
  if (!resp.ok) {
    const msg = json && json.error ? json.error.message : `Request failed (${resp.status})`;
    const err = new Error(msg);
    err.status = resp.status;
    if (resp.status === 401) {
      clearSession();
      if (onUnauthorized) onUnauthorized();
    }
    throw err;
  }
  return json.data;
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body);
export const put = (path, body) => api('PUT', path, body);

// Download an authenticated GET endpoint (e.g. CSV exports) as a file.
export async function download(path, filename) {
  const resp = await fetch(path);
  if (!resp.ok) {
    let msg = `Download failed (${resp.status})`;
    try {
      const j = await resp.json();
      if (j && j.error) msg = j.error.message;
    } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'khataos-export.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
