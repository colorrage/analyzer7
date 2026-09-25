# Analyzer7 architecture note (Phase 0 reconnaissance)

Written before implementation. It records what the existing harness family actually does, what Analyzer7 reuses, and where `task.md` was adjusted to fit the real architecture.

## What was inspected

| Harness | Location | Maturity | Most relevant artifacts |
| --- | --- | --- | --- |
| Hyper7 | `~/hyper/hyper7/hyper7` | mature | `skills/hyper*/SKILL.md`, `hyper-build/scripts/state.mjs` (JSON state probe), `hyper/templates/loop.md`, `hyper-memory` (index + entry files), `hyper-recipe`, `AGENTS.md` authoring invariants |
| Marketer7 | `~/hyper/marketer7` | v1 shipped | `skills/marketer/reference/*` (data model, gates, evaluation policy, ownership, contract versioning), `templates/external-evidence-reference.md`, `scripts/validate-marketer-*.mjs`, `scripts/run-marketer-fixtures.mjs`, installer |
| Signal7 | `~/hyper/signal7/marketer7-integration` (latest worktree) | shipped | `.signal/tasks/S<N>-*/{task.md,A<N>-*.md,publish-log.md,execution-result.md}`, `signal7-execution-result/v1`, `signal-marketer` bridge |
| Scout7 | `~/hyper/scout7` | initial | `.scout/batches/R<N>-*/batch.md`, `context/territory-checks-log.md`, provenance rules, evidence tags `VERIFIED/REPORTED/ESTIMATED/UNKNOWN` |
| seo-rankings | `~/Work/cmr/.agents/skills/seo-rankings` | project skill | operations (snapshot, compare, quick wins, audits, baselines, history), movement classification, GSC MCP usage, `.hyper/seo/` storage; plus the CMR `.hyper/seo/README.md` conventions |

## Patterns found in the family (reused as-is)

1. **Agent Skills package, no runtime.** Every harness is a `skills/` folder of `SKILL.md` files with `templates/` and `reference/` one level deep. No server, database, daemon or user-facing CLI. Distribution is symlinking skill folders into agent skill directories through a repo-local installer (`.claude/skills/install-<name>/scripts/install.sh`) that never overwrites foreign entries.
2. **Project-local dot-directory state.** `.hyper/`, `.signal/`, `.marketer/`, `.scout/`. Marketer7 already reserves **`.analyzer/`** for Analyzer7 (`ownership.md`: "canonical evidence remains in `.analyzer/`"). Nothing lives in the skill repo.
3. **Markdown with flat YAML frontmatter, `schema_version: 1`.** Machine-readable JSON is used only where structure matters (`metrics/funnel.json`). Parsers are dependency-free and deliberately strict (Marketer rejects anything that is not `key: value`).
4. **Stable prefixed IDs, allocated by scanning and never reused.** `T<N>`, `L<N>`, `S<N>`, `A<N>`, `M<N>`, `EX-<NNN>`, `E-<NNN>`, `BL-<NNN>`, `D-<NNN>`, `R<N>`. Hyper computes the next id from disk in a probe; Marketer keeps counters. Analyzer7 computes from disk, because a stored counter is a second source of truth.
5. **Append-only history, living state separated.** Hyper loops: decisions/cycles/verify are append-only, other sections are living. Marketer evidence and decisions are append-only; missing values are `unknown`, never zero.
6. **Deterministic probes and validators in Node, zero dependencies.** `state.mjs` returns one JSON object used for routing; `validate-*-state.mjs` returns `{checks, errors}`; the fixture runners copy a fixture to a temp dir, mutate it, and assert the expected pass/fail fragment. Hyper tests use `node:test`.
7. **Versioned file contracts between harnesses; no harness writes another's root.** `signal7-execution-brief/v1` (Marketer → Signal), `signal7-execution-result/v1` (Signal-side record), `external-evidence-reference/v1` (external provider → Marketer). Consumers reject an unknown major version and tolerate unknown additive fields.
8. **Evidence discipline.** Marketer grades evidence A–E, keeps strength separate from confidence and causality, and never lets secondary metrics override the primary KPI. Scout insists on explicit uncertainty tags and prompt provenance.
9. **Router + narrow phase skills; recipes as playbooks.** One router skill resolves state and routes; narrower skills own specific writes. Recipes are `name` + `description` frontmatter plus a step list and hold no hidden logic.
10. **Sparse memory.** Store only lessons that a future session would miss, with provenance.

## seo-rankings: reusable vs CMR-specific

