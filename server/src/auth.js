'use strict';

const crypto = require('crypto');
const { all, get, insert, run, getDrizzle, T } = require('./db');
const { nowIso, uid, hashPassword } = require('./util');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ROLES = ['cfo', 'finance_manager', 'finance_executive'];

async function login(email, password) {
  const user = await get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', [email]);
  if (!user) throw new ApiError(401, 'Invalid email or password');
  const { verifyPassword } = require('./util');
  if (!verifyPassword(password, user.password)) throw new ApiError(401, 'Invalid email or password');
  // Upgrade legacy sha256:salt hashes to scrypt on first successful login.
  if (!String(user.password || '').startsWith('scrypt$')) {
    await run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(password), user.id]);
  }
  const token = crypto.randomBytes(24).toString('hex');
  await insert('sessions', {
    token, user_id: user.id, created_at: nowIso(),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  await run("UPDATE users SET last_login_at = ? WHERE id = ?", [nowIso(), user.id]);
  return { token, user: publicUser(user) };
}

async function logout(token) {
  await run('DELETE FROM sessions WHERE token = ?', [token]);
}

async function currentUser(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const s = await get('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', [token, nowIso()]);
  if (!s) return null;
  const user = await get('SELECT * FROM users WHERE id = ? AND active = 1', [s.user_id]);
  return user || null;
}

// Session token from the httpOnly cookie first, then the Authorization header
// / x-khataos-token (API clients).
function tokenFrom(req) {
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)khataos_session=([^;]+)/);
  const cookieToken = cookie ? decodeURIComponent(cookie[1]) : null;
  const h = req.headers.authorization || '';
  return cookieToken || (h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-khataos-token'] || ''));
}

// HttpOnly session cookie for browser clients. SameSite=Strict + the JSON
// content-type requirement give CSRF protection without extra tokens; API
// clients keep using the Authorization header.
function sessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `khataos_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${7 * 24 * 3600}${secure}`;
}

function clearSessionCookie() {
  return 'khataos_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0';
}

async function requireAuth(req) {
  const user = await currentUser(req);
  if (!user) throw new ApiError(401, 'Authentication required');
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new ApiError(403, `Requires role: ${roles.join(' or ')}`);
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, department: u.department, company_id: u.company_id };
}

// `db` is optional: pass the enclosing Drizzle transaction so the audit row is
// written atomically with the state change it describes; otherwise it resolves
// the global Drizzle instance (a single standalone insert).
async function audit(companyId, user, action, entity, entityId, details, db) {
  const d = db || await getDrizzle();
  await d.insert(T.audit_logs).values({
    id: uid('aud'), company_id: companyId,
    user_id: user ? user.id : null, user_name: user ? user.name : 'system',
    action, entity, entity_id: entityId,
    // BigInt-safe: any stray paise BigInt in details is serialized as a string
    // so an audit log can never crash a route.
    details: details ? JSON.stringify(details, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) : null, at: nowIso(),
  });
}

async function recentAudit(companyId, limit = 50) {
  return all('SELECT * FROM audit_logs WHERE company_id = ? ORDER BY at DESC LIMIT ?', [companyId, limit]);
}

module.exports = { ApiError, ROLES, login, logout, currentUser, tokenFrom, requireAuth, requireRole, publicUser, audit, recentAudit, sessionCookie, clearSessionCookie };
