# Product Requirements — MVP

## Positioning

For Indian mid-market CFOs (₹50–₹500 crore revenue) who currently run cash in
a banking portal or Excel, AP in Tally plus email, payments through NetBanking
and a payment link app, and GST in a filing tool — KhataOS is the single
operating surface for treasury, payables, payments, and compliance. The MVP's
job is to prove the unified model with **visibility first**: connect the first
bank in 15 minutes and show a consolidated cash picture that no point solution
provides.

## Module scope (MVP)

### 1. Real-time multi-bank cash visibility
- AA framework as primary source (ICICI, HDFC, Axis, Kotak, Yes Bank, SBI
  where available); direct corporate APIs for ICICI/HDFC as fallback.
- Total available cash, uncleared funds, 7-day transaction history, 30-day
  daily closing-balance trend.
- **Excluded:** forecasting, FX, debt/investment. Visibility only.

### 2. AP automation with Indian workflows
- Capture: email forwarding, PDF upload, manual entry.
- OCR tuned for Indian invoices: GSTIN, HSN, CGST/SGST/IGST, bilingual text.
- Multi-level approvals with configurable thresholds (₹1L → CFO).
- Two-way TallyPrime sync: approval creates purchase voucher; payment status
  syncs back.
- Three-way match (PO / invoice / receipt) using Tally data when present.
- **Excluded:** full PO module — POs live in Tally.

### 3. Vendor payment execution
- UPI, IMPS, NEFT, RTGS via RazorpayX (then Cashfree) orchestration.
- Batch creation, future scheduling, instant execution.
- Automatic GST ledger + TDS section tagging from vendor master.
- Status tracker: pending → processing → completed / failed.
- **Excluded:** card issuance, expense management.

### 4. Automatic bank reconciliation
- Match AA bank transactions vs Tally vouchers and platform payments by
  amount, date, reference; fuzzy match for partial/combined payments.
- Unmatched view with manual match / voucher creation.
- Accuracy score surfaced in the UI. Target: 70% automatic.

### 5. GST & statutory tracking
- GSTR-2B/2A-based ITC visibility, pending liabilities from approved invoices,
  mismatch flags, and formatted export for ClearTax/Tally.
- **Excluded:** filing. We export; ClearTax/Tally files.

### 6. CFO dashboard
- Four morning questions: cash, due payments, GST risk, runway.
- 5–7 KPIs only, real-time.

### 7. TallyPrime deep integration
- On-premise Windows connector service; ODBC + XML; sync ledgers, vouchers,
  invoices, receipts, payments; queue in single-user mode; health dashboard.
- TallyPrime Release 2.1+; no cloud Tally in MVP.

## Non-functional requirements

- Onboarding: first bank connected + cash visible in **≤15 minutes**.
- Web app must work well on tablets for approvals.
- Event-driven ingestion so slow adapters never block the UI.
- RBI data localization: all production data in AWS Mumbai.
- RBAC with CFO/Admin, Finance Manager, Finance Executive.

## Explicit exclusions (Phase 2/3)

Cash flow forecasting/predictive analytics, FX management, debt & investment
tracking, corporate cards & expenses, multi-entity consolidation, custom ERP
integrations beyond TallyPrime, host-to-host banking, AI recommendations,
mobile apps, supply chain finance, drill-down reporting.

## Demo data conventions

All money in INR, Indian date formats, realistic narrations ("NEFT NACH",
"UPI/XYZ123456789", "CHQ NO 778812"), GSTINs of form `29AABCA1234F1Z5`,
10-digit HSN codes, TDS sections (194C contractor, 194J professional,
194H commission). Current date in the demo follows the system clock, so
overdue/due states always look real.
