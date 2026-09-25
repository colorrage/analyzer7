# Sources, adapters, and the metric dictionary

## Source registry (`sources.json`)

Never assume a source exists. Register it only after the user confirms access (or a tool call proves it), with:

`node "<skill-base-dir>/scripts/record.mjs" source --id <id> --type <type> --adapter <adapter> [--provider] [--property] [--metrics a,b] [--auth-method env|mcp|oauth|service_account_file|cli|export|none] [--auth-reference "<tool or doc>"] [--env-vars NAME] [--timezone <tz>] [--expected-lag-hours N] [--stale-after-hours N] [--limitations "a|b"]`

| Field | Meaning |
| --- | --- |
| `id` | stable source ID used by metrics and observations |
| `type` | `analytics, search, revenue, product, ranking, performance, crawl, indexation, crm, email, social, logs, harness, custom` |
| `provider`, `property` | the system and the property/account/view |
| `adapter` | the normalizer that turns its exports into observations |
| `auth` | **method and names only**: `method`, `reference` (tool or doc name), `env_vars` (variable names). Values are refused. |
| `metrics` | metrics this source can report |
| `timezone` | the timezone the source uses for day boundaries |
| `freshness` | `expected_lag_hours`, `stale_after_hours` |
| `limitations` | known limitations, in plain words |
| `data_through`, `last_success_at`, `last_attempt_at`, `last_error_at`, `last_error` | maintained by `ingest.mjs` |

Health is computed on every read, never stored:

- `unavailable` — the last attempt failed after the last success.
- `stale` — the data is older than `stale_after_hours`; reported in calendar days.
- `unknown` — never fetched.
- `ok` — otherwise.

Record a failed fetch with `ingest.mjs --source <id> --fail "<message>"` so that degraded analysis is visible.

## Adapters

Adapters normalize an export that another tool already produced. Analyzer7 never embeds a provider SDK, and unit tests never need live APIs.

| Adapter | Kind | Input | Fetch it with |
| --- | --- | --- | --- |
| `gsc` | `gsc_rows` | GSC MCP / API JSON (`rows[].keys` + `--dimensions`) or a CSV export | GSC MCP `search_analytics` / `enhanced_search_analytics` (dimensions `date` for totals, `date,page` for page trends, `query,page` for opportunities), or the Search Console export |
| `seo-rankings-md` | `gsc_rows` | legacy seo-rankings baseline/snapshot markdown (`.hyper/seo/baselines|snapshots`) | nothing — reads existing files in place |
| `rankings` | `rankings` | CSV/JSON: keyword, location, device, engine, position (blank/`>100` = not ranking), url, serp_features, observed_at | any rank tracker export |
| `timeseries` | `timeseries` | CSV `date,metric,value` or `date,value --metric <series>` or wide `date,<series>...` | GA4 export, DB query, Stripe export, CRM/email exports |
| `crawl` | `crawl` | CSV/JSON: url, status, redirect_to, redirect_hops, canonical, title, meta_description, robots, in_sitemap, inlinks | any crawler export |
| `cwv` | `cwv` | CSV/JSON: url/origin, form_factor, lcp_p75_ms, inp_p75_ms, cls_p75, date | CrUX / PageSpeed Insights |
| `indexation` | `indexation` | CSV/JSON: url, coverage_state/verdict, google_canonical, user_canonical, last_crawl | GSC URL inspection / page indexing export |

Run `node "<skill-base-dir>/scripts/ingest.mjs" --source <id> --input <file> [--dimensions ...] [--start --end] [--set country=DEU] [--metric <series>]`. It writes an immutable, hashed snapshot and updates the source's freshness. Headline safety: GSC rows with a `query` or `page` dimension must not be summed into property totals. Adding `page` counts a search once per URL shown, and query rows omit anonymized queries. Totals come from a date-only pull.

## Metric dictionary (`metrics.json`)

A metric is never defined on the fly. Each entry:

| Field | Meaning |
| --- | --- |
| `id`, `label`, `aliases` | stable ID (aliases map neighbor names, for example a Marketer7 KPI name) |
| `status` | `active` (usable), `proposed` (needs human confirmation), `retired` |
| `version`, `history`, `status_history` | a definition change bumps `version` and appends the old definition to `history` |
| `definition` | plain-language definition (numerator/denominator for ratios) |
| `kind`, `unit` | `count, ratio, mean, position, currency`; ratios are stored in `percent` when `scale: 100` |
| `aggregation` | `sum`, `ratio_of_sums` (never an average of ratios), `weighted_mean` (with `weight`), `mean`, `last` |
| `field` / `series` / `numerator` / `denominator` / `weight` | what to read from rows (wide columns for GSC, series names for timeseries) |
| `source_mappings` | per-source overrides, for example `{"ga4": {"series": "sign_up"}, "db": {"series": "completed_registration"}}` |
| `canonical_source`, `fallback_sources` | which source *is* the metric; others are compared, never substituted |
| `discrepancy_tolerance_pct` | allowed disagreement before a discrepancy is surfaced |
| `min_sample`, `overdispersion` | minimum sample for evidence; variance inflation for count tests |
| `direction`, `evidence_grade`, `marketer_tier` | better direction; Marketer7 A–E grade; Marketer7 business-value tier |
| `limitations` | known measurement caveats |

Canonical-source rule: the canonical source's value is the value. When two systems disagree (Stripe 31, GA4 28, DB 30), the value comes from the dictionary's canonical source, and the disagreement is raised as a `source_discrepancy` issue and, on request, an anomaly. Analyzer7 never picks whichever number looks convenient.
