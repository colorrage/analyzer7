---
schema_version: 1
id: EX-014
mission_id: M1
title: Search-intent title for the micro tax calculator
status: measurement_pending
owner: fixture-owner
created_at: 2026-08-21T00:00:00Z
criteria_locked_at: 2026-08-25T10:00:00Z
reviewed_at: 2026-08-25T10:00:00Z
approved_at: 2026-08-25T10:01:00Z
cancelled_at: null
cancellation_reason: null
---

# EX-014 — Search-intent title for the micro tax calculator

## Hypothesis

If we rewrite the calculator title and meta description to match the "calculator impozit micro 2026" search intent for Romanian searchers through organic search, then organic_ctr will increase from 1.1 to at least 1.8 within 28 days, compared with the prior 28-day baseline.

## Definition

| Field | Value |
| --- | --- |
| Audience | Romanian searchers for micro-company tax calculators |
| Channel | organic search |
| Action type | SEO title and meta description rewrite |
| Executor | signal7 |
| Primary metric | organic_ctr |
| Primary KPI tier | click |
| Secondary metrics | organic_clicks, avg_position, explanatory only |
| Baseline | 1.1 percent organic_ctr for 2026-08-01 to 2026-08-28 |
| Success threshold | >= 1.8 |
| Failure threshold | <= 1.2 |
| Measurement window | 2026-08-29T00:00:00Z to 2026-09-25T23:59:59Z |
| Tracking | Search Console page-level CTR for /calculator-impozit-micro, measured by Analyzer7 |

## Claims and execution scope

### Allowed claims

- Free calculator for the 2026 micro-company tax.

### Forbidden claims

- Guaranteed tax savings.

### Stop conditions

- Pause if the page drops out of the index.

## Criteria lock

Criteria were locked after the recorded review.

## Gate verdict

Verdict: pass

Actor: fixture-reviewer

At: 2026-08-25T10:01:00Z

Checked artifacts: `review.md`

Reasons:

- Measurable definition approved.

## Change history

- 2026-08-21T00:00:00Z — created as draft.
