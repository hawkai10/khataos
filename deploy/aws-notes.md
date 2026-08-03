# AWS Mumbai deployment notes (RBI data-localization)

## Target topology

```text
CloudFront/WAF ──► ALB ──► ECS Fargate (API + SPA, ap-south-1)
                     │        ├─ Aurora PostgreSQL (transactional)
                     │        ├─ ClickHouse (analytics)
                     │        ├─ SQS (bank ingestion, Tally sync, payments)
                     │        └─ S3 (invoice PDFs) + Secrets Manager (keys)
                     └─ KMS encryption at rest · VPC endpoints for private traffic
```

## Localization & compliance

- All bank, PAN, GSTIN, and transaction data stays in `ap-south-1` (RBI data
  localization for regulated financial data).
- Account Aggregator flows run through a licensed FIU partner; consent
  artifacts are stored with an immutable audit record and TTL expiry.
- GSTN e-invoice/GSTR-2B access via GSP API with signed payloads.

## Security checklist for launch

- Secrets Manager: bank API keys, RazorpayX/Cashfree credentials, Tally
  connector API keys, DB master password. Rotate monthly.
- WAF rules on the ALB; TLS 1.2+; signed download URLs for invoice documents.
- Network ACLs: API only reachable from ALB; Tally connector uses outbound
  HTTPS to a dedicated endpoint (no inbound ports from customer sites).
- Login/OTP rate limiting keys on the raw socket IP by default. Do NOT enable
  `KHATAOS_TRUST_PROXY=1` unless the edge (CloudFront/WAF/ALB) overwrites or
  strips client-supplied `X-Forwarded-For`; ALB/CloudFront only *append* to it,
  leaving the attacker-controlled value first, which would let a client rotate
  the header and bypass brute-force protection. With a header-sanitizing proxy
  in front (e.g. nginx `proxy_set_header X-Forwarded-For $remote_addr`), set
  `KHATAOS_TRUST_PROXY=1` so all clients behind the proxy share one real-IP
  bucket instead of the proxy's single address.
- Backups: Aurora PITR (35 days), ClickHouse S3 snapshots, S3 versioning for
  invoice store.
- Audit: every bank consent, approval, payment, and Tally sync writes to the
  audit log table (append-only, KMS-signed in production).

## Scaling expectations at 100 customers

- Aurora: 2 × db.r6g.large (multi-AZ) with read replica for dashboards.
- ClickHouse: 1 × c5.large is ample for 30-day rollups; partition by month.
- SQS: two queues — `bank-ingest` (refreshes) and `tally-sync` (vouchers);
  DLQ + retry with exponential backoff matches the dev job queue semantics.

## Observability

- CloudWatch alarms: Tally heartbeat older than 5 min (99.5% uptime SLO),
  gateway failure rate > 2%, recon accuracy below 70%, queue depth > 1000.
- Structured logs ship to CloudWatch Logs; metrics page in the app exposes
  the commercial KPIs (customers, ACV, retention) from the CRM pipeline.

## Database switching (verified)

The storage layer has been verified against two engines end-to-end
(`node tests/smoke.js` on SQLite, `node tests/smoke.js --pg` on in-process
PostgreSQL). To point the app at a real Aurora instance:

```powershell
$env:KHATAOS_DATABASE_URL = "postgres://khataos:...@cluster.aws.com:5432/khataos"
node server/src/server.js
```

The schema is created automatically on startup; `deploy/postgres/init.sql`
documents the production DDL shape. Keep `ap-south-1` for all bank/PAN/GST
data per RBI localization.
