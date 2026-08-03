-- Analytics layer: daily cash rollups and recon scoring land here so the
-- dashboard never queries the transactional store for aggregates.
CREATE DATABASE IF NOT EXISTS khataos_analytics;

CREATE TABLE IF NOT EXISTS khataos_analytics.cash_daily
(
  company_id String,
  account_id String,
  date Date,
  closing_balance Decimal(18,2),
  source LowCardinality(String)
)
ENGINE = ReplacingMergeTree
ORDER BY (company_id, account_id, date);

CREATE TABLE IF NOT EXISTS khataos_analytics.recon_daily
(
  company_id String,
  date Date,
  total UInt32,
  auto_matched UInt32,
  manual_matched UInt32,
  accuracy Float64
)
ENGINE = SummingMergeTree
ORDER BY (company_id, date);