| Aspect | Verdict | Where it goes in Analyzer7 |
| --- | --- | --- |
| Operations (snapshot, compare, quick wins, full audit, save baseline, history) | Reusable | `analyzer-seo` operations and the `seo-audit` / `seo-weekly` / `ranking-monitor` recipes |
| Movement classification (big win ≥5 positions or clicks ×2, improved 1–4 positions or CTR +1pp, stable, slipping, dropped ≥5 or clicks ÷2, new, lost) | Reusable | `lib/seo.mjs#classifyMovement`, tested against fixtures |
| Quick-win window (positions 4–15, min impressions, max CTR) and striking distance (15–30) | Reusable, parameterized | `seo.json` thresholds |
| CTR health bands and anomaly rules (CTR < 2% with > 500 impressions, pos > 20 with > 200 impressions, zero clicks on page 1) | Reusable as defaults | opportunity detection |
| Cannibalization = same query ranking with several pages | Reusable | `lib/seo.mjs#cannibalization` |
| Site URL, 20-market table, tiers, Yoast effort sizing, T18/T20/T55 task history, Clarity | **CMR-specific** | Replaced by a generic `segments` list in `.analyzer/seo/config.json` (country filter + URL prefix + tier label) |
| "Use GSC MCP tools, not Python" and the tool names (`enhanced_search_analytics`, `detect_quick_wins`) | Remains external; invoked | GSC adapter contract documents the call, and `ingest.mjs --adapter gsc` normalizes the returned rows |
| Baseline markdown format under `.hyper/seo/baselines|snapshots` | Legacy input | `seo-rankings-md` adapter imports those tables into normalized observations. Nothing is migrated or rewritten |
| Hard-won CMR conventions: headline totals never from summed `query,page` rows; normalize per day when windows differ; prefer calendar-aligned windows; content churn inside a measurement window destroys attribution (the release-log/freeze lesson) | **Generic lessons** | Enforced by `lib/seo.mjs` (`headline_safe`), `lib/stats.mjs` (per-day normalization) and `lib/confidence.mjs` (changes inside the window are confounders) |
| Rankings "provider" | The skill has none; it uses GSC average position | Analyzer7 separates `avg_position` (GSC, impression-weighted) from true SERP rank observations (ranking adapter). They are never conflated |

No generic ranking contract existed anywhere in the family, so Analyzer7 defines `ranking-observation` rows (keyword, location, device, engine, position, url, serp_features, observed_at, provider).

## Cross-harness integration points found

| Neighbor | What exists | Analyzer7 use |
| --- | --- | --- |
| Marketer7 | `experiments/EX-<NNN>-*/experiment.md` (definition table, thresholds `>= N`, measurement window, `criteria_locked_at`, review fingerprint = SHA-256 of `## Hypothesis`..`## Criteria lock`); `external-evidence-reference/v1` template and validator checks | Read the definition in place (never copy it) and record the fingerprint that was measured. Emit `external-evidence-reference/v1` into `.analyzer/exports/` for Marketer7 to cite |
| Signal7 | `execution-result.md` (`signal7-execution-result/v1`, events table with asset/status/channel/publication_url/timestamp/tracking), `publish-log.md` (YAML list, `actual_publish_time`, `idempotency_key`), asset `content_hash`, optional `mission_id`/`experiment_id` | Import published events as change records (`origin_ref: signal7:S<N>/A<N>`), with idempotent dedupe on that reference. Legacy tasks without metadata are still readable |
| Hyper7 | `.hyper/tasks|archive/*/task.md` (phase, scope, `created`, **no completion timestamp**), `.hyper/loops/*/loop.md` (`updated`) | Opt-in import of finished feature/quick tasks and closed loops as **unconfirmed** changes whose timing is marked low confidence. Analyzer7 never manages loops |
| Scout7 | `.scout/batches/R<N>-*/batch.md` (`opened`, phase), territory log | Listed as external context that an evidence record may cite as a possible confounder. Research is never duplicated |

## Conflicts between task.md and the existing architecture, and how they were resolved

1. **`/analyzer` "command".** The family has no CLI, so `/analyzer` is the router skill. Deterministic work (probe, ingest, compare, SEO analyses, evaluation, record writing, validation) lives in dependency-free Node scripts inside the skill folder, like Hyper's `state.mjs`. The agent calls them; the user never needs to.
2. **`state.md`.** It is not stored. Resume comes from a read-only `state.mjs` probe (the Hyper pattern), because a stored summary would drift from the records it summarizes.
3. **Evidence strength vocabulary.** Marketer7 already grades evidence A–E (directness of the observation). Analyzer7 keeps the three axes the spec requires (data quality, evidence strength, causal confidence: high/medium/low/insufficient or none) and **also** carries the Marketer A–E grade from the metric dictionary. That lets Marketer7 cite Analyzer evidence without translation.
4. **Experiment ownership.** Analyzer7 does not create `EX-<NNN>`. It reads Marketer7's definition and writes only a measurement plan plus evidence. Its threshold result is reported as `success_threshold_met | failure_threshold_met | between_thresholds | insufficient_data`, never `win/loss`. The verdict stays with Marketer7.
5. **ID collisions.** `BL-<NNN>` exists in Marketer7 as well. IDs are unique within a state root. Cross-harness references are qualified (`analyzer7:EV-042`, `signal7:S21/A1`, `hyper7:T12`), and Marketer's reference carries `provider: analyzer7`.
6. **Directory list in §5.** It collapses to fewer folders: `reports/` holds audit, monitor and maintain outputs (with `mode` in the frontmatter), `observations/` holds normalized raw pulls, and `monitors.json` holds monitor rules. The goal is to avoid empty ceremony directories.
7. **Recipes.** Built-in recipes ship inside `analyzer-recipe/recipes/`. Project-local recipes in `.analyzer/recipes/` override them by name (the Hyper recipe file shape).

## What Analyzer7 adds that no sibling has

- Source registry with computed health (ok / stale / unavailable / unknown) from fetch timestamps, freshness SLAs and last errors.
- A metric dictionary with a canonical source per metric, versioned definitions and a discrepancy tolerance.
- Normalized, hashed observation snapshots as the only numeric input to analysis (provenance by construction).
- A deterministic rubric for data quality → evidence strength → causal confidence, where each axis caps the next and every downgrade names its reason.
- A change registry correlated against measurement windows, which is how overlapping changes become explicit confounders.
