#!/usr/bin/env node
// Regenerates fixtures/analyzer/ecosystem deterministically.
//
// The fixture is a whole consuming project: Marketer7 (EX-014 measurement
// pending), Signal7 (the SEO title rewrite publication plus a legacy task),
// Hyper7 (a finished task and an active loop), Scout7 (a batch), and raw
// provider exports under inputs/. There is deliberately no `.analyzer/` — the
// tests build it through the Analyzer7 scripts, exactly as an agent would.
//
// Usage: node scripts/build-fixtures.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repository, 'fixtures', 'analyzer', 'ecosystem');
const ORIGIN = 'https://www.example.test';

function write(relativePath, content) {
  const filePath = path.join(target, relativePath);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
}

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dates(start, count) {
  return Array.from({length: count}, (_, index) => new Date(Date.parse(`${start}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
}

// Distribute an exact total over days with bounded noise and a weekday
// pattern, so period totals are known exactly.
function distribute(total, days, random, weekdayAmplitude = 0.12) {
  const weights = days.map((date) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekdayFactor = weekday === 0 || weekday === 6 ? 1 - weekdayAmplitude : 1 + weekdayAmplitude / 2.5;
    return weekdayFactor * (0.9 + random() * 0.2);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const values = weights.map((weight) => Math.floor((weight / sum) * total));
  let remainder = total - values.reduce((a, b) => a + b, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % values.length, remainder -= 1) values[index] += 1;
  return values;
}

function fingerprint(body) {
  const start = body.indexOf('## Hypothesis');
  const end = body.indexOf('## Criteria lock');
  const canonical = body.slice(start, end).replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();
  return {canonical, hash: crypto.createHash('sha256').update(canonical).digest('hex')};
}

fs.rmSync(target, {recursive: true, force: true});
const random = mulberry32(20260925);
const before = dates('2026-08-01', 28);
const after = dates('2026-08-29', 28);

// ---------- raw provider exports ----------

// Daily page-level GSC export (dimensions date,page). Exact period totals:
//   /calculator-impozit-micro  before 8400 impressions / 92 clicks  (1.0952%), position ~8.7
//                              after  8680 impressions / 208 clicks (2.3963%), position ~7.9
const pages = [
  {page: '/calculator-impozit-micro', before: {impressions: 8400, clicks: 92, position: 8.7}, after: {impressions: 8680, clicks: 208, position: 7.9}},
  {page: '/blog/ghid-impozit-micro', before: {impressions: 3360, clicks: 114, position: 5.1}, after: {impressions: 3420, clicks: 112, position: 5.0}},
  {page: '/impozit-micro-2026', before: {impressions: 2240, clicks: 25, position: 11.4}, after: {impressions: 2150, clicks: 21, position: 11.9}},
];
const dailyRows = ['date,page,clicks,impressions,ctr,position'];
const siteRows = ['date,clicks,impressions,ctr,position'];
const siteTotals = new Map();
for (const page of pages) {
  for (const [period, days] of [['before', before], ['after', after]]) {
    const spec = page[period];
    const impressions = distribute(spec.impressions, days, random);
    const clicks = distribute(spec.clicks, days, random, 0.3);
    days.forEach((date, index) => {
      const position = Math.round((spec.position + (random() - 0.5) * 0.6) * 10) / 10;
      const ctr = impressions[index] ? clicks[index] / impressions[index] : 0;
      dailyRows.push(`${date},${ORIGIN}${page.page}/,${clicks[index]},${impressions[index]},${ctr.toFixed(4)},${position}`);
      const entry = siteTotals.get(date) ?? {clicks: 0, impressions: 0, weighted: 0};
      entry.clicks += clicks[index];
      entry.impressions += impressions[index];
      entry.weighted += position * impressions[index];
      siteTotals.set(date, entry);
    });
  }
}
write('inputs/gsc-daily-pages-2026-08-01_2026-09-25.csv', dailyRows.join('\n'));

// Property-level (date-only) export: page totals plus pages not shown above
// and anonymized-query traffic, so it is larger than the sum of the pages.
for (const [date, entry] of [...siteTotals.entries()].sort()) {
  const extraImpressions = 900 + Math.floor(random() * 120);
  const extraClicks = 30 + Math.floor(random() * 8);
  const clicks = entry.clicks + extraClicks;
  const impressions = entry.impressions + extraImpressions;
  const position = (entry.weighted + extraImpressions * 14) / impressions;
  siteRows.push(`${date},${clicks},${impressions},${(clicks / impressions).toFixed(4)},${position.toFixed(2)}`);
}
write('inputs/gsc-daily-site-2026-08-01_2026-09-25.csv', siteRows.join('\n'));

// Query×page aggregates for each 28-day period (as returned by the GSC MCP
// `enhanced_search_analytics` tool with dimensions query,page).
const queryBefore = [
  ['calculator impozit micro 2026', '/calculator-impozit-micro', 67, 6100, 8.7],
  ['calculator impozit micro 2026', '/impozit-micro-2026', 10, 1300, 11.2],
  ['impozit micro 2026', '/calculator-impozit-micro', 20, 1500, 8.0],
  ['impozit micro 2026', '/impozit-micro-2026', 9, 900, 11.0],
  ['impozit micro 2026', '/blog/ghid-impozit-micro', 2, 600, 17.0],
  ['ghid impozit micro', '/blog/ghid-impozit-micro', 82, 2400, 4.8],
  ['impozit micro calcul', '/calculator-impozit-micro', 5, 800, 14.5],
  ['declaratie impozit micro', '/blog/ghid-impozit-micro', 1, 350, 22.0],
  ['plafon micro 2026', '/blog/ghid-impozit-micro', 9, 200, 6.2],
];
const queryAfter = [
  ['calculator impozit micro 2026', '/calculator-impozit-micro', 151, 6300, 7.9],
  ['calculator impozit micro 2026', '/impozit-micro-2026', 9, 1250, 12.0],
  ['impozit micro 2026', '/calculator-impozit-micro', 36, 1450, 7.6],
  ['impozit micro 2026', '/impozit-micro-2026', 7, 820, 11.6],
  ['impozit micro 2026', '/blog/ghid-impozit-micro', 1, 640, 17.4],
  ['ghid impozit micro', '/blog/ghid-impozit-micro', 84, 2480, 4.7],
  ['impozit micro calcul', '/calculator-impozit-micro', 12, 830, 12.9],
  ['declaratie impozit micro', '/blog/ghid-impozit-micro', 2, 390, 16.4],
  ['calculator micro 2026', '/calculator-impozit-micro', 5, 300, 9.1],
];
for (const [name, rows] of [['before-2026-08-01_2026-08-28', queryBefore], ['after-2026-08-29_2026-09-25', queryAfter]]) {
  const json = {rows: rows.map(([query, page, clicks, impressions, position]) => ({keys: [query, `${ORIGIN}${page}/`], clicks, impressions, ctr: Math.round((clicks / impressions) * 10000) / 10000, position}))};
  write(`inputs/gsc-query-page-${name}.json`, JSON.stringify(json, null, 2));
}

// Rank-tracker snapshots (provider-neutral CSV).
write('inputs/rankings-2026-08-28.csv', [
  'keyword,location,device,engine,position,url,serp_features,observed_at',
  `calculator impozit micro 2026,RO,mobile,google,9,${ORIGIN}/calculator-impozit-micro/,people_also_ask,2026-08-28T06:00:00Z`,
  `impozit micro 2026,RO,mobile,google,8,${ORIGIN}/calculator-impozit-micro/,people_also_ask,2026-08-28T06:00:00Z`,
  `ghid impozit micro,RO,mobile,google,5,${ORIGIN}/blog/ghid-impozit-micro/,,2026-08-28T06:00:00Z`,
  `calcul impozit microintreprindere,RO,mobile,google,,,,2026-08-28T06:00:00Z`,
  `impozit micro pfa,RO,mobile,google,30,${ORIGIN}/blog/ghid-impozit-micro/,,2026-08-28T06:00:00Z`,
].join('\n'));
write('inputs/rankings-2026-09-22.csv', [
  'keyword,location,device,engine,position,url,serp_features,observed_at',
  `calculator impozit micro 2026,RO,mobile,google,7,${ORIGIN}/calculator-impozit-micro/,people_also_ask|featured_snippet,2026-09-22T06:00:00Z`,
  `impozit micro 2026,RO,mobile,google,21,${ORIGIN}/impozit-micro-2026/,people_also_ask,2026-09-22T06:00:00Z`,
  `ghid impozit micro,RO,mobile,google,4,${ORIGIN}/blog/ghid-impozit-micro/,,2026-09-22T06:00:00Z`,
  `calcul impozit microintreprindere,RO,mobile,google,18,${ORIGIN}/calculator-impozit-micro/,,2026-09-22T06:00:00Z`,
  `impozit micro pfa,RO,mobile,google,>100,,,2026-09-22T06:00:00Z`,
].join('\n'));

// Conflicting conversion sources for the same 14 days: GA4 100, DB 91.
const conversionDays = dates('2026-09-01', 14);
const ga4 = distribute(100, conversionDays, random, 0.2);
const db = distribute(91, conversionDays, random, 0.2);
write('inputs/ga4-sign-up-2026-09-01_2026-09-14.csv', ['date,value', ...conversionDays.map((date, index) => `${date},${ga4[index]}`)].join('\n'));
write('inputs/db-registrations-2026-09-01_2026-09-14.csv', ['date,metric,value', ...conversionDays.map((date, index) => `${date},completed_registration,${db[index]}`)].join('\n'));

write('inputs/crawl-2026-09-20.csv', [
  'url,status,redirect_to,redirect_hops,canonical,title,meta_description,robots,in_sitemap,inlinks',
  `${ORIGIN}/calculator-impozit-micro/,200,,0,${ORIGIN}/calculator-impozit-micro/,Calculator impozit micro 2026,Calculează impozitul pe venitul microîntreprinderilor.,index follow,true,14`,
  `${ORIGIN}/impozit-micro-2026/,200,,0,${ORIGIN}/impozit-micro-2026/,Impozit micro 2026,Calculează impozitul pe venitul microîntreprinderilor.,index follow,true,6`,
  `${ORIGIN}/blog/ghid-impozit-micro/,200,,0,${ORIGIN}/calculator-impozit-micro/,Ghid impozit micro,,index follow,true,9`,
  `${ORIGIN}/blog/vechi-impozit-micro/,301,${ORIGIN}/blog/arhiva/,2,,,,,true,3`,
  `${ORIGIN}/blog/arhiva/,404,,0,,,,,false,1`,
  `${ORIGIN}/tag/micro/,200,,0,${ORIGIN}/tag/micro/,Impozit micro 2026,Etichetă micro,noindex follow,true,2`,
  `${ORIGIN}/landing/vechi/,200,,0,${ORIGIN}/landing/vechi/,Landing vechi,Pagină veche,index follow,true,0`,
].join('\n'));

write('inputs/cwv-2026-08.csv', ['url,form_factor,lcp_p75_ms,inp_p75_ms,cls_p75,date', `${ORIGIN}/calculator-impozit-micro/,phone,2300,180,0.05,2026-08-28`, `${ORIGIN}/blog/ghid-impozit-micro/,phone,2100,150,0.02,2026-08-28`].join('\n'));
write('inputs/cwv-2026-09.csv', ['url,form_factor,lcp_p75_ms,inp_p75_ms,cls_p75,date', `${ORIGIN}/calculator-impozit-micro/,phone,3100,190,0.05,2026-09-22`, `${ORIGIN}/blog/ghid-impozit-micro/,phone,2150,150,0.02,2026-09-22`].join('\n'));

write('inputs/indexation-2026-09-20.csv', [
  'url,coverage_state,google_canonical,user_canonical,last_crawl,in_sitemap',
  `${ORIGIN}/calculator-impozit-micro/,Submitted and indexed,${ORIGIN}/calculator-impozit-micro/,${ORIGIN}/calculator-impozit-micro/,2026-09-18,true`,
  `${ORIGIN}/impozit-micro-2026/,"Duplicate, Google chose different canonical than user",${ORIGIN}/calculator-impozit-micro/,${ORIGIN}/impozit-micro-2026/,2026-09-15,true`,
  `${ORIGIN}/blog/ghid-impozit-micro/,Crawled - currently not indexed,,${ORIGIN}/calculator-impozit-micro/,2026-09-10,true`,
  `${ORIGIN}/landing/vechi/,URL is unknown to Google,,,,true`,
].join('\n'));

// ---------- Marketer7 ----------

write('.marketer/project.md', `---
schema_version: 1
project_name: Fixture Micro Tax
created_at: 2026-07-20T00:00:00Z
next_mission_id: 2
next_experiment_id: 15
state_root: .marketer
---

# Marketer7 project

## Business context

Fixture-only project: a Romanian micro-company tax calculator. Values prove harness behavior, not business causality.
`);
write('.marketer/memory.md', `---
schema_version: 1
updated_at: 2026-08-27T00:00:00Z
---

# Marketer7 memory
`);
write('.marketer/metrics/baselines.md', `---
schema_version: 1
updated_at: 2026-08-28T00:00:00Z
---

# Marketer7 baselines

### BL-001
- Metric: organic_ctr
- Value: 1.1
- Period: 2026-08-01 to 2026-08-28
- Source: external reference pending (Analyzer7)
- Confidence: unknown
- Notes: Approximate reading from the Search Console UI; Analyzer7 records the canonical baseline.
`);
write('.marketer/metrics/funnel.json', JSON.stringify({schema_version: 1, updated_at: '2026-08-27T00:00:00Z', stages: [{name: 'organic_click', tier: 'click'}]}, null, 2));
write('.marketer/missions/M1-organic-calculator-demand/mission.md', `---
schema_version: 1
id: M1
title: Capture more organic calculator demand
status: active
owner: fixture-owner
created_at: 2026-08-20T00:00:00Z
primary_kpi: organic_ctr
primary_kpi_priority: decisive
primary_kpi_tier: click
baseline_status: known
---

# M1 — Capture more organic calculator demand

## Goal

Turn existing calculator impressions into more organic clicks.

## Why

The calculator already ranks on page one but converts few impressions into visits.

## KPIs

| Role | Metric | Business-value tier | Notes |
| --- | --- | --- | --- |
| Primary (decisive) | organic_ctr | click | Page-level CTR from Search Console. |

## Baseline

About 1.1% CTR for 2026-08-01 to 2026-08-28; the canonical baseline comes from Analyzer7.

## Definition of done

A source-linked verdict for EX-014 and a route decision.

## Constraints

- Fixture state only.

## Current route

Search-intent alignment of the calculator title and description.
`);

const experimentBody = `# EX-014 — Search-intent title for the micro tax calculator

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

`;
const lock = fingerprint(experimentBody);
write('.marketer/experiments/EX-014-seo-title-intent/experiment.md', `---
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

${experimentBody}## Criteria lock

Criteria were locked after the recorded review.

## Gate verdict

Verdict: pass

Actor: fixture-reviewer

At: 2026-08-25T10:01:00Z

Checked artifacts: \`review.md\`

Reasons:

- Measurable definition approved.

## Change history

- 2026-08-21T00:00:00Z — created as draft.
`);
write('.marketer/experiments/EX-014-seo-title-intent/review.md', `---
schema_version: 1
experiment_id: EX-014
status: passed
reviewed_at: 2026-08-25T10:00:00Z
reviewer: fixture-reviewer
criteria_fingerprint: ${lock.hash}
---

# Review — EX-014

## Findings

- advisory — Fixture values are not causal evidence.

## Locked definition snapshot

\`\`\`markdown
${lock.canonical}
\`\`\`

## Gate verdict

Verdict: pass

Actor: fixture-reviewer

At: 2026-08-25T10:00:00Z

Checked artifacts: \`experiment.md\`

Reasons:

- All pre-action checks pass.
`);
write('.marketer/experiments/EX-014-seo-title-intent/execution.md', `---
schema_version: 1
experiment_id: EX-014
mission_id: M1
status: completed
executor: signal7
brief_contract: signal7-execution-brief/v1
brief_path: contracts/signal7-execution-brief.md
dispatched_at: 2026-08-26T09:00:00Z
completed_at: 2026-08-28T12:43:00Z
---

# Execution record — EX-014

## Gate verdict

Verdict: pass

Actor: fixture-owner

At: 2026-08-26T09:00:00Z

Checked artifacts: \`experiment.md\`, \`review.md\`

Reasons:

- Approved criteria match the execution brief.

## Execution events

- 2026-08-28T12:43:00Z — completed — Signal7 S3 — factual completion only.
`);
write('.marketer/experiments/EX-014-seo-title-intent/evidence.md', `---
schema_version: 1
experiment_id: EX-014
entry_count: 0
updated_at: 2026-08-28T12:43:00Z
---

# Evidence — EX-014
`);
write('.marketer/experiments/EX-014-seo-title-intent/measurement.md', `---
schema_version: 1
experiment_id: EX-014
status: not_recorded
measurement_window: 2026-08-29T00:00:00Z to 2026-09-25T23:59:59Z
primary_metric: organic_ctr
primary_value: unknown
source_entry_ids: []
recorded_at: null
---

# Measurement — EX-014

## Gate verdict

Verdict: needs_input

Actor: fixture-owner

At: 2026-08-28T12:43:00Z

Checked artifacts: \`evidence.md\`

Reasons:

- Awaiting Analyzer7 evidence after the window closes.
`);
write('.marketer/experiments/EX-014-seo-title-intent/evaluation.md', `---
schema_version: 1
experiment_id: EX-014
status: not_started
verdict: null
evaluated_at: null
primary_metric: organic_ctr
primary_value: unknown
criteria_locked_at: 2026-08-25T10:00:00Z
evidence_strength: unknown
---

# Evaluation — EX-014
`);
write('.marketer/experiments/EX-014-seo-title-intent/contracts/signal7-execution-brief.md', `---
schema_version: 1
contract: signal7-execution-brief/v1
source_system: marketer7
mission_id: M1
experiment_id: EX-014
created_at: 2026-08-25T10:02:00Z
executor: signal7
tracking: {}
---

# Signal7 execution brief — EX-014

## Requested execution

- Action type: SEO title and meta description rewrite
- Audience: Romanian searchers for micro-company tax calculators
- Channel: organic search
`);

// ---------- Signal7 ----------

write('.signal/tasks/S3-seo-title-rewrite/task.md', `---
id: S3
title: Rewrite calculator title for search intent
phase: done
scope: quick
created: 2026-08-26T09:00:00
awaiting: null
source_system: marketer7
mission_id: M1
experiment_id: EX-014
tracking:
  utm_campaign: EX-014
execution_brief_path: /fixture-inputs/EX-014-signal7-execution-brief.md
---

# Rewrite calculator title for search intent
`);
write('.signal/tasks/S3-seo-title-rewrite/A1-seo-meta-ro.md', `---
id: A1
parent: S3
source_system: marketer7
mission_id: M1
experiment_id: EX-014
tracking:
  utm_campaign: EX-014
title: Calculator title and meta description (ro)
status: done
asset_type: seo-meta
channel: web
language: ro
review_ai_pass: true
generation_log:
  - timestamp: 2026-08-27T10:00:00
    worker: signal-copy
    worker_version: 1
    prompt_path: prompts/A1-r0-signal-copy.md
    prompt_hash: sha256:1111111111111111111111111111111111111111111111111111111111111111
    content_hash: sha256:2222222222222222222222222222222222222222222222222222222222222222
---

# Calculator title and meta description (ro)

## Content

Title: Calculator impozit micro 2026 — gratuit, actualizat
Description: Calculează în 30 de secunde impozitul microîntreprinderii pentru 2026.
`);
write('.signal/tasks/S3-seo-title-rewrite/publish-log.md', `# Publish Log — S3

- timestamp: 2026-08-28T12:43:00
  task_id: S3
  asset_id: A1
  channel: web
  publish_at: null
  actual_publish_time: 2026-08-28T12:43:00
  idempotency_key: sha256:3333333333333333333333333333333333333333333333333333333333333333
  status: published
  message: "fixture ledger entry"
  source_system: marketer7
  mission_id: M1
  experiment_id: EX-014
  tracking:
    utm_campaign: EX-014
`);
write('.signal/tasks/S3-seo-title-rewrite/execution-result.md', `---
schema_version: 1
contract: signal7-execution-result/v1
source_system: marketer7
mission_id: M1
experiment_id: EX-014
signal_task_id: S3
status: completed
tracking:
  utm_campaign: EX-014
updated_at: 2026-08-28T12:45:00
---

# Signal7 execution result — S3

## Events

| asset_id | status | channel | publication_url | timestamp | tracking | publish_ledger_reference |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | published | web | ${ORIGIN}/calculator-impozit-micro/ | 2026-08-28T12:43:00 | utm_campaign=EX-014 | publish-log.md#S3-A1-2026-08-28T12:43:00 |

This records executor-side facts only; no performance metric or experiment verdict is included.
`);
// A legacy Signal7 task: no origin metadata, no execution result, no URL.
write('.signal/tasks/S1-legacy-linkedin/task.md', `---
id: S1
title: LinkedIn post about the calculator
phase: done
scope: quick
created: 2026-08-10T08:00:00
awaiting: null
---

# LinkedIn post about the calculator
`);
write('.signal/tasks/S1-legacy-linkedin/A1-linkedin-ro.md', `---
id: A1
parent: S1
title: LinkedIn post (ro)
status: done
asset_type: social-post
channel: linkedin
language: ro
---

# LinkedIn post (ro)

## Content

Am lansat calculatorul de impozit micro.
`);
write('.signal/tasks/S1-legacy-linkedin/publish-log.md', `# Publish Log — S1

- timestamp: 2026-08-12T09:00:00
  task_id: S1
  asset_id: A1
  channel: linkedin
  publish_at: null
  actual_publish_time: 2026-08-12T09:00:00
  idempotency_key: sha256:4444444444444444444444444444444444444444444444444444444444444444
  status: published
  message: "legacy ledger entry without origin metadata"
`);

// ---------- Hyper7 ----------

write('.hyper/tasks/T7-fix-blog-canonical-tags/task.md', `---
id: T7
title: Fix canonical tags on blog guide pages
phase: done
scope: quick
created: 2026-09-10T08:30:00
bugfix: true
awaiting: null
---

# Fix canonical tags on blog guide pages
`);
write('.hyper/tasks/T8-research-competitor-calculators/task.md', `---
id: T8
title: Research competitor calculator UX
phase: done
scope: research
created: 2026-09-02T08:30:00
bugfix: false
awaiting: null
---

# Research competitor calculator UX
`);
write('.hyper/loops/L2-speed-up-calculator/loop.md', `---
id: L2
title: Speed up calculator page
status: active
created: 2026-09-15T10:00:00
updated: 2026-09-20T16:00:00
---

# L2 — Speed up calculator page
`);

// ---------- Scout7 ----------

write('.scout/batches/R1-competitor-calculators/batch.md', `---
id: R1
title: Competitor tax calculators
phase: discovery
awaiting: null
opened: 2026-09-05
rules_version: 1.0.0
---

# Batch R1 — Competitor tax calculators

## Phase log

| Date | Phase | Note |
|---|---|---|
| 2026-09-05 | frame | Two competitors launched free micro-tax calculators in early September. |
`);

write('README.md', `# Fixture Micro Tax

Deterministic consuming-project fixture for Analyzer7. Regenerate with \`node scripts/build-fixtures.mjs\`.

Known values (exact by construction):

| Page | Period | Impressions | Clicks | CTR |
| --- | --- | --- | --- | --- |
| /calculator-impozit-micro | 2026-08-01 → 2026-08-28 | 8400 | 92 | 1.0952% |
| /calculator-impozit-micro | 2026-08-29 → 2026-09-25 | 8680 | 208 | 2.3963% |

Conversion sources for 2026-09-01 → 2026-09-14: GA4 \`sign_up\` = 100, DB \`completed_registration\` = 91.
`);

console.log(`fixture written to ${path.relative(repository, target)} (EX-014 fingerprint ${lock.hash})`);
