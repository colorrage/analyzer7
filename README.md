# Analyzer7

Analyzer7 is the evidence and observability harness of the 7 family. It answers one question:

> **What actually happened, and how strong is the evidence?**

It reads the data sources a project already has (Search Console, rank trackers, GA4, the application database, Stripe, crawlers, CrUX), the change records that neighbor harnesses already keep, and the experiment definitions Marketer7 already locked. It turns them into append-only evidence, where data quality, evidence strength, and causal confidence are recorded separately.

Like its siblings it is a disk-backed Agent Skills package: markdown and JSON on disk, plus small dependency-free Node scripts. It has no server, database, daemon, or network calls of its own.

```text
Scout7 ──► external context                          ┐
Marketer7 ──► hypothesis / experiment EX-NNN          │
Signal7 / Hyper7 ──► real-world change (publish/deploy)│──► Analyzer7 ──► EV-NNN evidence ──► Marketer7 decides
                                                      ┘      (measure,        (external-evidence-
                                                              observe,          reference/v1)
                                                              quantify doubt)
```

## What Analyzer7 is

- **Measurement and diagnosis:** baselines, before/after comparisons, experiment measurement, anomaly detection, data-quality checks, source reconciliation, and SEO measurement (GSC, rankings, indexation, technical, CWV).
- **An evidence ledger** whose records are traceable to the source, property, period, retrieval time, and hashed snapshot behind every number.
- **An honest broker.** It says INSUFFICIENT DATA instead of inventing a conclusion, surfaces confounders, and never turns correlation into causation.

## What Analyzer7 is not

- Not strategy. Marketer7 owns hypotheses, experiments, thresholds, verdicts, and routes. Analyzer7 reports threshold comparisons (`success_threshold_met`, …), never `win` or `loss`.
- Not content or publishing. Signal7 executes. Analyzer7 flags an SEO opportunity; it never rewrites a title.
- Not engineering. Hyper7 fixes. Analyzer7 diagnoses a broken canonical and verifies the fix afterwards.
- Not research. Scout7 researches. Analyzer7 cites Scout7 findings as external context only.
- Not an analytics platform. It orchestrates and interprets GA4, GSC, Stripe, and the DB; it does not replace them.
- Not SEO7, Analytics7, or Revenue7. Those are subsystems of Analyzer7, not separate harnesses.

## What is shipped

| Capability | Status |
| --- | --- |
| Project-local `.analyzer/` state, safe bootstrap, and a read-only resume probe (`/analyzer` resumes, never restarts) | Shipped |
| Source registry with computed health (ok / stale / unavailable / unknown) and freshness SLAs | Shipped |
| Versioned metric dictionary: canonical sources, fallbacks, discrepancy tolerance, proposed → active confirmation | Shipped |
| Normalized, immutable, hashed observation snapshots (adapters: `gsc`, `seo-rankings-md`, `rankings`, `timeseries`, `crawl`, `cwv`, `indexation`) | Shipped |
| Evidence ledger (EV), change registry (CH), baselines (BL), anomalies (AN), SEO opportunities (SEO-OPP), append-only indexes | Shipped |
| Three-axis evidence model with a deterministic rubric and named confounders | Shipped |
| Marketer7 experiment measurement: plan, baseline, evaluate, `external-evidence-reference/v1` export | Shipped, tested against Marketer7's real validator |
| Signal7 publication import (idempotent), opt-in Hyper7 import (unconfirmed), Scout7 context references | Shipped, tested against Signal7's real fixture |
| AUDIT (growth / revenue / tracking), MONITOR (guarded alerts, tracking breaks), MAINTAIN (upkeep checklist) | Shipped |
| SEO subsystem: overview, trends, winners/decliners, positions 4–15, low-CTR, cannibalization, content decay, rank changes, technical, CWV, indexation, SEO change impact | Shipped |
| Ten recipes (seo-audit, seo-weekly, experiment-analysis, growth-baseline, revenue-audit, tracking-audit, monthly-business-review, ranking-monitor, content-decay, conversion-funnel) | Shipped |
| Redaction on every write; secret scan in validation | Shipped |
| Live API clients inside Analyzer7 | Not shipped by design: fetching stays with the provider's own tool (MCP server, export, SQL), see [FUTURE.md](FUTURE.md) |

## Install

```sh
cd analyzer7
bash .claude/skills/install-analyzer/scripts/install.sh install    # symlink skills into ~/.claude, ~/.codex, ~/.agents, ~/.pi
bash .claude/skills/install-analyzer/scripts/install.sh status
bash .claude/skills/install-analyzer/scripts/install.sh uninstall  # removes only links pointing at this checkout
```

The installer is the Marketer7 installer, adapted: it never replaces an existing file, directory, or foreign link. Use `ANALYZER_INSTALL_TARGETS=/abs/a:/abs/b` for isolated targets. Install the skills as a suite; sub-skills call scripts in the sibling `analyzer` folder. Requires Node ≥ 18 (built-ins only).

