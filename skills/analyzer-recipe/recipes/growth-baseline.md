---
name: growth-baseline
description: Establish current baselines for every confirmed growth metric with data quality, and record them as BL records for later comparisons.
---

# Growth baseline

1. Probe state. Confirm that the growth metrics exist and are `active`; confirm proposed ones with the user or leave them out.
2. Make sure every metric's canonical source has fresh data for the last 56 days; ingest what is missing.
3. Run `analyze.mjs audit --scope growth --days 28 --record-baselines --report`.
4. List the baselines recorded, the metrics that were insufficient (and why), and the discrepancies between sources.
5. Update `context.md` "Important metrics" with the baseline IDs.
