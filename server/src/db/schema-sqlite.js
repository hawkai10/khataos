'use strict';

// SQLite dialect tables, exported individually so drizzle-kit can discover
// them. Single source of truth stays in schema.js.
module.exports = { ...require('./schema').sqlite };
