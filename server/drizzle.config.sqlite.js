'use strict';

const { defineConfig } = require('drizzle-kit');

module.exports = defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema-sqlite.js',
  out: './drizzle/sqlite',
  dbCredentials: { url: 'file:./data/khataos.db' },
});
