# KhataOS — Unified Finance Operating Platform (MVP)

KhataOS is a single dashboard for Indian mid-market CFOs and finance teams
(₹50–₹500 crore annual revenue) covering real-time multi-bank cash visibility,
accounts payable, vendor payment execution, automatic bank reconciliation,
GST compliance tracking, and TallyPrime sync — built native to the Indian
financial ecosystem, not a global TMS retrofitted for India.

This repository contains the **runnable MVP**: a zero-dependency Node.js
backend (SQLite via `node:sqlite`) and a responsive single-page web app. All
external integrations (Account Aggregator, ICICI/HDFC direct APIs,
RazorpayX/Cashfree, TallyPrime, GSTN) are implemented behind real adapter
interfaces with **simulated adapters** preloaded, so the entire product can be
demonstrated end-to-end without credentials. Swapping a simulator for the real
provider is a contained change (see `docs/architecture.md`).

---

## Quick start

Requirements: **Node.js 22+** on Windows, macOS, or Linux. No `npm install`
needed.

```powershell
cd khataos
node server/src/server.js
```

Open <http://localhost:8080> and log in with one of the demo users:

| Role | Email | Password | Can do |
| --- | --- | --- | --- |
| CFO / Admin | `cfo@acme.in` | `demo1234` | Everything, including > ₹1L approvals |
| Finance Manager | `manager@acme.in` | `demo1234` | Approve invoices ≤ ₹1L, payments ≤ ₹5L, reconcile |
| Finance Executive | `exec@acme.in` | `demo1234` | Capture invoices, create/schedule payments, view |

The database is auto-seeded on first run with a demo company (Acme Industries,
GSTIN `29AABCA1234F1Z5`), 6 bank accounts across 5 banks, 30 days of cash
history, vendors, invoices in every workflow state, payments, GSTR-2B data,
and Tally sync state — everything needed to demo all 7 modules immediately.

Reset the demo at any time by deleting `server/data/khataos.db` and restarting.

## 2-minute demo script

1. **CFO dashboard** — the four morning questions: cash, due payments, GST
   risk, runway.
2. **Cash** — 6 accounts, live balances, uncleared funds, 30-day trend,
   "Connect a bank" (simulated AA consent flow, ~15-minute onboarding
   promise).
3. **Payables** — capture an invoice (simulated email forward / upload / manual),
   watch OCR extract Indian fields, approve (see the ₹1L CFO rule trigger),
   three-way match with Tally PO/receipt data.
4. **Payments** — schedule a batch (NEFT/IMPS/UPI/RTGS), watch the gateway
   simulator move it pending → processing → completed, with GST ledger and
   TDS tagging.
5. **Reconciliation** — auto-match score, review unmatched, manual match.
6. **GST** — ITC position, liabilities from approved invoices, GSTR-2B
   mismatches, export CSV for ClearTax/Tally.
7. **Tally** — integration health, sync queue, voucher creation on approval.

## Repository map

```text
khataos/
  README.md
  docs/            architecture, PRD, GTM, success metrics, Tally connector
  server/
    src/
      server.js    HTTP server, routing, static web serving
      db.js        SQLite schema (node:sqlite), migrations
      seed.js      deterministic demo data generator
      adapters.js  integration adapters (simulated): AA, bank APIs, gateway,
                   OCR, Tally, GSTN
      auth.js      sessions + role-based access control
      api.js       REST API handlers for all modules
    data/          khataos.db (created at runtime)
  web/             responsive SPA (no build step)
  deploy/          production artifacts: Postgres/ClickHouse, AWS notes
  tests/smoke.js   end-to-end API smoke test
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
