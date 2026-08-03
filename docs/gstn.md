# GSTN / GSP integration (GSTR-2B + e-invoice)

KhataOS can pull **real GSTR-2B data** (the supplier-side filing that drives
input-tax-credit eligibility) through the GSTN taxpayer API, normally via a
GST Suvidha Provider (GSP) that handles the OTP/encryption handshake with
GSTN. The same adapter also models the **e-invoice (IRP)** contract for
generating an IRN on outward invoices.

The adapter lives in `server/src/gstn.js` and implements the real GSP
contract:

```text
KhataOS API ──► GSP taxpayer API ──► GSTN
     │           OTP request      (POST /gus/taxpayerapi/v1.0/otp/request)
     │           AUTHTOKEN        (POST /gus/taxpayerapi/v1.0/authenticate)
     │           GSTR-2B          (GET  /taxpayerapi/v2.0/gstr2b/{gstin}?fp=)
     └──► e-Invoice IRP           (POST /einv/v1.0/irn/generate)
```

It **activates automatically when the environment variables below are set**;
otherwise every endpoint refuses with `503`. No simulated GSTR-2B payloads
exist — data only enters through a real GSP fetch.

## Configuration

| Env var | Required | Meaning |
| --- | --- | --- |
| `GSTN_GSTIN` | yes | The tenant's GSTIN (e.g. `29AABCA1234F1Z5`) — also seeds the state code used in GSP headers |
| `GSTN_USERNAME` | yes | GSTN taxpayer-API username issued by the GSP |
| `GSTN_APP_KEY` | yes | GSTN app key (GSP SDK encrypts this in the OTP/AUTHTOKEN payloads) |
| `GSTN_CLIENT_ID` | yes | GSP-issued client id (sent in headers) |
| `GSTN_CLIENT_SECRET` | yes | GSP-issued client secret (sent in headers) |
| `GSTN_GSP_BASE_URL` | no | GSP base URL; default `https://api.setu.co/gstn` (Setu GSP sandbox). Point at your GSP's production base for live traffic |
| `GSTN_EINVOICE_BASE_URL` | no | IRP base URL; default `https://einvoice1.gst.gov.in` (production IRP) |
| `GSTN_AUTH_PATH` / `GSTN_OTP_PATH` / `GSTN_GSTR2B_PATH` | no | Endpoint overrides; defaults match the standard GSTN/GSP paths above |
| `GSTN_IP_USR` | no | `ip-usr` header value; default `127.0.0.1` |
Example:

```powershell
$env:GSTN_GSTIN = "29AABCA1234F1Z5"
$env:GSTN_USERNAME = "your-taxpayer-username"
$env:GSTN_APP_KEY = "your-app-key"
$env:GSTN_CLIENT_ID = "your-gsp-client-id"
$env:GSTN_CLIENT_SECRET = "your-gsp-client-secret"
node server/src/server.js
```

Check integration status at `GET /api/gstn/config` (also surfaced under
`integrations.gstn` on `GET /api/system/health`, alongside the last GSTR-2B
snapshot).

## Auth flow (OTP → AUTHTOKEN)

GSTN auth is short-lived (~6 h), so the app goes through the same dance a
human finance user does in the GSP portal:

```text
POST /api/gstn/otp/request     → GSP sends SMS/email OTP
POST /api/gstn/otp/validate    → { otp }  → GSP returns auth_token (cached ~6 h)
```

The `auth_token` is cached in-process and attached as the `auth-token` header
on subsequent GSTR-2B / IRN calls. Once a token expires the next fetch fails
with a clear 401-style error asking the operator to re-authenticate. Without
`GSTN_*` credentials every endpoint refuses with `503` - no simulated OTP
references or tokens exist.

## GSTR-2B fetch and mapping

`POST /api/gst/refresh` fetches the current period through the adapter. The
GSP returns a document-shaped payload whose `b2b` block looks like this:

```json
{
  "gstin": "29AABCA1234F1Z5",
  "fp": "072026",
  "b2b": [
    {
      "ctin": "24ACRPP7935N1ZO",
      "docno": "INV-2026-0118",
      "docdt": "02-08-2026",
      "txval": 26250,
      "cgst": 2362.5,
      "sgst": 2362.5,
      "igst": 0,
      "cess": 0,
      "supfildt": "07-08-2026",
      "itcAvailed": { "itcCgst": 2362.5, "itcSgst": 2362.5, "itcIgst": 0 }
    }
  ],
  "cdnr": []
}
```

`mapGstr2b` (unit-tested in `tests/gstn.test.js`) converts each `b2b` row into
the platform snapshot shape and computes the ITC totals that feed the GST
dashboard and the GSTR-2B vs platform-invoice mismatch scan. The snapshot is
persisted to `gstr2b_snapshots` with `source = 'gstn-live'`, which the System
Health page reports.

| GSP field | KhataOS field |
| --- | --- |
| `ctin` | `gstin` (vendor) |
| `docno` / `docdt` | `invoice_no` / `invoice_date` |
| `txval` | `taxable` |
| `cgst` + `sgst` + `igst` | `total_itc` (and per-component columns) |
| `supfildt` | `supplier_filed_on` (visible in the snapshot JSON) |

## e-invoice (IRN) contract

The adapter implements the IRP `generate` call (`/einv/v1.0/irn/generate`)
with a full B2B v1.03 payload (`buildEinvoiceBody`): transaction type B2B,
seller/buyer GSTINs, HSN item list, and value details. It posts to the IRP
and returns the real `irn`, `signed_qr_code`, and `signed_invoice` once
credentials are configured. The MVP keeps this at the adapter level —
outward-invoice e-invoicing is a Phase 2 surface — but the contract is ready
to wire into the invoice UI without backend changes.

## Going live

1. Get GSP credentials (Setu, ClearTax, or another GSP) for the tenant's
   GSTIN, plus the IRP client credentials if you use e-invoice.
2. Set the `GSTN_*` env vars above and restart; confirm `GET /api/gstn/config`
   reports `mode: "live"` and `enabled: true`.
3. Trigger `POST /api/gstn/otp/request`, enter the OTP via
   `POST /api/gstn/otp/validate`, then `POST /api/gst/refresh`.
4. Validate the snapshot totals and mismatch flags against the GST portal for
   one period before enabling scheduled refreshes.

**Production TODO:** persist the `auth_token`/expiry per tenant (currently an
in-process cache — fine for a single-tenant MVP, must move to the database for
multi-tenant); encrypt OTP/app-key handling per GSP SDK requirements; and add
the tenant's GSTIN to the connection form instead of reading it from a single
env var.

## Testing without production keys

`tests/gstn.test.js` covers the GSP mapping against a real fixture, the
unconfigured 503 guards, and the IRN body. The end-to-end suite
(`tests/smoke.js`) exercises the config and guarded endpoints without any
credentials.
