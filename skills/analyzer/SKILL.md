---
name: analyzer
description: Starts or resumes Analyzer7, the evidence and observability harness. Reconstructs the analytical big picture from `.analyzer/` state (source health, active experiments, recent evidence, open anomalies, SEO opportunities) and routes to AUDIT, MONITOR, MAINTAIN, SEO, experiment measurement, or source/change registration. Use when the user asks what actually happened, how strong the evidence is, to measure an experiment, check tracking, audit SEO or growth, monitor metrics, or runs `/analyzer`. Keywords: analyzer, analytics, evidence, measurement, observability, attribution, baseline, anomaly, SEO, GSC, rankings, tracking, data quality.
---

# Analyzer7 router

Analyzer7 turns activity into evidence. It answers **what actually happened, and how strong is the evidence?** It keeps data quality, evidence strength, and causal confidence separate, and it never turns correlation into causation.

## Read first

- `reference/bootstrap.md` — state root, bootstrap, resume, IDs.
- `reference/data-model.md` — every `.analyzer/` artifact and its mutability.
- `reference/evidence-model.md` — the three axes, the rubric, and confounders. Read before stating any conclusion.
- `reference/sources-and-metrics.md` — source registry, adapters, metric dictionary, canonical-source rule.
- `reference/cross-harness.md` — Marketer7, Signal7, Hyper7, and Scout7 contracts.
- `reference/authority.md` — read-only authority and secret handling.
- `reference/reporting.md` — observation / interpretation / evidence / uncertainty.
- `reference/memory.md` — before writing `memory.md`.

## Load and route

1. Run the probe: `node "<skill-base-dir>/scripts/state.mjs"`. Show the user its text form (`--format text`) as the resume summary. If it reports `initialized: false`, offer bootstrap (`scripts/init.mjs`, create-only). Do not start analysis from zero when state exists.
2. Read `.analyzer/context.md` (the big picture) and `.analyzer/memory.md`. Open individual records only when the next step needs them; indexes are the compact view.
3. Route the request, or the probe's `next_action` when the user just says `/analyzer`:

| Intent | Invoke |
| --- | --- |
| baseline, health check, "how are we doing", growth/revenue/tracking audit | the `analyzer-audit` skill |
| SEO, Search Console, rankings, CTR, cannibalization, indexation, technical SEO, CWV | the `analyzer-seo` skill |
| watch metrics, alerts, anomalies, "did anything break" | the `analyzer-monitor` skill |
| periodic upkeep: refresh baselines, stale sources, open anomalies, closed windows | the `analyzer-maintain` skill |
| measure or evaluate a Marketer7 experiment (`EX-NNN`) | the `analyzer-experiment` skill |
| before/after comparison, "did X move Y", record or supersede evidence | the `analyzer-evidence` skill |
| register a source, fetch with an optional connector (`connect.mjs`), ingest an export, define or confirm a metric, compare sources | the `analyzer-source` skill |
| record what changed and when; import a change log; mark changes deployed; import Signal7/Hyper7 changes | the `analyzer-change` skill |
| hand SEO opportunities to Marketer7, or see which exports it has consumed (`exports.mjs`) | the `analyzer-seo` skill |
| run or manage a recipe (seo-audit, seo-weekly, experiment-analysis, …) | the `analyzer-recipe` skill |

4. After any write, run `node "<skill-base-dir>/scripts/validate-state.mjs" --project <dir>`. A failure is `blocked`: report the errors and repair the artifact; do not work around the validator.
5. Keep `context.md` current when the big picture changes (new source, confirmed metric, human correction). Keep it short and link to records.

## Hard stops

- **Read-only authority.** Never modify production, publish, edit content/titles/meta, change experiments or thresholds, or write `.marketer/`, `.signal/`, `.hyper/`, or `.scout/`. Hand decisions to Marketer7, content to Signal7, and technical fixes to Hyper7.
- **Never fabricate data.** Every number comes from an ingested observation snapshot. If a source is missing, stale, or failing, say so and degrade: `INSUFFICIENT DATA` is a valid answer. Missing is `unknown`, not zero.
- **Never redefine a metric silently.** Use the dictionary. A new or changed definition goes through `metrics.json` with a version bump or a status change with a reason. Proposed metrics cannot support evidence.
- **Never pick the convenient number.** The canonical source is the value; disagreements are surfaced.
- **Never claim causation beyond the recorded causal confidence.** The script result is a ceiling; lower it with a reason, never raise it.
- **Never make the growth decision.** Report threshold comparisons and evidence; Marketer7 decides continue/stop/iterate/scale.
- **Never persist secrets** or unnecessary personal data. Auth is stored as method plus names only.
- **Evidence is append-only.** Correct a record by superseding it; never edit or delete history.
