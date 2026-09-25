---
name: analyzer-maintain
description: Runs Analyzer7 MAINTAIN mode — periodic analytical upkeep that checks source health and staleness, closed experiment windows awaiting evaluation, open anomalies, SEO opportunities awaiting review, stale baselines, unconfirmed or unplaced changes, proposed metrics, and misconfigured monitors, then produces a checklist report. Never modifies production. Use when the user asks for maintenance, a weekly upkeep pass, to refresh baselines, or to verify source health. Keywords: analyzer, maintain, maintenance, upkeep, stale, refresh baselines, source health, housekeeping.
user-invocable: false
---

# analyzer-maintain

MAINTAIN keeps Analyzer7's own records trustworthy. It never changes production, neighbor harness state, or historical evidence.

## Steps

1. Run `node "<skill-base-dir>/../analyzer/scripts/analyze.mjs" maintain --report`.
2. Work the checklist with the user, in priority order:
   - **Unavailable or stale sources:** ask the user to re-export or re-authorize, then ingest through the `analyzer-source` skill. Record failed attempts with `ingest.mjs --fail`.
   - **Closed experiment windows:** invoke the `analyzer-experiment` skill to evaluate.
   - **Open anomalies:** review; resolve or dismiss with a reason (`record.mjs status`).
   - **Opportunities awaiting review:** summarize for Marketer7; mark `handed_off` once shared.
   - **Stale baselines (older than 90 days):** record fresh ones (`record.mjs baseline` or `analyze.mjs audit --record-baselines`). Never edit old ones.
   - **Unconfirmed or unknown-timing changes:** ask for deploy or publish times and supersede the record through the `analyzer-change` skill.
   - **Proposed metrics:** confirm definitions with the user (`record.mjs metric-status`).
3. Evaluate completed experiments, refresh ranking snapshots, and run the monitor pass when due (the `analyzer-monitor` skill).
4. Storage: when the checklist reports uncompressed snapshots, run `analyze.mjs compact`. Pruning (`--prune-unreferenced --older-than-days 180`) is opt-in and only removes snapshots no record mentions; propose it to the user rather than running it by default.
5. Run `validate-state.mjs`; repair anything it reports.
6. Record a memory entry only for a lesson that generalizes (`../analyzer/reference/memory.md`).
