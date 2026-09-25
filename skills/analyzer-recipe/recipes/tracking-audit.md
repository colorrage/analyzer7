---
name: tracking-audit
description: Check tracking integrity — source health, missing days, sudden zeros, duplicates, timezone and schema mismatches, cross-source discrepancies, and tracking changes.
---

# Tracking audit

1. Probe state; list sources with their health, `data_through`, and last errors.
2. Ingest the last 56 days for each tracked metric from every source that reports it.
3. Run `analyze.mjs audit --scope tracking --report`.
4. Run `analyze.mjs discrepancy` for each metric with more than one source.
5. Run `analyze.mjs monitor` to preview tracking-break alerts.
6. List the tracking changes registered in the period (`changes/index.md`, type `tracking_change`) and ask whether any unregistered tracking change happened.
7. Hand-off: tracking fixes are Hyper7's; Analyzer7 re-verifies after the fix with a fresh audit.
