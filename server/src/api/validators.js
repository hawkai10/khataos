'use strict';

// Dedicated request validators: keep route handlers free of inline shape
// checks and error construction for common cases.

const { ApiError } = require('../auth');

function bodyOf(req) {
  return (req.body && typeof req.body === 'object') ? req.body : {};
}

// specs: { key: 'human label' } — throws 400 naming the first missing field.
function requireBodyFields(body, specs) {
  for (const [key, label] of Object.entries(specs)) {
    const v = body[key];
    if (v === undefined || v === null || v === '') throw new ApiError(400, `${label || key} required`);
  }
  return body;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${label} required`);
  return value.trim();
}

function requireOneOf(value, allowed, message) {
  if (!allowed.includes(value)) throw new ApiError(400, message || `invalid value`);
  return value;
}

module.exports = { bodyOf, requireBodyFields, requireNonEmptyString, requireOneOf };
