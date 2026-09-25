---
name: analyzer-seo
description: Runs the Analyzer7 SEO subsystem — Search Console overview, top queries/pages, winners/decliners, positions 4–15, high-impression low-CTR queries, cannibalization, content decay, rank-tracker changes, indexation, technical crawl findings, Core Web Vitals, and SEO change impact — as evidence with explicit data gaps. Flags SEO-OPP opportunities for Marketer7 but never rewrites titles, content, or code. Use when the user asks about SEO, rankings, GSC, CTR, cannibalization, indexing, crawl or technical SEO, CWV, or the effect of an SEO change. Keywords: analyzer, seo, search console, gsc, rankings, ctr, cannibalization, indexation, crawl, core web vitals, quick wins, striking distance.
user-invocable: false
---

# analyzer-seo

SEO is a first-class subsystem of Analyzer7, not a separate harness. The ownership chain is fixed: **Analyzer7 diagnoses → Marketer7 decides → Signal7 (content/meta) or Hyper7 (technical) executes → Analyzer7 verifies.**

## Read first

- `reference/seo-model.md` — row models, thresholds, classification, and the rules for totals.
- `../analyzer/reference/evidence-model.md` and `../analyzer/reference/sources-and-metrics.md`.

## Data collection (the provider's tools, then ingest)

Analyzer7 does not call Search Console itself. Use the tools the user has authorized (for example the GSC MCP server's `enhanced_search_analytics` / `search_analytics`), save the response, and ingest it with `node "<skill-base-dir>/../analyzer/scripts/ingest.mjs" --source <gsc-id> --input <file> --dimensions <dims> [--start --end] [--set country=<ISO3>]`:

| Pull | Dimensions | Used for |
| --- | --- | --- |
| property trend | `date` | headline totals, organic trend, monitors (the only headline-safe grain) |
| page trend | `date,page` | page winners/decliners, content decay, page-scoped experiments |
| opportunities | `query,page` for each compared period | top queries, CTR opportunities, positions 4–15, cannibalization, query movement |

Rank-tracker exports go through the `rankings` adapter; crawler exports through `crawl`; CrUX/PageSpeed through `cwv`; URL inspection or page-indexing exports through `indexation`. Existing seo-rankings markdown baselines (`.hyper/seo/baselines/*.md`, `.hyper/seo/snapshots/*.md`) import through the `seo-rankings-md` adapter in place, without rewriting them.

## Operations

| User intent | Command |
| --- | --- |
| full SEO health / audit | `seo.mjs audit [--days 28] --report` (add `--record` to register SEO-OPP opportunities and ranking/CWV anomalies) |
| compare periods / what changed | `seo.mjs compare --before-start --before-end --after-start --after-end [--dimensions query\|page\|query,page]` |
| quick wins | `seo.mjs audit` sections: positions 4–15 and high-impression low-CTR |
| rankings movement | `seo.mjs rankings --source <id> [--record]` (stale snapshots are flagged explicitly) |
| no rank tracker (optional proxy) | pull GSC `--dimensions date,query[,country]`, register a `ranking` source (`--provider gsc_avg_position_proxy`), then `seo.mjs rank-proxy --into <id>`: impression-weighted average position per query for the latest window and the one before, labeled as a proxy |
| technical / CWV / indexation | `seo.mjs technical\|cwv\|indexation --source <id>` |
| behavior context (optional, Clarity) | register a source with `--adapter clarity`, fetch with `connect.mjs clarity` or ingest an export; the audit adds a "Behavior context" section (dead/rage clicks, scroll depth) for top and opportunity pages. It is context only, never evidence |
| did the SEO change work | the `analyzer-experiment` skill (Marketer7 `EX-NNN`) or the `analyzer-evidence` skill (ad-hoc, linked to a `CH-NNN`) |
| hand opportunities to Marketer7 | `exports.mjs opportunities --top 5` (writes `analyzer-opportunity/v1`, marks them `handed_off`); `exports.mjs list` shows what Marketer7 has consumed |
| save a baseline | `record.mjs baseline --metric organic_clicks\|organic_ctr\|... --start --end [--page /x]` |

All commands live in `"<skill-base-dir>/../analyzer/scripts/"` and take `--project <dir>`.

## Rules

- Headline totals come only from date-only pulls. Never sum `query,page` rows into property totals. If no aggregate pull exists, the overview says DATA GAP.
- Normalize per day when windows differ, and prefer equal, weekday-aligned, calendar-aligned windows.
- GSC `avg_position` is an impression-weighted average, not a SERP rank. Keep it separate from rank-tracker positions.
- Cannibalization, CTR, and decay findings are evidence. Do not conclude that consolidation or a rewrite is correct.
- When a source cannot prove something (index status of a URL absent from the rows, rankings older than the SLA), say so.
- Content churn inside a measurement window destroys attribution. Recommend (to Marketer7) that SEO-relevant changes are registered through the `analyzer-change` skill before they ship.
- Market or segment specifics (country filters, URL prefixes, tiers) live in `.analyzer/seo/config.json` `segments`, never in this skill.
- Rank tracking and Clarity are optional. A project without them sees "not configured (optional)", not a data gap.
