# Decentro Connected Banking integration

KhataOS can fetch **real bank balances and statements** through
[Decentro](https://www.decentro.tech/)'s Connected Banking module (Business
Accounts), instead of the simulated feed. Decentro aggregates multiple Indian
banks behind one API, which fits the MVP's "connect the first bank in 15
minutes" goal and lets one integration cover many banks.

## How it fits the architecture

```text
KhataOS API ──► Decentro Connected Banking ──► linked bank account
     │            GET /v2/banking/account/{acc}/balance
     └── adapter  GET /v2/banking/account/{acc}/statement?from=&to=
                  headers: client_id · client_secret · module_secret · provider_secret
```

The adapter lives in `server/src/decentro.js` and implements the same
provider interface as the simulator. It **activates automatically when the
environment variables below are set**; without them the product falls back to
the deterministic demo feed, so the repo always runs.

## Configuration

| Env var | Required | Meaning |
| --- | --- | --- |
| `DECENTRO_CLIENT_ID` | yes | Decentro-assigned client id |
| `DECENTRO_CLIENT_SECRET` | yes | Decentro-assigned client secret |
| `DECENTRO_MODULE_SECRET` | yes | Secret for the Banking module |
| `DECENTRO_PROVIDER_SECRET` | per provider | Secret for the chosen bank provider (add one per provider in production) |
| `DECENTRO_BASE_URL` | no | Default `https://in.staging.decentro.tech` (sandbox). Point to Decentro's production base for live traffic |
| `DECENTRO_CUSTOMER_ID` | no | Default Decentro customer/consumer ID for the tenant (also settable per link request) |
| `DECENTRO_LINK_STATUS_PATH` | no | Override for the Check Linkage Status endpoint; default `/v2/banking/account/{account_number}/link/status` |

Example:

```powershell
$env:DECENTRO_CLIENT_ID = "your-client-id"
$env:DECENTRO_CLIENT_SECRET = "your-client-secret"
$env:DECENTRO_MODULE_SECRET = "your-banking-module-secret"
$env:DECENTRO_PROVIDER_SECRET = "provider-secret"
node server/src/server.js
```

Then in the app: **Cash & Banks → Connect a bank → choose "Decentro Connected
Banking"** and complete the guided connect flow.

Check integration status at `GET /api/integrations/decentro/status`.

## Connect flow (self-serve account linking)

```text
User:  KhataOS form (account no, name, IFSC, PAN, mobile, provider params)
         │ POST /api/decentro/link
         ▼
Decentro: POST /v2/banking/account/{accountNumber}/link
         │  returns redirect URL to the bank's internet banking portal
         ▼
User:  opens portal → logs in → approves Connected Banking consent → OTP
         │
         ├─► Decentro triggers Account Linkage Status Callback
         │        → KhataOS webhook POST /api/decentro/webhook (auto-activates)
         └─► KhataOS polls POST /api/decentro/link/status (fallback)
         ▼
KhataOS: finalizeLink() creates the bank account (source: decentro),
         pulls balance + 90-day statement, runs reconciliation
```

The Link API requires provider-specific parameters — ICICI needs
`corp_id`, `user_id`, and optionally `alias_id` (the `user_id` must have admin
privileges for the link to go through). The wizard renders these fields based
on the selected bank.

### Webhook (Account Linkage Status Callback)

Decentro calls the callback endpoint shared with them at onboarding whenever
an account is linked or unlinked. KhataOS exposes it at:

```
POST /api/decentro/webhook
```

Payload fields per Decentro's docs: `mobile`, `customer_id`, `account_number`,
`status`. The handler is idempotent, always answers `200` (so Decentro doesn't
retry), looks up the pending link by account number, activates the account,
pulls the statement, and records an audit event (`bank.linked_decentro_webhook`).

**Production TODO:** in a multi-tenant deployment, map Decentro's
`customer_id` to the KhataOS company (the MVP uses the pending-link table and
falls back to the single tenant). Add webhook signature verification once
Decentro confirms the signing scheme for this callback.

### Endpoints added by the connect flow

| Endpoint | Purpose |
| --- | --- |
| `POST /api/decentro/link` | Calls the Link API with account + provider params, stores a pending link, returns `redirect_url` |
| `POST /api/decentro/link/status` | Polls Check Linkage Status; activates the account when linked |
| `POST /api/decentro/webhook` | Handles Decentro's Account Linkage Status Callback (auto-activation) |
| `POST /api/decentro/refresh` | Pulls the last 7 days for all Decentro-linked accounts |

## Endpoints used

### Balance

```
GET /v2/banking/account/{accountNumber}/balance
```

Returns `data.presentBalance`.

### Statement

```
GET /v2/banking/account/{accountNumber}/statement?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Returns `data.statement[]` with `timestamp`, `description`, `depositAmount`,
`withdrawalAmount`, `balance`, `bankTransactionId`, `type`. The adapter maps
these to `bank_transactions`:

| Decentro field | KhataOS field |
| --- | --- |
| `timestamp` | `txn_date`, `value_date` |
| `depositAmount − withdrawalAmount` | `amount` (signed) |
| `balance` | `balance_after` |
| `description` | `description` (+ mode inference: UPI/IMPS/NEFT/RTGS/CHQ/ATM) |
| `bankTransactionId` | `external_id`, `ref_no` (idempotency) |

## Production notes

- **Account linking**: implemented end-to-end above — Link API → bank portal
  redirect → OTP approval → status polling and/or webhook activation. The
  webhook URL must be registered with Decentro at onboarding.
- **Pagination**: some statement endpoints return 10 records per page in
  reverse-chronological order. The MVP fetches 90 days in one window; before
  launch, page through windows (the adapter's `fetchStatement` is the single
  place to change).
- **Consent & localization**: connected-banking access is consent-based; keep
  the audit trail of each link (already recorded as `bank.linked_decentro`).
  All data stays in AWS Mumbai (`ap-south-1`) per RBI localization.
- **Reconciliation**: Decentro statements don't always include the platform
  UTR, so recon matches on amount + date window first, then exact reference
  when present — exactly what `server/src/recon.js` implements.

## Testing without production keys

Decentro's staging environment ships simulated accounts and accepts the
credentials issued on their dashboard. With those env vars set, the whole
connect flow runs against `in.staging.decentro.tech`; the mapping logic is
covered by `tests/decentro.test.js` against a fixture from their docs.
