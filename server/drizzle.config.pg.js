'use strict';

const { defineConfig } = require('drizzle-kit');

module.exports = defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema-pg.js',
  out: './drizzle/pg',
  dbCredentials: { url: process.env.KHATAOS_DATABASE_URL || 'postgresql://user:pass@localhost:5432/khataos' },
});