Then run `/analyzer` in the project whose data you want to analyze. Live state is created there, in `.analyzer/`, never in this repository.

## The skills

| Skill | Does |
| --- | --- |
| `analyzer` | Router. Runs the probe, shows the resume, routes to the skill below, enforces the hard stops. User-invocable. |
| `analyzer-audit` | AUDIT: growth, revenue, or tracking baseline with data quality, discrepancies, and gaps. |
| `analyzer-monitor` | MONITOR: guarded anomaly detection and tracking-break alerts. |
| `analyzer-maintain` | MAINTAIN: stale sources, closed windows, open anomalies, stale baselines, unconfirmed changes. |
| `analyzer-seo` | SEO subsystem (GSC, rankings, indexation, technical, CWV, change impact). |
| `analyzer-experiment` | Measures Marketer7 `EX-NNN`: plan → baseline → evaluate → export. |
| `analyzer-evidence` | Ad-hoc before/after evidence linked to changes; find, read, supersede. |
| `analyzer-source` | Source registry, ingest, metric dictionary, discrepancy checks. |
| `analyzer-change` | Change registry and Signal7/Hyper7 import. |
| `analyzer-recipe` | Lists, runs, and manages recipes. User-invocable. |

## State model

```text
.analyzer/
  project.md  context.md  memory.md                       human-readable big picture and lessons
  sources.json  metrics.json  monitors.json  seo/config.json   structured registries
  observations/<source>/*.json                            immutable normalized pulls (rows hashed)
  evidence/EV-NNN-*.md      changes/CH-NNN-*.md           append-only ledgers, each with index.md
  baselines/BL-NNN-*.md     anomalies/AN-NNN-*.md         (anomalies: living status + history)
  seo/opportunities/SEO-OPP-NNN-*.md                      awaiting_review → handed_off → resolved
  experiments/EX-NNN/plan.md                              measurement plan (references Marketer7, never copies it)
  exports/EX-NNN/EV-NNN-external-evidence-reference.md    outgoing contract for Marketer7
  reports/<date>-<audit|monitor|maintain>-<scope>.md
  recipes/*.md                                            project recipes (override built-ins)
```

- **Resume without context bloat.** `state.mjs` builds the resume from indexes, frontmatter, and registries only. It never loads observation rows or full evidence bodies, so years of evidence stay out of context until a record is opened.
- **No duplicate sources of truth.** Health is computed, not stored. The next IDs come from disk, not counters. Experiment definitions stay in `.marketer/`.
- **Append-only.** Corrections supersede. Validation fails on deleted records, broken indexes, or observations whose rows no longer match their hash.

## Evidence model

| Axis | Question | Values |
| --- | --- | --- |
| Data quality | Can these numbers be trusted? | high · medium · low · insufficient |
| Evidence strength | Is the change real, not noise? | high · medium · low · insufficient |
| Causal confidence | Did the linked change cause it? | high · medium · low · none |

Each axis caps the next. The scripts compute the ceiling and record every reason; an analyst may lower a level with a reason, never raise it. Highlights of the rubric (full detail in [evidence-model.md](skills/analyzer/reference/evidence-model.md)):

- **Data quality** detects missing days, duplicates, sudden zeros, stale or unavailable sources, incomplete periods, timezone and schema mismatches, cross-source discrepancies, tracking changes in the window, headline totals derived from query/page rows, and restated baselines.
- **Evidence strength** uses Welch's t over daily values (or over-dispersion-adjusted proportion/Poisson tests), window-length caps, and a persistence check across both halves of the window.
- **Causal confidence** depends on the design (a before/after comparison is capped at medium). A registered same-page change or a tracking change in the periods is a major confounder, and position or demand shifts are minor ones. With no linked change the result is `none`: an observation, not an attribution.

Example (the fixture experiment; exact values by construction):

```text
EV-001  EX-014 organic_ctr evaluation
  before 1.0952% (2026-08-01 → 08-28, 8400 impressions)   after 2.3963% (2026-08-29 → 09-25, 8680 impressions)
  threshold: success >= 1.8 → success_threshold_met        (Marketer7 decides the verdict)
  data quality HIGH · evidence strength HIGH · causal confidence MEDIUM
  confounders: average position 8.77 → 7.88 (minor); CH-001 LinkedIn post, scope unknown (minor)
  interpretation: organic_ctr increased after CH-002. The timing is consistent with the hypothesis
                  but the listed minor confounders remain unexcluded.
```

## Source model and metric dictionary

Sources are registered, never assumed, with their type, property, adapter, auth **method and names** (never values), timezone, freshness SLA, and limitations. Adapters normalize exports produced by the provider's own tooling (for example the GSC MCP server). The core is not coupled to any SDK, and tests need no live API.

