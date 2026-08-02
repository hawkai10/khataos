# Architecture

## 1. Stack decisions

| Concern | MVP (this repo) | Production target | Why |
| --- | --- | --- | --- |
| API services | Node.js 22, built-in `node:http`, zero deps | Node.js (Fastify/NestJS) or Python | Node chosen for fast iteration and single language across stack |
| Transactional DB | SQLite (`node:sqlite`) | PostgreSQL 16 (Aurora) | Same relational model, zero-friction demo |
| Analytics | Derived queries + in-memory rollups | ClickHouse | 30-day cash trend + recon scoring need columnar scans |
| Events | In-process async queue (see §4) | SQS + EventBridge / Kafka | Decouple slow bank/Tally/GST integrations from UI |
| Region | localhost | AWS Mumbai (`ap-south-1`) | RBI data-localization for bank/PAN/GST data |
| Auth | Session tokens + RBAC | OAuth 2.0 (PKCE) + SAML for SSO | Spec requires OAuth2 at launch; demo uses same role model |
| Web | Vanilla JS SPA, responsive, tablet-first | React/Vite | MVP speed; no build toolchain |

## 2. Module boundaries (bounded contexts)

```text
┌────────────────────────────────────────────────────────────┐
│ Web App (responsive SPA)                                    │
└───────────────▲──────────────────────────────▲─────────────┘
                │ REST + RBAC                  │
┌───────────────┴──────────────────────────────┴─────────────┐
│ API Gateway layer (auth, tenant scoping, audit)             │
├──────────────┬─────────────┬─────────────┬─────────────────┤
│ Cash & Banks │ AP & Approvals│ Payments  │ Reconciliation   │
│ GST          │ Tally Sync   │ Dashboard  │ Onboarding       │
└──────┬───────┴──────┬───────┴──────┬─────┴───────┬─────────┘
       ▼              ▼              ▼             ▼
   adapters:   AA / direct    gateway (RazorpayX  Tally ODBC+XML
   bank feeds  bank APIs      / Cashfree)         service
              └──────────────────────────────────────────────┘
              Event queue between adapters and domain modules
```

Every module owns its tables and emits events; nothing calls a provider
directly from a request handler. This is what makes "unified platform beats
four point solutions" true operationally: one consent, one vendor master, one
ledger mapping, one status feed.

## 3. Data model highlights

- **Tenant isolation**: every table carries `company_id`; all queries filter
  on it. RBAC is role-per-user inside the tenant.
- **Banking**: `bank_accounts` (source: `aa` or `direct_api`), `bank_transactions`
  (signed amounts, `balance_after`, status posted/uncleared), `cash_daily`
  closing-balance rollups for the 30-day trend.
- **AP**: `invoices` + `invoice_lines` (HSN, taxes), `approvals` (multi-level
  trail), three-way match state against Tally PO/receipt references.
- **Payments**: `payments` with mode (UPI/IMPS/NEFT/RTGS), type
  (batch/scheduled/instant), status lifecycle, gateway reference, GST ledger +
  TDS section auto-tagged from vendor master.
- **Recon**: `recon_matches` linking bank transactions to payments/vouchers
  with `match_type` (exact / fuzzy / combined / manual) and confidence.
- **GST**: `gstr2b_snapshots` per period, `gst_mismatches`, liability computed
  from approved-but-unpaid invoices.
- **Tally**: `tally_sync_logs` (queue + outcomes) and `tally_health`.
- **Audit**: `audit_logs` for every state-changing action.

## 4. Event-driven design

Adapters are slow and flaky by nature (bank APIs, Tally single-user mode,
gateway callbacks). The MVP uses an in-process async job queue with
retry/backoff and idempotency keys:

```text
invoice.approved ──► [queue] ──► tally.createVoucher ──► sync log
bank.txn.new      ──► [queue] ──► recon.match
payment.scheduled ──► [queue] ──► gateway.execute (pending→processing→completed/failed)
gstr2b.fetched    ──► [queue] ──► mismatch scan
```

In production these queues become SQS topics; handlers stay identical. The UI
never blocks on an adapter call — it polls status, exactly like the real
product will.

## 5. Adapter interfaces (real vs simulated)

Each adapter exposes a provider-agnostic interface and a `MOCK` implementation.
Replacing a simulator = implementing the same interface against the provider
SDK and flipping a config flag.

| Adapter | Interface | Real provider (Phase 1) | Simulator behavior |
| --- | --- | --- | --- |
| `BankDataProvider` | `startConsent`, `listAccounts`, `fetchTransactions`, `refresh` | Sahamati AA network (FIU) + ICICI/HDFC corporate APIs for unsupported banks | Generates realistic 90-day transaction history per account with Indian modes/narrations |
| `PaymentGateway` | `createBatch`, `schedule`, `execute`, `status`, `webhook` | RazorpayX, then Cashfree | Async lifecycle, deterministic ~4% failure for demo, UTR generation |
| `TallyConnector` | `syncVouchers`, `createVoucher`, `queue`, `health`, `installer` | Windows service over Tally ODBC + XML export (TallyPrime ≥ 2.1) | Simulated ledger/voucher sync, single-user queueing, health pings |
| `OcrEngine` | `extractInvoice(image/pdf/text)` | Document AI / custom model trained on Indian GST invoice formats | Rule+keyword extraction for Indian invoices: GSTIN, HSN, CGST/SGST/IGST, bilingual narrations |
| `GstDataProvider` | `fetchGstr2b`, `exportReturn` | GSTN e-invoice API + GSTR-2B | Period snapshots with injected mismatches for demo |

## 6. TallyPrime connector

The connector is a lightweight Windows service installed on the customer's
Tally server (`docs/tally-connector.md`). It reads via Tally ODBC + XML export,
writes vouchers via TDL XML import, and syncs bidirectionally with the cloud
API. Tally single-user mode is handled by queueing and retrying until the file
is free; the sync health dashboard reflects queue depth and last success.

## 7. Security, RBAC, audit

- Passwords hashed (SHA-256 + salt in demo; bcrypt/Argon2 + OAuth2 in prod).
- Roles: `cfo` (admin), `finance_manager`, `finance_executive` with
  per-route permission checks and threshold rules:
  - Invoices > ₹1,00,000 require CFO approval (configurable per tenant).
  - Payment batches > ₹5,00,000 require CFO approval.
- Every mutation writes an audit log with actor, entity, and payload digest.
- Tenant scoping is enforced in SQL, not in the client.

## 8. Production deployment (AWS Mumbai)

`deploy/docker-compose.yml` and `deploy/aws-notes.md` cover the target:
ALB → ECS/Fargate API + SPA, Aurora PostgreSQL, ClickHouse, SQS, S3 (invoice
documents), Secrets Manager (bank/gateway credentials), KMS at rest, WAF in
front. All bank/PAN/GST data stays in `ap-south-1`.
