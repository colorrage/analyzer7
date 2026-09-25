// Control groups (difference-in-differences) and year-over-year seasonality.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {days, run, tempDir, writeCsv} from './helpers.mjs';

const NOW = '2026-10-01T08:00:00Z';
const WINDOWS = ['--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25'];
const TREATED = ['/pl/a', '/pl/b'];
const CONTROLS = ['/pl/c', '/pl/d', '/pl/e', '/pl/f'];

// Daily page rows: every page gets `seasonal` × volume after the boundary;
// treated pages get an extra `lift` on clicks; `treatedTrend` adds a
// pre-existing upward drift to treated pages in the before window.
function pageRows(start, count, boundaryIndex, {seasonal = 1.3, lift = 1.2, treatedTrend = 0} = {}) {
  const rows = [];
  days(start, count).forEach((date, index) => {
    const weekday = 1 + 0.08 * Math.sin((index * 2 * Math.PI) / 7);
    for (const page of [...TREATED, ...CONTROLS, '/de/x']) {
      const treated = TREATED.includes(page);
      const after = index >= boundaryIndex;
      const drift = treated && !after ? 1 + treatedTrend * (index / boundaryIndex) : 1 + (treated && after ? treatedTrend : 0);
      const impressions = Math.round(1000 * weekday * (after ? seasonal : 1));
      const clicks = Math.round(30 * weekday * (after ? seasonal : 1) * (treated && after ? lift : 1) * drift);
      rows.push(`${date},https://www.example.test${page}/,${clicks},${impressions},${(clicks / impressions).toFixed(4)},6`);
    }
  });
  return rows;
}

function setup({lastYear = null, ...options} = {}) {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--seed', 'seo', '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--auth-method', 'mcp', '--stale-after-hours', '9999', '--now', NOW]);
  const header = 'date,page,clicks,impressions,ctr,position';
  run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', writeCsv(path.join(directory, 'pages.csv'), header, pageRows('2026-08-01', 56, 28, options)), '--now', NOW]);
  if (lastYear) run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', writeCsv(path.join(directory, 'pages-ly.csv'), header, pageRows('2025-08-02', 56, 28, lastYear)), '--now', NOW]);
  run('record.mjs', ['change', '--project', directory, '--title', 'Title rewrite on /pl/a and /pl/b', '--origin', 'manual', '--type', 'seo_content_update', '--timestamp', '2026-08-28T18:00:00Z', '--basis', 'deploy_log', '--pages', TREATED.join(','), '--now', NOW]);
  return directory;
}

function compare(directory, extra = []) {
  return run('analyze.mjs', ['compare', '--project', directory, '--metric', 'organic_clicks', '--page', TREATED.join(','), '--change', 'CH-001', ...WINDOWS, ...extra, '--now', NOW]).analysis;
}

test('difference-in-differences isolates the lift from a shared seasonal rise', () => {
  const directory = setup();
  const controlled = compare(directory);
  assert.equal(controlled.design, 'difference_in_differences');
  assert.equal(controlled.control.pages, 4, 'untouched /pl/ pages only; /de/x is another market');
  assert.equal(controlled.control.pre_trend.passed, true);
  assert.ok(Math.abs(controlled.control.effect - 26) < 3, `net effect ≈ +26 points of the before level, got ${controlled.control.effect}`);
  assert.ok(!controlled.confounders.some((entry) => entry.code === 'demand_shift'), 'demand rose for both groups, so it nets out');
  assert.equal(controlled.causal_confidence.level, 'high');

  const plain = compare(directory, ['--control', 'none']);
  assert.equal(plain.design, 'before_after');
  assert.ok(plain.comparison.delta_pct > 50, 'before/after sees the seasonal rise and the lift together');
  assert.ok(plain.confounders.some((entry) => entry.code === 'demand_shift'));
  assert.equal(plain.causal_confidence.level, 'medium');
});

test('diverging pre-trends are a major confounder even with a control group', () => {
  const directory = setup({treatedTrend: 0.6});
  const analysis = compare(directory);
  assert.equal(analysis.design, 'difference_in_differences');
  assert.equal(analysis.control.pre_trend.passed, false);
  assert.ok(analysis.confounders.some((entry) => entry.code === 'parallel_trends_violated' && entry.severity === 'major'));
  assert.notEqual(analysis.causal_confidence.level, 'high');
});

test('year-over-year: last year\'s identical seasonal jump is a major confounder for before/after', () => {
  const directory = setup({lastYear: {seasonal: 1.5, lift: 1}});
  const plain = compare(directory, ['--control', 'none']);
  assert.equal(plain.seasonality.checked, true);
  assert.ok(plain.seasonality.last_year_change_pct > 40);
  assert.ok(plain.confounders.some((entry) => entry.code === 'seasonal_pattern' && entry.severity === 'major'));
  assert.equal(plain.causal_confidence.level, 'low');
  const controlled = compare(directory);
  assert.ok(controlled.confounders.some((entry) => entry.code === 'seasonal_pattern' && entry.severity === 'info'), 'a control group absorbs shared seasonality');
});

test('--yoy compares the after window with the same weeks last year', () => {
  const directory = setup({lastYear: {seasonal: 1, lift: 1}});
  const result = run('analyze.mjs', ['compare', '--project', directory, '--metric', 'organic_clicks', '--page', TREATED.join(','), '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--yoy', '--control', 'none', '--now', NOW]).analysis;
  assert.deepEqual(result.before, {start: '2025-08-30', end: '2025-09-26'});
  assert.ok(result.comparison.delta_pct > 50);
});

test('an experiment plan fixes its control pages before any outcome is seen', () => {
  const directory = setup();
  fs.cpSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'analyzer', 'ecosystem', '.marketer'), path.join(directory, '.marketer'), {recursive: true});
  const plan = run('experiment.mjs', ['plan', '--project', directory, '--experiment', 'EX-014', '--page', TREATED.join(','), '--now', NOW]);
  const text = fs.readFileSync(path.join(directory, plan.plan), 'utf8');
  assert.match(text, /^control_mode: auto$/m);
  assert.match(text, /^control_pages: \[\/pl\/c, \/pl\/d, \/pl\/e, \/pl\/f\]$/m);
  assert.match(text, /control group: 4 page\(s\), fixed at planning/);
});
