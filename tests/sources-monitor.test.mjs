// Conflicting sources, canonical-source rules, monitors, and data-quality checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {T, copyFixture, days, run, setupEcosystem, tempDir, validateState, writeCsv} from './helpers.mjs';
import {checkPeriodRows, checkSuddenZero, levelFromIssues} from '../skills/analyzer/scripts/lib/quality.mjs';
import {aggregate, comparePeriods, resolveMapping} from '../skills/analyzer/scripts/lib/stats.mjs';

function addSignupsMetric(project) {
  const file = path.join(project, '.analyzer', 'metrics.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.metrics.push({id: 'signups', label: 'Completed registrations', status: 'active', version: 1, kind: 'count', unit: 'signups', definition: 'Accounts that completed registration (DB row in users with verified email).', aggregation: 'sum', canonical_source: 'db', fallback_sources: ['ga4'], source_mappings: {db: {series: 'completed_registration'}, ga4: {series: 'sign_up'}}, direction: 'higher_is_better', evidence_grade: 'A', marketer_tier: 'signup', min_sample: 20, discrepancy_tolerance_pct: 5, limitations: ['GA4 loses events to consent mode and ad blockers.'], history: []});
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

function setupConversions(project) {
  setupEcosystem(project);
  addSignupsMetric(project);
  run('record.mjs', ['source', '--project', project, '--id', 'db', '--type', 'product', '--adapter', 'timeseries', '--provider', 'postgres', '--auth-method', 'env', '--env-vars', 'DATABASE_URL', '--timezone', 'Europe/Bucharest', '--now', T.planning]);
  run('record.mjs', ['source', '--project', project, '--id', 'ga4', '--type', 'analytics', '--adapter', 'timeseries', '--provider', 'google_analytics_4', '--property', 'properties/123456', '--auth-method', 'mcp', '--timezone', 'Europe/Bucharest', '--now', T.planning]);
  run('ingest.mjs', ['--project', project, '--source', 'db', '--input', path.join(project, 'inputs', 'db-registrations-2026-09-01_2026-09-14.csv'), '--now', '2026-09-15T08:00:00Z']);
  run('ingest.mjs', ['--project', project, '--source', 'ga4', '--input', path.join(project, 'inputs', 'ga4-sign-up-2026-09-01_2026-09-14.csv'), '--metric', 'sign_up', '--now', '2026-09-15T08:00:00Z']);
  return project;
}

test('conflicting sources: GA4 100 vs DB 91 is surfaced, and the canonical source is the value', () => {
  const project = setupConversions(copyFixture());
  const result = run('analyze.mjs', ['discrepancy', '--project', project, '--metric', 'signups', '--start', '2026-09-01', '--end', '2026-09-14', '--record', '--now', '2026-09-15T09:00:00Z']);
  assert.equal(result.status, 'discrepancy');
  assert.equal(result.canonical_source, 'db');
  assert.equal(result.canonical_value, 91);
  assert.deepEqual(result.values.map((entry) => [entry.source_id, entry.value]), [['db', 91], ['ga4', 100]]);
  assert.equal(result.findings[0].difference_pct, 9.89);
  assert.match(result.rule, /never silently substituted/);
  assert.equal(result.anomaly.status, 'opened');
  const again = run('analyze.mjs', ['discrepancy', '--project', project, '--metric', 'signups', '--start', '2026-09-01', '--end', '2026-09-14', '--record', '--now', '2026-09-15T10:00:00Z']);
  assert.equal(again.anomaly.status, 'already_open', 'an open discrepancy is not duplicated');
  assert.ok(validateState(project).ok, validateState(project).output);
});

test('conflicting sources: an analysis over a disputed metric is downgraded, not averaged', () => {
  const project = setupConversions(copyFixture());
  const result = run('analyze.mjs', ['compare', '--project', project, '--metric', 'signups', '--before-start', '2026-09-01', '--before-end', '2026-09-07', '--after-start', '2026-09-08', '--after-end', '2026-09-14', '--now', '2026-09-15T09:00:00Z']);
  assert.equal(result.analysis.source_id, 'db');
  assert.ok(result.analysis.discrepancies.length > 0);
  assert.ok(result.analysis.data_quality.issues.some((entry) => entry.code === 'source_discrepancy'));
  assert.equal(result.analysis.data_quality.level, 'low');
  const total = result.analysis.comparison.before.value + result.analysis.comparison.after.value;
  assert.equal(total, 91, 'the reported values are the canonical DB values');
});

function monitorProject(series) {
  const project = tempDir();
  run('init.mjs', ['--project', project, '--now', '2026-09-01T00:00:00Z']);
  run('record.mjs', ['source', '--project', project, '--id', 'db', '--type', 'product', '--adapter', 'timeseries', '--auth-method', 'env', '--env-vars', 'DATABASE_URL', '--now', '2026-09-01T00:00:00Z']);
  const file = path.join(project, '.analyzer', 'metrics.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.metrics.push({id: 'signups', status: 'active', version: 1, kind: 'count', unit: 'signups', definition: 'Completed registrations.', aggregation: 'sum', canonical_source: 'db', series: 'signups', min_sample: 50, history: []});
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  fs.writeFileSync(path.join(project, '.analyzer', 'monitors.json'), JSON.stringify({schema_version: 1, monitors: [{id: 'MON-signups', metric: 'signups', window_days: 7, relative_threshold_pct: 25, absolute_threshold: 10, min_sample: 50, direction: 'decrease', severity: 'high'}]}, null, 2));
  const dates = days('2026-09-01', 14);
  writeCsv(path.join(project, 'signups.csv'), 'date,metric,value', dates.map((date, index) => `${date},signups,${series[index]}`));
  run('ingest.mjs', ['--project', project, '--source', 'db', '--input', path.join(project, 'signups.csv'), '--now', '2026-09-15T06:00:00Z']);
  return project;
}

test('monitor: a real, significant drop alerts once; the second run does not duplicate it', () => {
  const project = monitorProject([20, 21, 19, 22, 20, 18, 21, 12, 11, 13, 12, 11, 12, 13]);
  const dry = run('analyze.mjs', ['monitor', '--project', project, '--now', '2026-09-15T08:00:00Z']);
  assert.equal(dry.alerts, 1);
  assert.equal(dry.results[0].kind, 'threshold_breach');
  assert.equal(fs.existsSync(path.join(project, '.analyzer', 'anomalies')), false, 'a dry run records nothing');
  const recorded = run('analyze.mjs', ['monitor', '--project', project, '--record', '--now', '2026-09-15T08:00:00Z']);
  assert.equal(recorded.results[0].anomaly.status, 'opened');
  const again = run('analyze.mjs', ['monitor', '--project', project, '--record', '--now', '2026-09-16T08:00:00Z']);
  assert.equal(again.results[0].anomaly.status, 'already_open');
  const probe = run('state.mjs', ['--project', project, '--now', '2026-09-16T08:00:00Z']);
  assert.equal(probe.anomalies.open.length, 1);
  assert.match(probe.next_action, /review open anomaly AN-001/);
  run('record.mjs', ['status', '--project', project, '--id', 'AN-001', '--status', 'resolved', '--note', 'confirmed: signup form bug fixed by Hyper7 T12', '--now', '2026-09-17T08:00:00Z']);
  assert.equal(run('state.mjs', ['--project', project, '--now', '2026-09-17T09:00:00Z']).anomalies.open.length, 0);
  assert.ok(validateState(project).ok, validateState(project).output);
});

test('monitor: noise does not alert (relative threshold and significance guards)', () => {
  const project = monitorProject([20, 23, 17, 22, 18, 21, 19, 18, 22, 17, 20, 19, 18, 20]);
  const result = run('analyze.mjs', ['monitor', '--project', project, '--now', '2026-09-15T08:00:00Z']);
  assert.equal(result.alerts, 0);
  assert.equal(result.results[0].outcome, 'quiet');
  assert.match(result.results[0].reason, /not alerted: .*relative/);
});

test('monitor: vanished data is a tracking break, not a real collapse', () => {
  const project = monitorProject([20, 21, 19, 22, 20, 18, 21, 19, 20, 0, 0, 0, 0, 0]);
  const result = run('analyze.mjs', ['monitor', '--project', project, '--now', '2026-09-15T08:00:00Z']);
  assert.equal(result.alerts, 1);
  assert.equal(result.results[0].kind, 'tracking_break');
  assert.match(result.results[0].reason, /likely a tracking or pipeline break/);
});

test('monitor: a small sample never alerts', () => {
  const project = monitorProject([3, 2, 4, 3, 2, 3, 4, 1, 1, 0, 1, 1, 1, 1]);
  const result = run('analyze.mjs', ['monitor', '--project', project, '--now', '2026-09-15T08:00:00Z']);
  assert.equal(result.alerts, 0);
});

test('data quality: missing dates, duplicates, sudden zeros, and severities', () => {
  const period = {start: '2026-09-01', end: '2026-09-10'};
  const rows = days('2026-09-01', 10).filter((date) => date !== '2026-09-05').map((date) => ({date, page: '/a', clicks: 5, impressions: 100}));
  rows.push({...rows[0]});
  const issues = checkPeriodRows(rows, {period, label: 'after', expectDaily: true, dimensions: ['page'], numericFields: ['clicks', 'impressions']});
  assert.deepEqual(issues.map((entry) => [entry.code, entry.severity]), [['missing_dates', 'minor'], ['duplicate_rows', 'major']]);
  assert.equal(levelFromIssues(issues), 'low');
  assert.equal(levelFromIssues([]), 'high');
  assert.equal(checkPeriodRows([], {period, label: 'after', expectDaily: true})[0].severity, 'blocking');
  const incomplete = checkPeriodRows(rows, {period, label: 'after', expectDaily: true, dataThrough: '2026-09-03'});
  assert.ok(incomplete.some((entry) => entry.code === 'incomplete_period' && entry.severity === 'blocking'));
  const zero = checkSuddenZero([10, 12, 11, 0, 0, 9].map((value, index) => ({date: `2026-09-0${index + 1}`, value})));
  assert.equal(zero[0].code, 'sudden_zero');
});

test('stats: ratios are ratios of sums and counts compare per day across unequal windows', () => {
  const metric = {id: 'organic_ctr', aggregation: 'ratio_of_sums', numerator: 'clicks', denominator: 'impressions', scale: 100};
  const mapping = resolveMapping(metric, 'gsc');
  const value = aggregate([{clicks: 1, impressions: 10}, {clicks: 99, impressions: 990}], mapping, 'gsc_rows').value;
  assert.equal(value, 10, 'not the 10% average of 10% and 10% by accident: (1+99)/(10+990)');
  const skewed = aggregate([{clicks: 5, impressions: 10}, {clicks: 10, impressions: 990}], mapping, 'gsc_rows').value;
  assert.equal(Math.round(skewed * 100) / 100, 1.5, 'a mean of daily CTRs would say 25.5%');
  const clicks = {id: 'organic_clicks', aggregation: 'sum', field: 'clicks'};
  const before = days('2026-08-01', 30).map((date) => ({date, clicks: 10}));
  const after = days('2026-09-01', 31).map((date) => ({date, clicks: 10}));
  const comparison = comparePeriods({metric: clicks, sourceId: 'gsc', kind: 'gsc_rows', beforeRows: before, afterRows: after, before: {start: '2026-08-01', end: '2026-08-30'}, after: {start: '2026-09-01', end: '2026-10-01'}});
  assert.equal(comparison.basis, 'per_day');
  assert.equal(comparison.delta_pct, 0, 'a 31-day month is not a 3% gain over a 30-day month');
});
