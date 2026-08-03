# KhataOS — Unified Finance Operating Platform (MVP)

KhataOS is a single dashboard for Indian mid-market CFOs and finance teams
(₹50–₹500 crore annual revenue) covering real-time multi-bank cash visibility,
accounts payable, vendor payment execution, automatic bank reconciliation,
GST compliance tracking, and TallyPrime sync — built native to the Indian
financial ecosystem, not a global TMS retrofitted for India.

This repository contains the **runnable MVP**: a Node.js backend (SQLite via
`node:sqlite`) and a **React + Tailwind + shadcn-style UI** (Vite build in
`webapp/`) with a zero-dependency legacy SPA fallback in `web/`. All external
integrations (Account Aggregator, ICICI/HDFC direct APIs, RazorpayX/Cashfree,
TallyPrime, GSTN) sit behind real adapter interfaces and activate when their
credentials are configured (see `.env.example`). Nothing is simulated: an
unconfigured provider refuses with `503` instead of fabricating data, so the
platform only ever holds real information (see `docs/architecture.md`).

---

## Quick start

Requirements: **Node.js 22+** on Windows, macOS, or Linux.

Build the web app (once, or after UI changes):

```powershell
cd webapp
npm install
npm run build
cd ..
```

If `webapp/dist` is absent, the server serves the legacy `web/` SPA instead,
so the repo always runs even before the frontend is built.

```powershell
cd khataos
node server/src/server.js
```

Open <http://localhost:8080> and log in with the users you provision for your
company. The database starts empty apart from the supported bank directory.

### Real bank data via Decentro (optional)

To fetch **real** balances and statements, set Decentro Connected Banking
credentials (sandbox or live) and restart:

```powershell
$env:DECENTRO_CLIENT_ID = "…"; $env:DECENTRO_CLIENT_SECRET = "…"
$env:DECENTRO_MODULE_SECRET = "…"; $env:DECENTRO_PROVIDER_SECRET = "…"
node server/src/server.js
```

Then **Cash & Banks → Connect a bank → Decentro Connected Banking**. Full
guide, endpoints, and mapping: [docs/decentro.md](docs/decentro.md). Without
these vars the endpoints report Decentro as "not configured" (503) and no
data is fabricated.

### Real GST data via a GSTN/GSP (optional)

To fetch **real** GSTR-2B data, set the tenant's GSTN/GSP credentials and
restart; until then `/api/gst/refresh` refuses with 503 (no simulated
GSTR-2B payloads exist):

```powershell
$env:GSTN_GSTIN = "your-gstin"
$env:GSTN_USERNAME = "..." ; $env:GSTN_APP_KEY = "..."
$env:GSTN_CLIENT_ID = "..." ; $env:GSTN_CLIENT_SECRET = "..."
node server/src/server.js
```

The adapter also models the e-invoice IRP `generate` contract. Auth flow is
OTP request -> AUTHTOKEN, exactly like the GSP portal. Full guide, endpoints,
mapping, and go-live steps: [docs/gstn.md](docs/gstn.md). Check status at
`GET /api/gstn/config` or under `integrations.gstn` in System Health.

### AI Copilot via DeepSeek (optional)

The built-in Copilot answers cash/payables/GST questions from live platform
data. Out of the box it uses a deterministic rule engine (zero cost, offline);
set a DeepSeek key to enable **DeepSeek V4 Flash** generation:

```powershell
Copy-Item .env.example .env
# edit .env -> set DEEPSEEK_API_KEY
node server/src/server.js
```

The assistant is grounded in a compact live-data snapshot with guardrails
(scope refusal, view allowlist, strict JSON output, graceful fallback), modeled
on NVIDIA NeMo Guardrails and AI4Finance FinGPT/FinRobot. Full guide:
[docs/ai-assistant.md](docs/ai-assistant.md).

### Tally integration (cloud XML upload)

