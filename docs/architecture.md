# Architecture

## 1. Stack decisions

| Concern | MVP (this repo) | Production target | Why |
| --- | --- | --- | --- |
| API services | Node.js 22, built-in `node:http`, zero deps | Node.js (Fastify/NestJS) or Python | Node chosen for fast iteration and single language across stack |
| Transactional DB | SQLite (`node:sqlite`) **or** PostgreSQL (in-process `pglite` / server via `KHATAOS_DATABASE_URL`) | PostgreSQL 16 (Aurora) | Storage layer is engine-swappable; same schema & async helpers across engines, verified by dual smoke suites |
| Analytics | Derived queries + in-memory rollups | ClickHouse | 30-day cash trend + recon scoring need columnar scans |
| Events | In-process async queue (see §4) | SQS + EventBridge / Kafka | Decouple slow bank/Tally/GST integrations from UI |
| Region | localhost | AWS Mumbai (`ap-south-1`) | RBI data-localization for bank/PAN/GST data |
| Auth | Session tokens + RBAC | OAuth 2.0 (PKCE) + SAML for SSO | Spec requires OAuth2 at launch; demo uses same role model |
| Web | Vanilla JS SPA, responsive, tablet-first | React/Vite | MVP speed; no build toolchain |

## Storage layer

`server/src/db.js` exposes `{ all, get, run, insert, update, exec, listTables,
countRows }` — async in every engine — plus `DB_ENGINE`/`DB_PATH` for
introspection. The app never touches a driver directly, so switching databases
is configuration, not code:

```text
engine = sqlite      -> node:sqlite (zero-setup dev/demo)
engine = pglite      -> in-process PostgreSQL (WASM) for dev/testing
engine = postgres    -> KHATAOS_DATABASE_URL (production, AWS Mumbai)
```

**End-state decision:** once every module runs on Drizzle, `db.js`'s
`SCHEMA` string and the custom wrapper are deleted and the Drizzle
descriptor (`src/db/schema.js`) is the single source of truth — it already
generates both dialects and the complete baseline migrations. The dual
definitions are a transitional arrangement only; see the migration roadmap
in `docs/codebase.md` for the explicit cutover steps.

The System Health page (`/api/system/health`, "System Health" in the nav)
reports the live engine, table counts, event-queue depth, and every
integration's status — the same endpoint the smoke tests assert against.

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

## 5. Adapter interfaces (real-only)

Each adapter exposes a provider-agnostic interface and only talks to real
providers — there are no mock implementations. An unconfigured provider refuses
with `503` (see `server/src/config.js`); the CI gateway double
(`PAYMENT_GATEWAY=test`) only transitions payment status and never fabricates
bank data.

| Adapter | Interface | Real provider (Phase 1) | Unconfigured behavior |
| --- | --- | --- | --- |
| `BankDataProvider` | `startConsent`, `listAccounts`, `fetchTransactions`, `refresh` | **Decentro Connected Banking** (balance + statement, many banks via one API) as primary AIS; Sahamati AA (FIU) and ICICI/HDFC corporate APIs as alternates | 503 until AA/direct credentials are configured (TODO(real-aa)) |
| `PaymentGateway` | `createBatch`, `schedule`, `execute`, `status`, `webhook` | RazorpayX, then Cashfree | 503 until RazorpayX credentials; `PAYMENT_GATEWAY=test` CI double |
| `TallyConnector` | `syncVouchers`, `createVoucher`, `queue`, `health`, `installer` | Windows service over Tally ODBC + XML export (TallyPrime ≥ 2.1) | Queued async sync log + health pings over the file-based XML path |
| `OcrEngine` | `extractInvoice(image/pdf/text)` | Document AI / custom model trained on Indian GST invoice formats | Rule+keyword extraction for Indian invoices: GSTIN, HSN, CGST/SGST/IGST, bilingual narrations |
| `GstDataProvider` | `fetchGstr2b`, `scanMismatches`, `exportReturn` | GSP/GSTN taxpayer API (GSTR-2B `b2b`/`cdnr` fetch) + e-invoice IRP (IRN generation), implemented in `server/src/gstn.js` | 503 until `GSTN_*` credentials are configured |

The Decentro adapter (`server/src/decentro.js`) is live API code, not a stub:
it calls Decentro's `/v2/banking/account/{acc}/balance` and `/statement`
endpoints with header auth and maps responses into the same transaction model.
It activates when `DECENTRO_*` env vars are present and otherwise reports as
not configured (see `docs/decentro.md`).

The GSTN adapter (`server/src/gstn.js`) is likewise live API code: it models
the GSP taxpayer-API contract (OTP request â†’ `AUTHTOKEN` â†’ GSTR-2B fetch) and
the e-invoice IRP `generate` call, and delegates the platform's GSTR-2B
refresh through it. It activates when `GSTN_*` env vars are present and
otherwise refuses with `503` - no simulated GSTR-2B payloads exist (see
`docs/gstn.md`).

## 6. TallyPrime connector

The connector is a lightweight Windows service installed on the customer's
Tally server (`docs/tally-connector.md`). It reads via Tally ODBC + XML export,
writes vouchers via TDL XML import, and syncs bidirectionally with the cloud
API. Tally single-user mode is handled by queueing and retrying until the file
is free; the sync health dashboard reflects queue depth and last success.

## 7. Security, RBAC, audit

- Passwords hashed with scrypt (legacy sha256+salt rows upgrade on first
  login); sessions are httpOnly SameSite=Strict cookies for browsers, with
  the Authorization header retained for API clients.
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
