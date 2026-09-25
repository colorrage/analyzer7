---
name: analyzer-evidence
description: Produces ad-hoc Analyzer7 evidence — a before/after comparison of one dictionary metric, optionally linked to registered changes, computed from ingested observations with data quality, evidence strength, causal confidence, confounders, and provenance — and records it append-only as EV-NNN. Also reads, summarizes, and supersedes evidence. Use when the user asks "did X move Y", "what happened after the release", or to record, find, or correct evidence. Keywords: analyzer, evidence, EV-, before after, comparison, attribution, confounders, supersede, provenance.
user-invocable: false
---

# analyzer-evidence

## Read first

`../analyzer/reference/evidence-model.md` and `../analyzer/reference/reporting.md`.

## Compare and record

1. Confirm the metric exists in the dictionary, the periods (equal length and weekday-aligned where possible), the scope (`--page`, `--query`, `--country`, `--segment`), and the change(s) under test (`CH-NNN`). An unregistered change is registered first through the `analyzer-change` skill.
2. Dry run: `node "<skill-base-dir>/../analyzer/scripts/analyze.mjs" compare --metric <id> --before-start --before-end --after-start --after-end [--page ...] [--change CH-NNN] [--design ...] [--context scout7:R<N>]`.
3. Show the interpretation line and the three axes. If data quality is insufficient, say INSUFFICIENT DATA and name what is missing.
4. Record on the user's agreement: add `--record --title "<short title>" [--observation "<what was observed>"]`.

## Find and read

Use `.analyzer/evidence/index.md` (one line per record) to locate evidence and open only the record needed. For a year-scale history, filter by metric, experiment, or date in the index; do not load every record.

## Correct

Evidence is never edited or deleted. Re-run the comparison with corrected inputs and record it with `--supersedes EV-NNN`. For experiments, `experiment.mjs evaluate --record` supersedes the previous evaluation automatically. The earlier record stays as history, and readers treat the newest non-superseded record as current.
