// Optional Clarity behavioral context: adapter, SEO audit section, and the
// guarantee that behavior data never becomes evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {copyFixture, readSnapshot, run, setupEcosystem} from './helpers.mjs';

const NOW = '2026-09-25T12:00:00Z';
// Shaped like the Clarity Data Export API (project-live-insights) response.
const CLARITY = [
  {metricName: 'Traffic', information: [
    {totalSessionCount: '300', totalBotSessionCount: '12', distantUserCount: '250', PagesPerSessionPercentage: 1.4, URL: 'https://www.example.test/calculator-impozit-micro/', Device: 'Mobile'},
    {totalSessionCount: '100', totalBotSessionCount: '3', distantUserCount: '90', PagesPerSessionPercentage: 1.2, URL: 'https://www.example.test/calculator-impozit-micro/', Device: 'PC'},
  ]},
  {metricName: 'DeadClickCount', information: [
    {sessionsCount: '30', sessionsWithMetricPercentage: 10, subTotal: '41', URL: 'https://www.example.test/calculator-impozit-micro/', Device: 'Mobile'},
    {sessionsCount: '2', sessionsWithMetricPercentage: 2, subTotal: '2', URL: 'https://www.example.test/calculator-impozit-micro/', Device: 'PC'},
  ]},
  {metricName: 'RageClickCount', information: [{sessionsCount: '9', sessionsWithMetricPercentage: 3, URL: 'https://www.example.test/calculator-impozit-micro/', Device: 'Mobile'}]},
  {metricName: 'ScrollDepth', information: [{averageScrollDepth: 42.5, URL: 'https://www.example.test/calculator-impozit-micro/', Device: 'Mobile'}]},
];

function project() {
  const directory = setupEcosystem(copyFixture());
  run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', path.join(directory, 'inputs', 'gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'clarity', '--type', 'analytics', '--adapter', 'clarity', '--provider', 'microsoft_clarity', '--auth-method', 'api_key_env', '--env-vars', 'CLARITY_API_TOKEN', '--stale-after-hours', '9999', '--now', NOW]);
  const file = path.join(directory, 'inputs', 'clarity.json');
  fs.writeFileSync(file, JSON.stringify(CLARITY));
  return {directory, ingested: run('ingest.mjs', ['--project', directory, '--source', 'clarity', '--input', file, '--start', '2026-09-23', '--end', '2026-09-25', '--now', NOW])};
}

test('the Clarity adapter merges metric blocks per URL and device', () => {
  const {directory, ingested} = project();
  assert.equal(ingested.kind, 'behavior');
  const rows = readSnapshot(path.join(directory, ingested.observation)).rows;
  const mobile = rows.find((row) => row.device === 'mobile');
  assert.deepEqual([mobile.sessions, mobile.dead_click_pct, mobile.rage_click_pct, mobile.scroll_depth_pct], [300, 10, 3, 42.5]);
  assert.equal(rows.find((row) => row.device === 'pc').dead_click_pct, 2);
});

test('the SEO audit shows behavior context, and an unconfigured optional source is not a gap', () => {
  const {directory} = project();
  const result = run('seo.mjs', ['audit', '--project', directory, '--report', '--now', NOW]);
  const page = result.behavior.rows.find((row) => row.page === '/calculator-impozit-micro');
  assert.equal(page.sessions, 400);
  assert.equal(page.dead_click_pct, 8, 'sessions-weighted across devices: (300×10 + 100×2) / 400');
  assert.ok(!result.data_gaps.some((gap) => /Rankings/.test(gap)), 'no rank tracker is optional, not a gap');
  assert.equal(result.availability.find((entry) => entry.label === 'Rankings').health, 'not_configured (optional)');
  const report = fs.readFileSync(path.join(directory, result.report), 'utf8');
  assert.match(report, /## Behavior context \(Clarity, optional\)/);
  assert.match(report, /never evidence for a metric/);
});

test('behavioral data can never supply an evidence value', () => {
  const {directory} = project();
  const file = path.join(directory, '.analyzer', 'metrics.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.metrics.push({id: 'dead_click_rate', status: 'active', version: 1, kind: 'ratio', unit: 'percent', definition: 'Share of sessions with a dead click.', aggregation: 'mean', field: 'dead_click_pct', canonical_source: 'clarity', history: []});
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  const result = run('analyze.mjs', ['compare', '--project', directory, '--metric', 'dead_click_rate', '--before-start', '2026-09-20', '--before-end', '2026-09-22', '--after-start', '2026-09-23', '--after-end', '2026-09-25', '--now', NOW]).analysis;
  assert.equal(result.data_quality.level, 'insufficient');
  assert.ok(result.data_quality.issues.some((entry) => entry.code === 'not_a_metric_source'));
});
