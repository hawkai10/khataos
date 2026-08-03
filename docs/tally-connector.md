# Tally Integration (cloud XML upload)

KhataOS runs in the cloud, so it never talks to Tally over a LAN port. The
supported (and only) data path is **file-based**: the user exports Groups,
Ledgers and Vouchers from Tally as XML and uploads the file. No live Tally
connection, no port-9000 connector, no ODBC — by design.

```text
Tally  ──Export Data → XML──►  upload (web UI / API)  ──►  validate  ──►  import
       groups + ledgers + vouchers                     Groups → Ledgers → Vouchers
```

## Exporting from Tally (one-time per upload)

1. Open the company in TallyPrime.
2. **Masters** — Gateway of Tally → Export Data → Masters → choose Groups and
   Ledgers, output format **XML**.
3. **Vouchers** — Gateway of Tally → Export Data → Voucher Register, set the
   date range, output format **XML**.
4. Upload the resulting `.xml` file(s) in the app: **Tally → Import Tally
   XML**, or `POST /api/tally/import-xml` with `{ "xml": "<envelope>…" }`.

> Upload masters and vouchers together (or masters first) so every reference
> resolves — voucher-only exports import only vouchers whose ledgers already
> exist in KhataOS.

## Parser (server/src/tally.js)

The parser is tolerant of real Tally exports, which vary by release and export
type:

| Tally variant | Accepted forms |
| --- | --- |
| Voucher number | `<VOUCHERNUMBER>` or `<VCHNUM>` |
| Voucher date | `<DATE>` or `<VCHDATE>`, `YYYYMMDD` or `YYYY-MM-DD` |
| Voucher type | `<VOUCHERTYPENAME>` or the `VCHTYPE` attribute |
| Amount | voucher-level `<AMOUNT>` outside entries/inventory lists, else the party-ledger entry, else the largest entry (ties -> positive) |
| Party | `<PARTYLEDGERNAME>` or `<PARTYNAME>` |
| Entries | `<LEDGERENTRIES>` + `<LEDGERENTRY>` (nested), `<LEDGERENTRIES.LIST>` (flat, one block per entry), or `<ALLINVENTORYENTRIES.LIST>` accounting allocations |
| Entry flags | `ISDEEMEDPOSITIVE` (debit/credit side) and `BILLALLOCATIONS.LIST` refs (Agst Ref) per entry |
| Identity | `<GUID>` + `<ALTERID>` on groups/ledgers/vouchers, used for upsert (edit detection on re-export) |
| Tag casing | case-insensitive; `<GROUP>`, `<Ledger>`, `<VOUCHER>` all accepted |
| Company | `<COMPANY><NAME>` or `<STATICVARIABLES><SVCURRENTCOMPANY>` (voucher-register exports) |
| Encoding | XML entities decoded (`&amp;` → `&`), BOM tolerated, `<ENVELOPE>` wrapper optional |

It never throws on malformed input — unparseable records are reported by the
validator and skipped, never silently dropped.

### Verified against Tally's official sample XML

The structures above were checked against Tally's official docs at
`help.tallysolutions.com/sample-xml/`:

- Masters use `<GROUP Action="Create"><NAME>...</NAME><PARENT>...</PARENT></GROUP>`
  and `<LEDGER Action="Create"><NAME>...</NAME><PARENT>...</PARENT></LEDGER>` -
  **PARENT (the group a ledger belongs to) is mandatory in Tally's schema**.
- Tally's own examples mix tag casing (`<Ledger NAME="..." Action="Alter">`) and
  carry address/GSTIN fields on ledgers (`<ADDRESS.LIST>`, `<PINCODE>`,
  `<LEDSTATENAME>`, `<GSTIN>` ...) - the parser is case-insensitive and ignores
  fields it does not need.
- The import response shape is `<RESPONSE><CREATED>...</CREATED><ERRORS>...</ERRORS>
  </RESPONSE>`, matching the counts the API returns after an upload.

Because a ledger without a group is invalid in Tally, the validator emits a
warning when an uploaded ledger has no `PARENT` (import still proceeds - it is
recoverable data, not a reference error).

