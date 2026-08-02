# TallyPrime Connector (MVP)

## Shape

A lightweight **Windows service** installed on the customer's Tally server.
It talks to TallyPrime (Release 2.1+) over the local ODBC interface and XML
export/import, and to the KhataOS cloud API over HTTPS.

## Data flows

```text
Tally (ODBC/XML)  ⇄  Connector service  ⇄  KhataOS API (TLS, API key)

Pull:   ledgers, purchase vouchers, POs, receipt notes, payments, GSTR-2B export
Push:   purchase voucher on invoice approval, payment status on completion,
        vendor master updates
```

## Single-user mode handling

- The connector polls for the Tally data directory lock; if Tally is in
  single-user mode (file busy), operations are **queued** with exponential
  backoff and retried — never dropped.
- Queue depth and oldest queued item are visible in the Tally health dashboard.
- Conflicts are surfaced as sync errors with a retry button, never silently
  discarded.

## Health contract

Heartbeat every 60 s: `{lastSyncAt, lastSuccessAt, status, queueDepth,
version, mode}`. The dashboard derives uptime and flags stale syncs.

## Installer

The white-glove tier installs this for ₹50k; the self-serve path ships an MSI
with a guided checklist: run installer → point to Tally data dir → test ODBC →
map ledgers → first sync. The Onboarding page in this MVP mirrors that
checklist.
