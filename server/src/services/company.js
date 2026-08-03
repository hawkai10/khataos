'use strict';

// Company settings service: JSON settings blob on companies, used by the
// settings routes and payment approval thresholds.

const { get, update } = require('../db');

async function getSettings(coId) {
  const row = await get('SELECT settings FROM companies WHERE id = ?', [coId]);
  return JSON.parse((row && row.settings) || '{}');
}

async function saveSettings(coId, patch) {
  const current = await getSettings(coId);
  const next = { ...current, ...(patch || {}) };
  await update('companies', coId, { settings: JSON.stringify(next) });
  return next;
}

module.exports = { getSettings, saveSettings };
