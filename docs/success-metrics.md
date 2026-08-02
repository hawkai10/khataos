# Success Metrics

Defined before code (per spec). The product instruments what it can from its
own data; commercial targets are tracked in the Metrics page against
simulated baselines in this MVP.

## Targets

| Metric | Target | Where tracked |
| --- | --- | --- |
| Paying customers (6 months post-launch) | 100 | Metrics page (external pipeline input) |
| Average contract value | ₹3,00,000 / year | Metrics page |
| Retention at 6 months | > 90% | Metrics page |
| Banks reachable via AA + direct APIs | ≥ 15 | Metrics page + Bank directory |
| Tally sync uptime | ≥ 99.5% | Tally health module (last-30-day uptime) |
| Automatic bank reconciliation accuracy | ≥ 70% | Reconciliation module (live score) |
| Invoice-receipt to payment-execution time | −50% vs manual baseline | AP module (computed cycle time vs baseline) |
| Daily active usage | ≥ 60% of active users log in daily | Metrics page (DAU/MAU from sessions) |

## How this build computes them

- **Recon accuracy** = matched bank transactions ÷ total bank transactions in
  the window, split by automatic (exact/fuzzy/combined) vs manual.
- **Cycle time** = days from invoice capture to payment completion, averaged
  over the last 30 days, compared against a seeded "manual baseline" of
  11.2 days for the demo tenant.
- **DAU/MAU** = distinct users with sessions on the day / distinct users in
  the month. The demo seeds a 30-day login history; real logins from this
  dashboard update it.
- **Tally uptime** = successful sync heartbeats ÷ expected heartbeats over 30
  days (simulated with realistic 99.6–99.8% pattern).

## North-star framing

The engagement metric matters most: **60% daily active users** is what proves
the product is embedded in the morning workflow, not a weekly report. Every
module is designed so the CFO and the finance exec each have a daily reason to
open it (morning cash + approvals; invoice capture + payment execution).