Metrics have stable definitions, a **canonical source**, fallbacks, and a discrepancy tolerance. Ratios are ratios of sums, positions are impression-weighted, and counts are compared per day when windows differ. When GA4 says 100 and the DB says 91, the canonical source's value is reported, the disagreement is raised, and nothing is averaged. Project-specific metrics (a SaaS funnel, say) start `proposed` and cannot support evidence until a human confirms them. Nothing product-specific is hardcoded.

## SEO subsystem and rankings

Built on the reusable parts of the CMR `seo-rankings` skill: its operations, movement classification, quick-win and striking-distance windows, CTR crisis rules, cannibalization, and the hard-won conventions in its state notes (headline totals never from summed `query,page` rows; per-day normalization; calendar-aligned windows; content churn inside a window destroys attribution). The CMR-specific parts stay in CMR: the site, the 20-market table, tiers, and task history. The market table becomes generic `segments` in `.analyzer/seo/config.json`. Existing seo-rankings baselines and snapshots import in place through the `seo-rankings-md` adapter.

Rank tracking is a separate observation kind (`keyword × location × device × engine`, with position, URL, SERP features, and timestamp). It is never conflated with GSC's average position. The rank-change output includes deltas, new and lost keywords, URL switches (a cannibalization hint), SERP-feature changes, and alerts for losses of more than 10 positions; stale snapshots are flagged, not compared silently.

## Cross-harness integration

| Neighbor | Analyzer7 reads | Analyzer7 produces |
| --- | --- | --- |
| Marketer7 | `EX-NNN` definitions, status, review fingerprint (same algorithm as Marketer7's validator) | `external-evidence-reference/v1` in `.analyzer/exports/`, for Marketer7 to cite |
| Signal7 | publish ledger, `signal7-execution-result/v1`, asset metadata | CH records (`origin_ref: signal7:S<N>/A<N>`), idempotent |
| Hyper7 | finished tasks and closed loops (opt-in) | unconfirmed CH records; technical SEO-OPPs with Hyper7 as owner |
| Scout7 | batches | external-context references (minor confounders) |

No harness writes another's root. Legacy neighbor files without the optional metadata remain valid, and an unknown contract major version is ignored with a warning. See [cross-harness.md](skills/analyzer/reference/cross-harness.md).

## AUDIT, MONITOR, MAINTAIN

- **AUDIT:** a deep baseline. `analyze.mjs audit --scope growth|revenue|tracking --report` for the business, or `seo.mjs audit --report` for SEO. It reports current values, tracking health, discrepancies, data gaps, and registered changes as candidate explanations. Causal confidence is `none` by construction.
- **MONITOR:** `analyze.mjs monitor [--record]`. Alerts require a relative threshold, an absolute threshold, a minimum sample, the declared direction, and a significance guard, all at once, over weekday-aligned windows. Vanished or zeroed data is a tracking break. Open anomalies are never duplicated.
- **MAINTAIN:** `analyze.mjs maintain --report`. A checklist covering stale or unavailable sources, closed experiment windows, aging anomalies, opportunities awaiting review, stale baselines, unconfirmed or unplaced changes, proposed metrics, and broken monitors. It never modifies production.

## Authority and security

Read, analyze, and write `.analyzer/`: allowed. Modify production, publish, change marketing, change the product, or write neighbor roots: not allowed. Every write passes through redaction (API keys, OAuth/bearer tokens, JWTs, private keys, credentialed URLs, secret key/value pairs, email addresses), and `validate-state.mjs` fails on anything that survives. See [authority.md](skills/analyzer/reference/authority.md).

## Workflows

[docs/workflows.md](docs/workflows.md) walks through realistic sessions: first run in a project, the full Marketer7 → Signal7 → Analyzer7 experiment loop, a weekly SEO pass, and a conflicting-sources investigation.

## Verification

```sh
node --test                               # behavioral suite (built-ins only, no network)
node scripts/validate-analyzer-package.mjs       # static package contract
node scripts/build-fixtures.mjs                  # regenerate the deterministic ecosystem fixture
node skills/analyzer/scripts/validate-state.mjs --project <dir>   # validate a consuming project's .analyzer/
```

The suite covers a fresh project, resume, a missing source, a stale source, conflicting sources, experiment evaluation, confounded experiments, SEO rankings (fixtures modeled on seo-rankings), monitors, data quality, security, append-only integrity, the installer, legacy compatibility, and regressions from an independent review (`tests/regressions.test.mjs`). When the sibling checkouts are present (`../marketer7`, `../signal7/marketer7-integration`), it also runs Marketer7's real state validator on the exported reference and reads Signal7's real Marketer7 fixture.

## Further reading

- [Architecture note](docs/architecture-note.md) — reconnaissance of the family and what Analyzer7 reuses.
- [Workflows](docs/workflows.md) — realistic sessions.
- [Data model](skills/analyzer/reference/data-model.md) · [Evidence model](skills/analyzer/reference/evidence-model.md) · [Sources and metrics](skills/analyzer/reference/sources-and-metrics.md) · [SEO model](skills/analyzer-seo/reference/seo-model.md)
- [FUTURE.md](FUTURE.md) — deferred work and why.
