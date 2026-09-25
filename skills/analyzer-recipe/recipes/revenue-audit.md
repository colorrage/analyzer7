---
name: revenue-audit
description: Audit revenue and payment metrics against their canonical source (usually Stripe), surfacing discrepancies with analytics and the application database.
---

# Revenue audit

1. Confirm the revenue metrics (paid conversions, revenue, active subscriptions, retained paid users) with their canonical sources — Stripe or the DB, depending on the definition.
2. Ingest aggregated daily exports from Stripe, the DB, and GA4 purchase events (counts and amounts only; no customer-level rows).
3. Run `analyze.mjs audit --scope revenue --report`.
4. For each revenue metric with fallback sources, run `analyze.mjs discrepancy --metric <id> --start --end --record`.
5. Report the canonical values, the discrepancies with likely definitional causes (refunds, trials, time zones, consent loss), and the data gaps. Do not reconcile numbers by averaging.
