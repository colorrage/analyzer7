---
name: analyzer-audit
description: Runs Analyzer7 AUDIT mode — a deep baseline of growth, revenue, or tracking health from registered sources, with data quality per metric, source discrepancies, data gaps, registered changes as candidate explanations, and an evidence-confidence statement. Use when the user asks for a baseline, an audit, "how are we doing", tracking health, or a monthly review; for SEO audits invoke the analyzer-seo skill. Keywords: analyzer, audit, baseline, growth audit, revenue audit, tracking audit, data gaps, health check.
user-invocable: false
---

# analyzer-audit

AUDIT establishes where things stand and how far the numbers can be trusted. It does not attribute changes: audit comparisons have no linked change, so causal confidence is `none` by construction.

## Read first

`../analyzer/reference/evidence-model.md`, `../analyzer/reference/sources-and-metrics.md`, `../analyzer/reference/reporting.md`.

## Steps

1. Probe state (`node "<skill-base-dir>/../analyzer/scripts/state.mjs"`). Note unavailable, stale, and unknown sources before reading any metric.
2. Pick the scope: `growth` (all active metrics), `revenue` (payment/willingness/retention tiers or currency units), or `tracking` (the same metrics, read for integrity: gaps, zeros, discrepancies, timezone and schema issues). For SEO, invoke the `analyzer-seo` skill instead.
3. If data is missing, ask the user to fetch the export with the provider's tool (GSC MCP, GA4, DB query, Stripe) and ingest it through the `analyzer-source` skill. Do not proceed on imagined values.
4. Run `node "<skill-base-dir>/../analyzer/scripts/analyze.mjs" audit --scope <scope> [--days 28] --report`. Add `--record-baselines` when the user wants the current window stored as baselines (BL records).
5. For metrics with more than one source, the audit already checks the canonical source against the fallbacks. For a specific period, run `analyze.mjs discrepancy --metric <id> --start --end [--record]`.
6. For a configured funnel, run `analyze.mjs funnel --funnel <id> --start --end`. Unconfirmed stages are excluded, not guessed.
7. Write the report's `Interpretation` section within `reporting.md`. Findings that need a decision go to Marketer7; technical tracking fixes go to Hyper7.

## Output to the user

Current baseline, tracking health, major problems, data gaps, anomalies (monitor preview), candidate explanations, and the evidence confidence statement, each with the report path.
