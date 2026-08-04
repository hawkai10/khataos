# KhataOS — Codebase Overview

KhataOS is a single-dashboard finance platform for Indian mid-market companies:
multi-bank cash visibility, accounts payable + approvals, payment execution,
bank reconciliation, GST tracking, and TallyPrime sync. It is a real-data
product — nothing is simulated. Unconfigured providers refuse with `503`
instead of fabricating data; data only enters through real channels (Tally XML
import, bank statements, GSTR-2B fetches, forwarded invoices).

## Repository layout

```text
khataos/
  server/          Node.js 22 backend (Fastify, Drizzle, three DB engines)
  webapp/          React + Tailwind SPA (Vite; build -> dist)
  web/             Legacy zero-dependency SPA (fallback when webapp is unbuilt)
  tests/           Unit + E2E suites, aggregator, live-Postgres runner
  docs/            Deep dives: architecture, PRD, Tally, GSTN, Decentro, AI
  deploy/          Dockerfile, docker-compose (Postgres + ClickHouse), AWS notes
  .github/workflows/ci.yml   CI: SQLite+pglite job and real-Postgres job
```

## Backend stack and boot flow

Dependencies (server/package.json): **Fastify 5** (HTTP), **Drizzle ORM 0.45**
(query builder + migrations), **fast-xml-parser 5** (Tally XML), **pg**
(Postgres driver), **@electric-sql/pglite** (in-process Postgres),
**@libsql/client** (SQLite driver for the Drizzle layer — local `file:` URLs
only, no remote/Turso mode), plus **drizzle-kit** and **embedded-postgres**
(dev only).

Boot (`server/src/server.js`): load `.env` → seed the supported-bank reference
directory (`seed.js`) → optionally bootstrap a test tenant (test hooks) →
build the Fastify app (`http/app.js`) → listen. The app serves the React build
from `webapp/dist` when present, otherwise the legacy `web/` SPA, plus
`docs/` as static pages.

## Storage layer (`server/src/db.js`)

One API — `{ all, get, run, insert, update, exec, listTables, countRows }` —
async on every engine; the app never touches a driver directly:

| Engine | Enable via | Use for |
| --- | --- | --- |
| SQLite | default | Zero-setup dev/demo (`node:sqlite`) |
| pglite | `KHATAOS_DB_ENGINE=pglite` | In-process Postgres for dev/testing |
| Postgres | `KHATAOS_DATABASE_URL=…` | Production (AWS Mumbai) |

Schema: `SCHEMA` in `db.js` is the authoritative table definition; the
Drizzle descriptor in `src/db/schema.js` mirrors it one-to-one and generates
both dialect variants (`schema-sqlite.js`, `schema-pg.js`). On boot the custom
layer applies the base schema, best-effort `ALTER`s, then **versioned
migrations** recorded in `schema_migrations` (v1: invoice-number uniqueness
with dedupe guard; v2: composite indexes; v3: legacy rupee → paise money
conversion). Drizzle migrations live in `server/drizzle/{sqlite,pg}` and are
applied via `getDrizzle()`.

**Money model:** every amount is stored as integer paise — `BIGINT` on
PostgreSQL, `INTEGER` on SQLite — and all arithmetic goes through the `Money`
value object (`server/src/money.js`, BigInt-backed: `fromRupees` parses
decimal strings exactly, `plus`/`minus`/`percentBps`/`equals` are exact, and
`toRupees()` emits rupee decimal strings). The JSON API exposes money as
rupee decimal strings (e.g. `"59000.00"`). Reconciliation matches to the
paisa; the only permitted amount slack is the explicit, configurable
inward-remittance bank-charge rule (`RECON_BANK_FEE_TOLERANCE_PAISE`, default
0 = exact), applied to bank credits only.

**Migration status:** the Tally import pipeline is fully converted to Drizzle
queries; all other modules still use the custom wrapper. Both coexist during
the transition (`getDrizzle()` fails loudly for converted code, the wrapper
keeps working for everything else).

## HTTP layer (`server/src/http/app.js`)

- Response envelope: `{ ok: true, data }` / `{ ok: false, error: { message, status } }`.
- Content-type parsing preserves the old contract: any body parsed as JSON,
  empty → `{}`, invalid JSON → 400 "invalid JSON body".