KhataOS runs in the cloud, so Tally data arrives as **XML exports uploaded in
the app** — no live Tally connection or port-9000 connector. Export Groups,
Ledgers and Vouchers from Tally as XML and upload via the Tally page's
**Import Tally XML** dialog. The parser handles real Tally variants
(`VCHNUM`/`VCHDATE`, attributes, entries-derived amounts), the pipeline
validates every reference (group → ledger → voucher), then imports in the
correct sequence, deduplicated per company. Details:
[docs/tally-connector.md](docs/tally-connector.md).

There is no demo tenant: the database starts empty apart from the supported
bank directory (reference data). Data only enters through the real channels —
Tally XML imports, connected-bank statements, GSTR-2B fetches and forwarded
invoices. Create your own company and users, then connect providers
(see `.env.example`).

### Database engines

The storage layer is engine-swappable — same schema, same API, no code
changes:

| Engine | How to enable | Use for |
| --- | --- | --- |
| SQLite (default) | nothing to do | Zero-setup dev & demo |
| PostgreSQL in-process | `KHATAOS_DB_ENGINE=pglite` | Dev/testing with real Postgres semantics |
| PostgreSQL server | `KHATAOS_DATABASE_URL=postgres://user:pass@host:5432/khataos` | Production (AWS Mumbai, RBI data-localized) |

```powershell
node server/src/server.js                          # SQLite
$env:KHATAOS_DB_ENGINE = "pglite"; node server/src/server.js
$env:KHATAOS_DATABASE_URL = "postgres://…"; node server/src/server.js
```

## Verification

The full suite runs green on SQLite and in-process PostgreSQL:

```powershell
# unit + integration tests (parse, import, recon, GST, security, migrations, fuzz)
node tests\tally.test.js
node tests\recon-three-way.test.js
node tests\recon-three-way.test.js --pg
node tests\smoke.js
node tests\smoke.js --pg
```

`tests/recon-three-way.test.js` pushes data of different types through all
three channels (Tally XML, bank statements, GSTR-2B) and asserts the
reconciliation results; `tests/smoke.js` bootstraps a minimal tenant and
exercises every module end-to-end with real pipeline data.

## Repository map

```text
khataos/
  README.md
  docs/            architecture, PRD, GTM, success metrics, Tally connector
  server/
    src/
      server.js    HTTP server, routing, static web serving
      db.js        SQLite schema (node:sqlite), migrations
      decentro.js  Decentro Connected Banking adapter (real API)
      gstn.js      GSP/GSTN adapter (GSTR-2B fetch + e-invoice IRN contract)
      seed.js      reference-data seed (supported bank directory)
      adapters.js  integration adapters (real-only): AA, bank APIs, gateway,
                   OCR, Tally, GSTN
      auth.js      sessions + role-based access control
      api.js       REST API handlers for all modules
    data/          khataos.db (created at runtime)
  webapp/          React + Tailwind + shadcn-style UI (Vite; build -> dist)
  web/             legacy zero-dependency SPA (fallback when webapp is not built)
  deploy/          production artifacts: Postgres/ClickHouse, AWS notes
  tests/           smoke.js (end-to-end API), decentro.test.js, gstn.test.js
```

## What the MVP deliberately excludes

Cash flow forecasting, FX management, debt/investment tracking, corporate
cards/expense management, multi-entity consolidation, custom ERP integrations
beyond TallyPrime, host-to-host banking, AI recommendations, mobile apps,
supply chain finance, and drill-down analytics. All are Phase 2/3 candidates
and are intentionally absent to protect the 6-month ship date.

## Success metrics this build instruments

See `docs/success-metrics.md`. The product computes reconciliation accuracy,
invoice-to-payment cycle time, and daily active usage from its own data, and
the remaining commercial targets (100 customers at ₹3L ACV, 90% retention,
15+ banks via AA) are tracked in the Metrics page with simulated baselines.

## Production notes

The dev build uses SQLite for zero-friction evaluation. Production targets
PostgreSQL + ClickHouse on AWS Mumbai (RBI data-localization compliant) with
the same API surface — see `deploy/docker-compose.yml`, `deploy/aws-notes.md`,
and the persistence section in `docs/architecture.md`.
