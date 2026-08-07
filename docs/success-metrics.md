# Success Metrics

Defined before code (per spec). The product instruments what it can from its
own data; anything it cannot compute reports an explicit `unavailable` status
in the Metrics page — no simulated baselines.

## Targets

| Metric | Target | Where tracked |
| --- | --- | --- |
| Paying customers (6 months post-launch) | 100 | Metrics page (needs a sales/CRM source; reported `unavailable` until then) |
| Average contract value | ₹3,00,000 / year | Metrics page (reported `unavailable`) |
| Retention at 6 months | > 90% | Metrics page (reported `unavailable`) |
| Banks reachable via AA + direct APIs | ≥ 15 | Metrics page (count of connected bank accounts — real) + Bank directory |
| Tally sync uptime | ≥ 99.5% | Tally health module (reported `unavailable` — no live Tally connection in the cloud build) |
| Automatic bank reconciliation accuracy | ≥ 70% | Reconciliation module (live score) |
| Invoice-receipt to payment-execution time | −50% vs manual baseline | AP module (computed cycle time; baseline comparison is not computed) |
| Daily active usage | ≥ 60% of active users log in daily | Metrics page (DAU/MAU from real sessions) |

## How this build computes them

- **Recon accuracy** = matched bank transactions ÷ total bank transactions in
  the window, split by automatic (exact/fuzzy/combined) vs manual.
- **Cycle time** = days from invoice capture to payment completion, averaged
  over the last 30 days. The old "11.2-day manual baseline" comparison was an
  invented number and is removed; only the measured cycle time is reported.
- **DAU/MAU** = distinct users with sessions on the day / distinct users in
  the month. Real logins update it; there is no seeded login history.
- **Tally uptime** is not computed: the cloud build has no live Tally
  connection to observe, so `uptime_30d` stays null and the UI shows
  `Unavailable` rather than a fabricated SLA.
- **Customer, pipeline, retention and ACV** need a sales/CRM source this build
  does not have — the Metrics page returns `customers.status: "unavailable"`.

## North-star framing

The engagement metric matters most: **60% daily active users** is what proves
the product is embedded in the morning workflow, not a weekly report. Every
module is designed so the CFO and the finance exec each have a daily reason to
open it (morning cash + approvals; invoice capture + payment execution).