## Validate + import (server/src/tally-import.js)

`POST /api/tally/import-xml` (CFO / Finance Manager) runs:

1. **Parse** — extract `COMPANY`, `GROUP`, `LEDGER`, `VOUCHER` records.
2. **Validate** — every reference must resolve:
   - ledger `PARENT` group must exist (in this export or already imported),
   - voucher party / entry ledgers must be known ledgers,
   - voucher-only exports: missing party / entry ledgers are auto-created
     under standard Tally groups (name- and voucher-type based: Bank Accounts,
     Sundry Debtors/Creditors, Duties & Taxes, ...) and each is returned as a
     warning so the finance team can verify the mapping,
   - every voucher's debit and credit legs must balance (`ISDEEMEDPOSITIVE`);
     an unbalanced voucher is rejected with a specific error
     (e.g. "Voucher SL/24-25/001 unbalanced: debit ₹116,125 / credit ₹110,000")
     and skipped, never force-imported,
   - dates and amounts must be parseable, GSTINs must match the 15-character
     format (non-matching GSTINs are warnings, not errors).
   Invalid records are reported with a reason and skipped.
3. **Import in sequence** — Groups → Ledgers → Vouchers into
   `tally_groups`, `tally_ledgers`, `tally_vouchers`, upserted by Tally
   GUID + ALTERID (fallback: name / number+date). A re-export with edits
   updates the row in place and counts as "Updated"; true duplicates count as
   "Skipped". The UI shows Parsed / Imported / Updated / Skipped.

The UI shows parsed / imported / skipped counts plus every validation error
and warning. Imports are audit-logged (`tally.xml_import`) and recorded in the
Tally sync log.

## Vendor to Tally ledger mapping

Every vendor carries a Tally `ledger_name` - payments use it as the GST ledger
and invoice capture uses the vendor's TDS treatment. After a successful XML
import (and on demand), KhataOS auto-matches vendors to the imported ledgers:

- match priority is enforced in code: **GSTIN exact -> name exact -> fuzzy**,
- only GSTIN or exact-name matches auto-apply; fuzzy name matches always land
  in the review queue regardless of score,
- name matching strips Tally group prefixes (`Sundry Creditors - ...`) and
  legal suffixes (`Pvt Ltd`, `LLP`, `& Co`),
- on every import a re-check flags vendors whose mapped ledger is no longer
  in the imported chart as **re-map** (dangling) instead of leaving them
  pointing nowhere.

Review lives in the **Vendor to Tally ledger mapping** card on the Tally page
(dropdown per vendor + save). API: `GET /api/tally/mappings`,
`POST /api/tally/mappings/auto`, `POST /api/tally/mappings` (CFO / Finance
Manager only). Every import runs auto-map and returns `mapping.updated`.

## What the imported data now drives

- **Reconciliation** matches bank transactions against the real imported
  Tally vouchers: BILLALLOCATIONS ref first (a ref with a different amount is
  recorded as a mismatch, never force-matched), then amount + date + party.
  Matches are labelled in the UI: "Matched against Tally voucher #X" vs
  "Matched against KhataOS invoice" - only the former is authoritative.
- **GST**: `gst.refresh` also compares imported Tally purchase vouchers
  against the GSTR-2B snapshot (invoice ref, party GSTIN, amount).
- **Payables aging**: `/api/payables/aging` buckets imported Tally purchase
  vouchers into 0-30 / 31-60 / 61-90 / 90+ days on the Payables page.
- **Pull ledgers** re-runs auto-mapping from the imported masters and reports
  real ledger + mapped counts (no simulation).

## Production TODOs

- Swap the dependency-free parser for `fast-xml-parser` once real exports have
  been sampled across TallyPrime releases (report/export shapes vary).
- Wire live GSTN credentials when available; the adapter refuses (503) until
  `GSTN_*` env vars are set (no mock payloads exist).
- Add master deletion semantics on re-export (imports upsert but never remove
  masters that disappeared from Tally).
