---
name: seo-audit
description: Evidence-first SEO health audit — data availability, GSC overview and trend, top queries/pages, winners/decliners, positions 4–15, low-CTR queries, cannibalization, indexation, technical, CWV, ranking changes, recent SEO changes, confounders, opportunities, and data gaps.
---

# SEO audit

1. Probe state and list the SEO-related sources and their health. Name any missing source as a data gap now.
2. With the user, pull fresh exports through the authorized tools for equal 28-day windows (the current window and the previous one): GSC `date` (totals), `date,page` (page trends), and `query,page` (opportunities) for each period. Add a rank-tracker export, a crawl, CrUX/PageSpeed, and page indexing where available. Ingest each through the `analyzer-source` skill.
3. Import changes so the audit sees what shipped: `discover.mjs --import-changes`.
4. Run `seo.mjs audit --report`. Review the data gaps first, then the opportunities.
5. With the user's agreement, re-run with `--record` to register SEO-OPP opportunities and ranking/CWV anomalies (duplicates of open records are skipped).
6. Write the report's Interpretation section (observation vs interpretation; no causation beyond the evidence).
7. Hand-off summary: opportunities for Marketer7 to decide on; technical findings with Hyper7 as owner. Nothing is changed on the site.
