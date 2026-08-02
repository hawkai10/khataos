'use strict';

const crypto = require('crypto');
const { all, get, insert, run, update } = require('./db');
const { nowIso, uid } = require('./util');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ROLES = ['cfo', 'finance_manager', 'finance_executive'];

function login(email, password) {
  const user = get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', [email]);
  if (!user) throw new ApiError(401, 'Invalid email or password');
  const { verifyPassword } = require('./util');
  if (!verifyPassword(password, user.password)) throw new ApiError(401, 'Invalid email or password');
  const token = crypto.randomBytes(24).toString('hex');
  insert('sessions', {
    token, user_id: user.id, created_at: nowIso(),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  run("UPDATE users SET last_login_at = ? WHERE id = ?", [nowIso(), user.id]);
  // bump today's DAU
  const today = nowIso().slice(0, 10);
  run(`INSERT INTO usage_daily (company_id, date, dau, mau)
       VALUES (?, ?, 1, 1)
       ON CONFLICT(company_id, date) DO UPDATE SET dau = 3`, [user.company_id, today]);
  return { token, user: publicUser(user) };
}

function logout(token) {
  run('DELETE FROM sessions WHERE token = ?', [token]);
}

function currentUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-khataos-token'] || '');
  if (!token) return null;
  const s = get('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', [token, nowIso()]);
  if (!s) return null;
  const user = get('SELECT * FROM users WHERE id = ? AND active = 1', [s.user_id]);
  return user || null;
}

function requireAuth(req) {
  const user = currentUser(req);
  if (!user) throw new ApiError(401, 'Authentication required');
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new ApiError(403, `Requires role: ${roles.join(' or ')}`);
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, department: u.department, company_id: u.company_id };
}

function audit(companyId, user, action, entity, entityId, details) {
  insert('audit_logs', {
    id: uid('aud'), company_id: companyId,
    user_id: user ? user.id : null, user_name: user ? user.name : 'system',
    action, entity, entity_id: entityId,
    details: details ? JSON.stringify(details) : null, at: nowIso(),
  });
}

function recentAudit(companyId, limit = 50) {
  return all('SELECT * FROM audit_logs WHERE company_id = ? ORDER BY at DESC LIMIT ?', [companyId, limit]);
}

module.exports = { ApiError, ROLES, login, logout, currentUser, requireAuth, requireRole, publicUser, audit, recentAudit };
