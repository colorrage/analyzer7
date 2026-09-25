---
name: analyzer-experiment
description: Measures a Marketer7 experiment (EX-NNN) without owning it — reads the locked definition in place, records a measurement plan and baseline, waits for the window to close, then evaluates the primary metric against Marketer7's thresholds into an append-only EV evidence record with data quality, evidence strength, causal confidence, and confounders, plus an external-evidence-reference/v1 export for Marketer7. Use when the user asks to measure, baseline, or evaluate an experiment. Keywords: analyzer, experiment, EX-, evaluate, measurement window, baseline, threshold, marketer7, evidence.
user-invocable: false
---

# analyzer-experiment

Marketer7 owns the experiment definition, the verdict, and the next decision. Analyzer7 owns the measurement and the evidence.

## Read first

`../analyzer/reference/evidence-model.md` and `../analyzer/reference/cross-harness.md`.

## Steps

All commands are `node "<skill-base-dir>/../analyzer/scripts/<script>" ... --project <dir>`.

1. **Discover.** `discover.mjs` lists Marketer7 experiments with status, window, primary metric, and fingerprint. Then `discover.mjs --import-changes` registers the Signal7 publication(s) linked to the experiment as CH records.
2. **Map the metric.** Marketer7's `Primary metric` must resolve to a dictionary metric ID or alias. If it does not, stop and agree the definition with the user (the `analyzer-source` skill). Never map silently.
3. **Plan and baseline, before or at window start.** `experiment.mjs plan --experiment EX-NNN --record-baseline [--page /x] [--control auto|none | --control-page /a,/b] [--design before_after|controlled|randomized_controlled] [--baseline-start --baseline-end]`. Page-scoped plans pre-register a control group (untouched pages in the same markets); evaluation then uses difference-in-differences. The plan records the Marketer7 fingerprint, window, scope (from the linked changes' pages unless given), and baseline period (by default the same length, immediately before the window). An insufficient baseline is recorded as unknown; it is not invented.
4. **Wait for the window to close** and for the source to cover it (the probe's `next` says which). `evaluate` refuses an open window unless `--allow-open-window` is passed, and then marks the read partial (major data-quality issue).
5. **Evaluate.** Ingest the data, then run `experiment.mjs evaluate --experiment EX-NNN --record [--context scout7:R<N>]`. This writes `EV-NNN` (append-only; a re-evaluation supersedes the earlier record) and `exports/EX-NNN/EV-NNN-external-evidence-reference.md`.
6. **Hand over.** Tell the user the export path and that Marketer7 cites it from its experiment `contracts/` (Marketer7 copies it; Analyzer7 never writes `.marketer/`). Report the threshold comparison (`success_threshold_met | failure_threshold_met | between_thresholds | insufficient_data`) together with all three axes and the confounders. Do not call it a win or loss. If the criteria are not governed (`criteria_changed` or `criteria_not_locked`), the result is withheld on purpose: Marketer7 must re-lock the definition or approve a criteria override, and then you re-evaluate (the new EV supersedes the old one).

## Stop and ask

- The Marketer7 definition changed after the plan, or no longer matches its review lock (the fingerprint warning).
- The experiment is not found in `.marketer/` (Analyzer7 does not create experiment definitions).
- The linked change has unknown or unconfirmed timing: confirm it through the `analyzer-change` skill before relying on causal confidence.