- `onRequest` hook: request id + timing, **rate limits** (login 10, OTP 5 per
  15-min window; keyed on the socket IP by default — `X-Forwarded-For` is only
  trusted with `KHATAOS_TRUST_PROXY=1` behind a header-sanitizing proxy),
  then auth (cookie → Bearer → `x-khataos-token`) with a public-route allowlist.
- `onResponse`: one-line structured request log.
- Error handler: `ApiError` → its status; Fastify validation → 400; body too
  large → 413; unknown → 500 (logged).
- Not-found handler: 404 for unknown `/api/*`, SPA fallback for everything else.

## Domain modules (`server/src/api/*`)

Routes are thin; validation lives in `validators.js`, repeated SQL in
`services/*`, and JSON-schema body validation is on the critical financial
endpoints (Tally import, payment create, invoice approve):

- **admin** — login/logout, users, audit, dashboard, AI assistant, onboarding,
  settings, metrics, system health.
- **cash** — bank accounts, refresh, AA consent + Decentro link, webhooks.
- **invoices** — capture (manual/forwarded/OCR preview), list/detail,
  approve/reject with multi-level approval chains, three-way match.
- **payments** — create (schema-validated), approve, execute, batch, list;
  gateway integration with status lifecycle.
- **gst** — GSTN config/OTP, GSTR-2B refresh + scan, mismatches, CSV exports.
- **tally** — health, sync logs, XML import (schema-validated), pull-ledgers,
  vendor↔ledger mappings, retry.

## Auth and security (`server/src/auth.js`)

- scrypt password hashes (legacy sha256 hashes auto-upgraded on login).
- Sessions table with 7-day TTL; httpOnly `SameSite=Strict` cookie for
  browsers, Bearer header for API clients.
- RBAC: `cfo` / `finance_manager` / `finance_executive`, enforced per route.
- Every state change writes an `audit_logs` row.

## Tally pipeline (cloud XML import)

`tally.js` parses real-world Tally export variance via **fast-xml-parser**
(voucher numbers as `VOUCHERNUMBER`/`VCHNUM`, dates `YYYYMMDD`/`YYYY-MM-DD`,
type from tag or `VCHTYPE` attribute, nested vs flat ledger entries,
GUID/ALTERID, `ISCANCELLED`, inventory exports) with a thin normalization
layer on top. `tally-import.js` validates (debits = credits, group/ledger
references, GSTIN format, auto-creates missing ledgers under standard groups)
then imports in sequence Groups → Ledgers → Vouchers, deduplicated per company
by GUID/ALTERID. `tally-mapping.js` maps vendors to ledgers and auto-maps.

## Integrations, queue, GST, AI

- `adapters.js` — one interface per external system (AA, direct bank APIs,
  payment gateway, OCR, Tally, GSTN), each 503 until configured; plus the
  in-process **job queue** with retry/backoff (production target: SQS).
  `PAYMENT_GATEWAY=test` enables a CI-only gateway double.
- `gstn.js` — GSP auth (OTP → AUTHTOKEN), GSTR-2B fetch/map, e-invoice IRN.
- `decentro.js` — Connected Banking: account link, consent, statement pull.
- `recon.js` — bank ↔ payments ↔ Tally/GSTR-2B matching (exact/fuzzy/manual)
  with confidence scoring and payables aging.
- `ai.js` — deterministic rule engine over a live-data snapshot, optional
  DeepSeek generation (`DEEPSEEK_API_KEY`), with scope guardrails.

## Frontend (`webapp/`, fallback `web/`)

React SPA: `lib/api.js` (cookie-based fetch, `error.message` surfaced in
toasts), views for dashboard/cash/payables/payments/recon/GST/Tally/onboarding/
system/settings, shadcn-style UI components. The legacy `web/` SPA uses the
same endpoints and envelope, so both frontends stay consumer-compatible.

## Tests and CI

- `tests/run-all.js` — aggregator CI runs: every unit test file, then pglite
  variants of Tally import/recon/smoke, then (with `PG_LIVE_URL` or
  `--pg-live`) the real-Postgres suite via `pg-live.test.js` (embedded Postgres
  locally, service container in CI).
