---
name: analyzer-source
description: Manages Analyzer7 data sources and metric definitions — registers sources (type, property, adapter, auth method and names only, timezone, freshness SLA, limitations), ingests provider exports into immutable hashed observation snapshots, records failed fetches, maintains the canonical metric dictionary, and compares sources for discrepancies. Use when the user adds a data source, pulls or uploads an export, defines or confirms a metric, or asks why two systems disagree. Keywords: analyzer, source, registry, ingest, export, adapter, GA4, GSC, Stripe, database, metric dictionary, canonical source, discrepancy.
user-invocable: false
---

# analyzer-source

## Read first

`../analyzer/reference/sources-and-metrics.md` and `../analyzer/reference/authority.md`.

## Register a source

Confirm with the user that the source exists and how it is accessed. Then run `node "<skill-base-dir>/../analyzer/scripts/record.mjs" source --id <id> --type <type> --adapter <adapter> ...`. Store the auth **method** and tool or env-var **names** only; the script refuses secret-looking values. Update fields later with `--update`.

## Ingest

1. Fetch with the provider's own tool (authorized MCP server, export, SQL query, CLI). Analyzer7 scripts make no network calls.
2. Aggregate user-level data to counts before saving; keep PII out.
3. Run `ingest.mjs --source <id> --input <file> [--dimensions ...] [--start --end] [--metric <series>] [--set key=value]`.
4. If the fetch failed, run `ingest.mjs --source <id> --fail "<message>"`. The source shows as unavailable, and analysis degrades explicitly instead of silently reusing old data.

## Metric dictionary

- Add or edit metrics in `.analyzer/metrics.json` following `sources-and-metrics.md`. New project-specific metrics start as `status: proposed`.
- Activate only after the user confirms the definition and the canonical source: `record.mjs metric-status --id <id> --status active --reason "<who confirmed what>"`.
- Changing a definition: bump `version` and append the previous definition to `history` (with date and reason). Evidence records keep the `metric_version` they used.
- Map neighbor names with `aliases` (for example Marketer7's primary-metric name).

## Discrepancies

`analyze.mjs discrepancy --metric <id> --start --end [--record]` shows every source's value with the canonical one marked. `--record` opens an anomaly when sources disagree beyond `discrepancy_tolerance_pct`. Report both numbers and the likely definitional reasons; never average them or pick the convenient one.
