let token = localStorage.getItem('khataos_token') || '';
let user = JSON.parse(localStorage.getItem('khataos_user') || 'null');
let onUnauthorized = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export function getToken() {
  return token;
}

export function getUser() {
  return user;
}

export function setSession(t, u) {
  token = t;
  user = u;
  localStorage.setItem('khataos_token', t);
  localStorage.setItem('khataos_user', JSON.stringify(u));
}

export function clearSession() {
  token = '';
  user = null;
  localStorage.removeItem('khataos_token');
  localStorage.removeItem('khataos_user');
}

export async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
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
    if (resp.status === 401 && token) {
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
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const resp = await fetch(path, { headers });
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