- Highlights: `smoke.js` (real server, real-channel data, RBAC, rate limiting,
  XFF-bypass regression), `security.test.js` (cookies, scrypt, **concurrent
  rate-limit bursts with exact counts**), `drizzle-schema.test.js` (descriptor
  vs `db.js` parity + SQLite/pglite/live-PG result equality), Tally fuzz +
  parser equivalence, three-way reconciliation, migrations.
- CI (`.github/workflows/ci.yml`): `test` job (SQLite + pglite) and
  `test-postgres` job (Postgres 16 service, public schema reset before the
  suite, `PG_LIVE_URL` set).

## Deployment and production plan

`deploy/Dockerfile.api` builds the API + SPA image; `docker-compose.yml` is a
production-shaped local stack (API + Postgres 16 + ClickHouse). `aws-notes.md`
targets CloudFront/WAF → ALB → ECS Fargate with Aurora PostgreSQL, ClickHouse,
SQS, S3 and Secrets Manager in `ap-south-1` (RBI data localization), and the
security checklist (TLS, WAF, network ACLs, **rate-limit proxy trust**,
audit logging).

## How to run

```powershell
cd webapp; npm install; npm run build; cd ..
node server/src/server.js                     # SQLite, http://localhost:8080
$env:KHATAOS_DB_ENGINE = "pglite"; node server/src/server.js
$env:KHATAOS_DATABASE_URL = "postgres://…"; node server/src/server.js
node tests\run-all.js                         # SQLite + pglite
node tests\run-all.js --pg-live               # + real Postgres (embedded)
```

## What is planned next (migration roadmap)

- **Drizzle cutover** for the remaining modules (cash, invoices, payments,
  GST, admin), one module at a time, reusing the Tally pattern: explicit
  schema, `getDrizzle()`, versioned migrations, cross-engine parity tests.

  **End-state decision (explicit): the Drizzle descriptor in
  `src/db/schema.js` becomes the single source of truth, and `db.js`'s
  `SCHEMA` is deleted once the cutover is complete.** Keeping both
  definitions indefinitely would mean every schema change costs two edits
  plus a CI drift gate forever, with no runtime benefit — and the Drizzle
  descriptor already generates both dialects and the complete baseline
  migrations (every table, FK, check, unique, and index, including the
  legacy v1/v2 ones), so a fresh database needs no `SCHEMA` SQL at all.
  Final cutover steps, in order:

  1. Convert the remaining domain modules, services, seed, test hooks, and
     the job queue to Drizzle query builder (the Tally pipeline is the
     template). Migrate test data-seeding/assertions to Drizzle queries (or
     a thin test-only helper).
  2. Repurpose `tests/drizzle-schema.test.js`: drop the `db.js`-SCHEMA
     comparison half and replace it with a "migrations match the descriptor"
     check (apply the migrations to a fresh DB, then introspect
     `sqlite_master` / `information_schema` against the descriptor). Keep
     the SQLite/pglite/live-Postgres result-equality check unchanged.
  3. Delete from `db.js`: `SCHEMA`, `PG_SCHEMA`, `MIGRATIONS`,
     `SCHEMA_MIGRATIONS`, `translate()`, and the custom
     `all/get/run/insert/update/exec` wrapper (the wrapper is the only
     consumer of `SCHEMA`, so both go together). `getDrizzle()`,
     `listTables`, and `countRows` remain the public surface.
  4. Regenerate and verify the Drizzle baseline (`drizzle-kit generate` for
     both dialects, then a fresh-DB smoke) so no legacy SQL is needed.
     Because this project is pre-production, existing databases are
     recreated from the Drizzle baseline — there is no supported in-place
     upgrade path from the transitional schema.
- **Production networking**: enable `KHATAOS_TRUST_PROXY=1` only behind a
  proxy that overwrites/strips `X-Forwarded-For`; a multi-instance deployment
  will move rate-limit state to a shared store (Redis) since the current
  limiter is in-memory per process.
- **Auth evolution**: OAuth 2.0 (PKCE) + SSO per the PRD, on top of the same
  role model. Out of scope for MVP: mobile apps, custom ERP integrations,
  host-to-host banking, multi-entity consolidation.

Deep dives live in `docs/architecture.md`, `docs/tally-connector.md`,
`docs/gstn.md`, `docs/decentro.md`, and `docs/ai-assistant.md`.
