# Analyzer7 data model

Markdown records use flat `key: value` YAML frontmatter with `schema_version: 1`. That is the strict subset Marketer7's parser accepts. Structured registries and observation rows are JSON. Each fact has exactly one canonical home. Indexes are append-only pointers, not copies.

```text
.analyzer/
  project.md                 project name, analysis timezone, authority (read_only)
  context.md                 living big picture: product, funnel, sources, SEO segments, neighbor state, open questions
  memory.md                  sparse measurement lessons with provenance
  sources.json               source registry (see sources-and-metrics.md)
  metrics.json               metric dictionary and funnels
  monitors.json              monitor rules (MONITOR mode)
  seo/config.json            SEO property, segments, thresholds, expected-CTR curve
  observations/<source>/     immutable normalized snapshots (gzip JSON, hashed); pruned.md tombstones
  evidence/EV-NNN-*.md       evidence ledger + index.md
  changes/CH-NNN-*.md        change registry + index.md
  baselines/BL-NNN-*.md      baselines + index.md
  anomalies/AN-NNN-*.md      anomalies + index.md
  seo/opportunities/SEO-OPP-NNN-*.md   opportunities + index.md
  experiments/EX-NNN/plan.md measurement plan for a Marketer7 experiment
  exports/EX-NNN/*.md        outgoing external-evidence-reference/v1 files
  reports/<date>-<mode>-<scope>.md     AUDIT / MONITOR / MAINTAIN outputs
  recipes/*.md               project-local recipes (override built-ins by name)
```

## Mutability

| Artifact | Rule |
| --- | --- |
| observations | Immutable, stored gzip-compressed (`.json.gz`). `rows_sha256` is verified by validation. A re-pull writes a new snapshot; for each day, the most recently retrieved snapshot wins. `analyze.mjs compact` gzips older uncompressed snapshots after verifying their hash; references to `x.json` resolve to `x.json.gz`. With `--prune-unreferenced --older-than-days N`, snapshots that no record mentions and that are not the newest of their source and kind are removed, each leaving a tombstone line with its hash in `observations/pruned.md`. |
| evidence, changes, baselines | Append-only. A correction is a new record with `supersedes: <ID>`. The earlier record is never edited or deleted. |
| anomalies, opportunities, plans | Living status. A status change updates frontmatter `status` and appends a line to `## Status history`. |
| registries (`sources.json`, `metrics.json`, `monitors.json`, `seo/config.json`) | Living configuration. A metric definition change bumps `version` and keeps the prior definition in `history`. Status changes append to `status_history` with a reason. |
| `context.md`, `memory.md` | Living, human-correctable. Memory entries are append-only. |

## Evidence record (EV)

Frontmatter: `id, title, status, kind (comparison | experiment_evaluation), recorded_at, metric, metric_version, unit, source_ids, period_before_start/end, period_after_start/end, before_value, after_value, basis (total | per_day), delta_abs, delta_pct, data_quality, evidence_strength, causal_confidence, evidence_grade (Marketer7 A–E), threshold_result, criteria_basis (review_lock | override CO-NNN | criteria_changed | criteria_not_locked), mission_id, experiment_id, experiment_fingerprint, change_ids, confounding_change_ids, asset_ids, publication_ids, deployment_ids, baseline_ids, context_refs, confounder_count, artifacts, supersedes`.

Body sections, in order: Observation, Measurement, Experiment threshold check (experiments only), Data quality, Evidence strength, Causal confidence, Confounders, Possible explanations, Uncertainty, Interpretation, Provenance, External context.

## Change record (CH)

Frontmatter: `id, title, timestamp (ISO or null), timestamp_basis (manual | publish_ledger | execution_result | deploy_log | commit | task_created | loop_updated | unknown), timestamp_has_timezone, origin (signal7 | hyper7 | marketer7 | manual | deployment | external), origin_ref (dedupe key), type, pages, mission_id, experiment_id, asset_id, publication_id, deployment_id, confirmed, recorded_at, source_path, supersedes`.

Types: `seo_content_update, technical_seo_fix, tracking_change, pricing_change, product_release, campaign, deployment, content_publish, landing_page_change, performance_fix, schema_change, other`. An empty `pages` list means the scope is unknown and is treated as site-wide.

## Baseline record (BL)

`metric, metric_version, unit, value (null when insufficient), period_start, period_end, source_id, segment, scope_pages, sample_size, data_quality, experiment_id, recorded_at, artifacts`.

## Measurement plan (`experiments/EX-NNN/plan.md`)

`experiment_id, mission_id, status (planned | baseline_recorded | evaluated), marketer_path, marketer_status_at_plan, marketer_fingerprint, criteria_locked_at, metric, metric_version, source_id, scope_pages, design, before_start/end, window_start/end, baseline_id, change_ids, evidence_ids`. The plan references the Marketer7 definition by path and fingerprint. It never copies hypothesis or thresholds as its own.

## Observation snapshot (JSON)

`schema_version, kind (gsc_rows | timeseries | rankings | crawl | cwv | indexation), source_id, adapter, adapter_version, property, retrieved_at, period {start,end}, dimensions, filters, headline_safe, headline_note, input {file, sha256}, row_count, rows_sha256, warnings, rows`.
