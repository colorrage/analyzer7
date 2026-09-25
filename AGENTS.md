# Analyzer7 — Agent Instructions

Analyzer7 is a skill-based evidence and observability harness. Skills live under `skills/`; `README.md` § What is shipped is the source of truth for shipped capabilities.

## State and ownership

- Runtime state belongs in the consuming project's `.analyzer/` directory, never in this repository or a skill folder.
- Analyzer7 owns measurement, observations, data quality, evidence, baselines, the change registry, anomalies, SEO diagnosis, and experiment measurement.
- Marketer7 owns missions, experiments, thresholds, verdicts, and routes. Analyzer7 reads `.marketer/` and exports `external-evidence-reference/v1`; it never writes `.marketer/`.
- Signal7 owns content and publication; Hyper7 owns technical changes; Scout7 owns external research. Analyzer7 reads their state and never writes it.

## Working rules

- Keep data quality, evidence strength, and causal confidence separate. Never state causation beyond the recorded causal confidence.
- Never fabricate or estimate source data. Missing is `unknown`, and INSUFFICIENT DATA is a valid result.
- Never define or redefine a metric silently: dictionary entries are versioned, and project metrics start `proposed`.
- Evidence, changes, baselines, and observations are append-only; corrections supersede.
- Scripts are dependency-free Node (built-ins only) and make no network calls. Fetching stays with the provider's own authorized tools.
- Never persist secrets or unnecessary personal data.

## Two surfaces

1. **Shipped skills** — `skills/**`. They must run on any Agent Skills host: no absolute paths, no references to this repository's README/AGENTS/docs, no project-specific names (CMR, Banu). Sub-skills reference the router's files as `../analyzer/...`.
2. **Repo-local dev surface** — `README.md`, `AGENTS.md`, `FUTURE.md`, `docs/`, `scripts/`, `tests/`, `fixtures/`, `.claude/skills/install-analyzer/`.

## Before finishing a change

```sh
node --test
node scripts/validate-analyzer-package.mjs
```

Regenerate the fixture with `node scripts/build-fixtures.mjs` when changing it; never hand-edit generated fixture files.
