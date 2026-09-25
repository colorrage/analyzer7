# Cross-harness integration

Analyzer7 reads neighbor state in place and writes only `.analyzer/`. No neighbor writes `.analyzer/`. Every reader tolerates absent roots, legacy files without the optional metadata, and unknown additive fields. It rejects an unknown contract major version with a warning.

## Traceability chain

```text
Mission (Marketer7 M1) → Experiment (Marketer7 EX-014) → Asset / publication (Signal7 S3/A1)
  → Change (Analyzer7 CH-002, origin_ref signal7:S3/A1) → Observation (Analyzer7 snapshot, hashed)
  → Evidence (Analyzer7 EV-001) → external-evidence-reference/v1 → Decision (Marketer7 D-NNN)
```

## Marketer7 (`.marketer/`)

- **Reads:** `experiments/EX-NNN-*/experiment.md` (the Definition table: primary metric, thresholds, measurement window, baseline, tracking; plus status and `criteria_locked_at`), `review.md` (`criteria_fingerprint`), and missions.
- **Fingerprint:** SHA-256 of the definition from `## Hypothesis` to `## Criteria lock`, with lines right-trimmed. This is identical to Marketer7's validator. The plan and every experiment evidence record store the fingerprint measured. A mismatch with the review lock is surfaced; Marketer7 decides whether it is a legitimate governed override.
- **Metric mapping:** Marketer's `Primary metric` must resolve to an Analyzer7 metric ID or alias. Otherwise evaluation stops with a clear error; no silent mapping.
- **Produces:** `exports/EX-NNN/EV-NNN-external-evidence-reference.md` using Marketer7's `external-evidence-reference/v1` (flat frontmatter: `contract, experiment_id, provider: analyzer7, external_evidence_id, external_artifact, observed_at, referenced_at`, plus additive fields `metric, primary_value, unit, data_quality, evidence_strength, causal_confidence, evidence_grade, threshold_result, measured_fingerprint`). Marketer7 or the operator copies it into `.marketer/experiments/EX-NNN-*/contracts/` and cites it from its own evidence. Analyzer7 never writes there.
- **Never:** creates experiments, changes thresholds, writes `win/loss`, or makes route decisions.

## Signal7 (`.signal/`)

- **Reads:** `tasks|archive/S<N>-*/publish-log.md` (published rows: `actual_publish_time`, `idempotency_key`, optional `mission_id/experiment_id/tracking`), `execution-result.md` (`signal7-execution-result/v1` events: asset, status, `publication_url`, timestamp), and asset frontmatter (`asset_type`, `channel`, `content_hash`).
- **Imports:** `discover.mjs --import-changes` registers each published asset as a change (`origin: signal7`, `origin_ref: signal7:S<N>/A<N>`, timestamp basis `publish_ledger`, pages from `publication_url`). The import is idempotent. A legacy task without metadata still imports; an unknown URL means unknown scope (site-wide, minor confounder).
- **Never:** asks humans to re-enter what Signal7 already recorded, or writes `.signal/`.

## Hyper7 (`.hyper/`)

- **Reads:** `tasks|archive/*/task.md` (phase, scope, `created`) and `loops/L<N>-*/loop.md` (status, `updated`).
- **Imports (opt-in, `--include hyper7`):** finished `feature`/`quick` tasks and closed loops, as **unconfirmed** changes. Hyper7 records no deploy time, so the timestamp basis is `task_created` or `loop_updated`, and pages are unknown until a human supersedes the record with a confirmed one. Research and code-review tasks are not changes.
- **Hand-off:** technical findings (canonical, redirects, 4xx/5xx, sitemap, structured data, CWV) become SEO-OPP records with `suggested_owner: hyper7`. Hyper7 fixes; Analyzer7 verifies with a later crawl or snapshot.
- **Never:** manages Hyper loops or tasks.

## Scout7 (`.scout/`)

- **Reads:** `batches/R<N>-*/batch.md` (id, title, phase, opened) and the territory log path.
- **Use:** external context only. The SEO audit lists batches opened inside the compared windows as potential confounders, and `experiment.mjs evaluate --context scout7:R1` records a batch as a minor confounder with its reference.
- **Never:** duplicates Scout7 research or treats a finding as measured data.

## Identifiers understood

`mission_id (M<N>)`, `experiment_id (EX-NNN)`, `asset_id (signal7:S<N>/A<N>)`, `publication_id (Signal7 idempotency key)`, `deployment_id (hyper7:T<N> | hyper7:L<N> | a deploy ID)`, `change_id (CH-NNN)`, `evidence_id (EV-NNN)`, `baseline_id (BL-NNN)`.
