// Regressions for defects found in independent review. Each test names the
// failure it prevents.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {days, readSnapshot, run, tempDir, validateState, writeCsv} from './helpers.mjs';
import {parseFrontmatter, serializeFrontmatter} from '../skills/analyzer/scripts/lib/core.mjs';
import {findSecrets, redact} from '../skills/analyzer/scripts/lib/redact.mjs';
import {totals} from '../skills/analyzer/scripts/lib/seo.mjs';

const NOW = '2026-10-01T08:00:00Z';

function project(metrics) {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--now', '2026-08-01T00:00:00Z']);
  run('record.mjs', ['source', '--project', directory, '--id', 'db', '--type', 'product', '--adapter', 'timeseries', '--auth-method', 'env', '--env-vars', 'DATABASE_URL', '--now', '2026-08-01T00:00:00Z']);
  const file = path.join(directory, '.analyzer', 'metrics.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.metrics.push(...metrics.map((metric) => ({status: 'active', version: 1, definition: `${metric.id} test metric`, canonical_source: 'db', history: [], ...metric})));
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  return directory;
}

function ingest(directory, name, header, rows, extra = []) {
  const file = writeCsv(path.join(directory, `${name}.csv`), header, rows);
  return run('ingest.mjs', ['--project', directory, '--source', 'db', '--input', file, ...extra, '--now', NOW]);
}

function compare(directory, metric, extra = []) {
  return run('analyze.mjs', ['compare', '--project', directory, '--metric', metric, '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', ...extra, '--now', NOW]);
}

const eightWeeks = days('2026-08-01', 56);

test('separately ingested series in one source are both readable (no per-date overwrite)', () => {
  const directory = project([
    {id: 'sessions', kind: 'count', aggregation: 'sum', series: 'sessions'},
    {id: 'conversion', kind: 'ratio', unit: 'percent', aggregation: 'ratio_of_sums', numerator: 'signups', denominator: 'sessions', scale: 100},
  ]);
  ingest(directory, 'sessions', 'date,metric,value', eightWeeks.map((date) => `${date},sessions,100`));
  ingest(directory, 'signups', 'date,metric,value', eightWeeks.map((date) => `${date},signups,5`));
  const sessions = compare(directory, 'sessions');
  assert.equal(sessions.analysis.comparison.before.value, 2800);
  assert.equal(compare(directory, 'conversion').analysis.comparison.after.value, 5);
});

test('segments ingested as separate pulls add up; a re-pull of the same slice replaces it', () => {
  const directory = project([{id: 'orders', kind: 'count', aggregation: 'sum', series: 'orders'}]);
  ingest(directory, 'de', 'date,metric,value', eightWeeks.map((date) => `${date},orders,100`), ['--set', 'segment=de']);
  ingest(directory, 'fr', 'date,metric,value', eightWeeks.map((date) => `${date},orders,300`), ['--set', 'segment=fr']);
  assert.equal(compare(directory, 'orders').analysis.comparison.before.value, 11200);
  assert.equal(compare(directory, 'orders', ['--segment', 'de']).analysis.comparison.before.value, 2800);
  ingest(directory, 'de-restated', 'date,metric,value', eightWeeks.map((date) => `${date},orders,110`), ['--set', 'segment=de', '--retrieved-at', '2026-10-01T09:00:00Z']);
  assert.equal(compare(directory, 'orders').analysis.comparison.before.value, 11480, 'the restated de slice supersedes the old one; fr is untouched');
});

test('a tracking break starting exactly at the period boundary is not evidence of a drop', () => {
  const directory = project([{id: 'signups', kind: 'count', aggregation: 'sum', series: 'signups', min_sample: 20}]);
  ingest(directory, 'signups', 'date,metric,value', eightWeeks.map((date, index) => `${date},signups,${index < 28 ? 40 : 0}`));
  run('record.mjs', ['change', '--project', directory, '--title', 'Pricing page', '--origin', 'manual', '--type', 'pricing_change', '--timestamp', '2026-08-28T12:00:00Z', '--now', NOW]);
  const result = compare(directory, 'signups', ['--change', 'CH-001']);
  assert.equal(result.analysis.data_quality.level, 'insufficient');
  assert.ok(result.analysis.data_quality.issues.some((entry) => entry.code === 'sudden_zero' && /tracking break/.test(entry.message)));
  assert.equal(result.analysis.causal_confidence.level, 'none');
  assert.match(result.interpretation, /INSUFFICIENT DATA/);
});

test('timeseries weighted means pair field and weight by date; blank cells stay unknown', () => {
  const directory = project([
    {id: 'aov', kind: 'mean', unit: 'currency', aggregation: 'weighted_mean', field: 'aov', weight: 'orders'},
    {id: 'latency', kind: 'mean', aggregation: 'mean', series: 'latency'},
  ]);
  ingest(directory, 'orders', 'date,metric,value', eightWeeks.flatMap((date, index) => [`${date},aov,${index < 28 ? 50 : 55}`, `${date},orders,10`]));
  assert.equal(compare(directory, 'aov').analysis.comparison.before.value, 50);
  assert.equal(compare(directory, 'aov').analysis.comparison.after.value, 55);
  ingest(directory, 'latency', 'date,metric,value', eightWeeks.map((date, index) => `${date},latency,${index === 3 ? '' : 100}`));
  const latency = compare(directory, 'latency');
  assert.equal(latency.analysis.comparison.before.value, 100, 'a blank day is skipped, not averaged in as 0');
  assert.ok(latency.analysis.data_quality.issues.some((entry) => entry.code === 'missing_values'));
  assert.equal(totals([{clicks: 1, impressions: 100, position: 4}, {clicks: 0, impressions: 100, position: null}]).avg_position, 4);
});

test('a metric whose series is absent from the source is insufficient, not HIGH', () => {
  const directory = project([{id: 'refunds', kind: 'count', aggregation: 'sum', series: 'refunds'}]);
  ingest(directory, 'signups', 'date,metric,value', eightWeeks.map((date) => `${date},signups,5`));
  const result = compare(directory, 'refunds');
  assert.equal(result.analysis.data_quality.level, 'insufficient');
  assert.ok(result.analysis.data_quality.issues.some((entry) => entry.code === 'metric_absent'));
});

test('a linked change that predates both periods gets no causal credit', () => {
  const directory = project([{id: 'signups', kind: 'count', aggregation: 'sum', series: 'signups'}]);
  ingest(directory, 'signups', 'date,metric,value', eightWeeks.map((date, index) => `${date},signups,${index < 28 ? 20 : 30}`));
  run('record.mjs', ['change', '--project', directory, '--title', 'Old release', '--origin', 'manual', '--type', 'product_release', '--timestamp', '2026-05-01T00:00:00Z', '--now', NOW]);
  const result = compare(directory, 'signups', ['--change', 'CH-001']);
  assert.equal(result.analysis.causal_confidence.level, 'none');
  assert.match(result.analysis.causal_confidence.reasons[0], /predates both compared periods/);
});

test('an unknown change id is an error, not a silently unlinked analysis', () => {
  const directory = project([{id: 'signups', kind: 'count', aggregation: 'sum', series: 'signups'}]);
  ingest(directory, 'signups', 'date,metric,value', eightWeeks.map((date) => `${date},signups,5`));
  const failed = run('analyze.mjs', ['compare', '--project', directory, '--metric', 'signups', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--change', 'CH-999', '--now', NOW], {expectFail: true});
  assert.match(failed.stderr, /unknown change id\(s\): CH-999/);
});

test('without a variance estimate a tiny shift is LOW, not MEDIUM', async () => {
  const {evidenceStrength} = await import('../skills/analyzer/scripts/lib/confidence.mjs');
  const comparison = {before: {value: 5, sample: 1000, days: 28}, after: {value: 5.01, sample: 1000, days: 28}, delta_abs: 0.01, delta_pct: 0.2, significance: {method: 'none', statistic: null}, persistence: {checked: false}};
  assert.equal(evidenceStrength({dataQuality: 'high', comparison, minSample: 10}).level, 'low');
  assert.equal(evidenceStrength({dataQuality: 'high', comparison: {...comparison, delta_pct: 40, delta_abs: 2}, minSample: 10}).level, 'medium');
});

test('source ids cannot escape .analyzer/', () => {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--now', NOW]);
  const failed = run('record.mjs', ['source', '--project', directory, '--id', '../../.marketer/x', '--type', 'product', '--adapter', 'timeseries', '--now', NOW], {expectFail: true});
  assert.match(failed.stderr, /source id must match/);
  assert.equal(fs.existsSync(path.join(directory, '.marketer')), false);
});

test('empty or future-dated exports do not advance source freshness', () => {
  const directory = project([{id: 'signups', kind: 'count', aggregation: 'sum', series: 'signups'}]);
  const empty = ingest(directory, 'empty', 'date,metric,value', [], ['--start', '2026-10-01', '--end', '2026-12-31']);
  assert.equal(empty.data_through, null);
  assert.ok(empty.warnings.some((warning) => /no rows/.test(warning)));
  const future = ingest(directory, 'future', 'date,metric,value', ['2026-09-30,signups,5', '2026-12-31,signups,5']);
  assert.equal(future.data_through, '2026-10-01', 'capped at the ingest date');
  assert.ok(future.warnings.some((warning) => /after the ingest date/.test(warning)));
});

test('frontmatter lists round-trip exactly; objects are refused', () => {
  const data = {items: ['a, b', 'c', 3, '007', 'say "hi"'], label: 'key: value'};
  assert.deepEqual(parseFrontmatter(`${serializeFrontmatter(data)}body`).data, data);
  assert.throws(() => serializeFrontmatter({nested: {a: 1}}), /nested objects/);
});

test('redaction keeps JSON rows and asset URLs intact and catches Token/X-Api-Key forms', () => {
  const row = '{"url":"https://example.com","q":"a@b"}';
  assert.equal(redact(row).text, row);
  assert.equal(redact('/images/hero@2x.png').text, '/images/hero@2x.png');
  for (const secret of ['Authorization: Token 3f9a8b7c6d5e4f3a2b1c', 'X-Api-Key 9f8e7d6c5b4a39281706', 'api key: abcdef0123456789abcd']) {
    const {text, count} = redact(secret);
    assert.ok(count > 0 && findSecrets(text).length === 0, secret);
  }
  assert.equal(redact('api key rotation policy').count, 0);
});

test('GSC JSON envelopes {data: {rows}} are accepted; non-row JSON is a usage error', () => {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--seed', 'seo', '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--auth-method', 'mcp', '--now', NOW]);
  const file = path.join(directory, 'gsc.json');
  fs.writeFileSync(file, JSON.stringify({data: {rows: [{keys: ['2026-09-01'], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2}]}}));
  assert.equal(run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', file, '--dimensions', 'date', '--now', NOW]).row_count, 1);
  fs.writeFileSync(file, JSON.stringify({message: 'quota exceeded'}));
  const failed = run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', file, '--dimensions', 'date', '--now', NOW], {expectFail: true});
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /no row array found/);
});

test('cannibalization ignores URLs beyond position 20, and recorded opportunities are capped per type', async () => {
  const {cannibalization} = await import('../skills/analyzer/scripts/lib/seo.mjs');
  const {DEFAULT_SEO_CONFIG} = await import('../skills/analyzer/scripts/lib/state.mjs');
  const rows = [
    {query: 'cmr vrachtbrief', page: '/nl/a', clicks: 1, impressions: 300, position: 35},
    {query: 'cmr vrachtbrief', page: '/nl/b', clicks: 0, impressions: 250, position: 50},
    {query: 'cmr pdf', page: '/pl/a', clicks: 20, impressions: 600, position: 7.7},
    {query: 'cmr pdf', page: '/pl/b', clicks: 8, impressions: 300, position: 9.7},
  ];
  assert.deepEqual(cannibalization(rows, DEFAULT_SEO_CONFIG).map((finding) => finding.query), ['cmr pdf'], 'pages at 35 and 50 do not compete with each other in any meaningful sense');
  assert.equal(DEFAULT_SEO_CONFIG.thresholds.max_recorded_per_type, 10);
});

test('scripts work when invoked through an installed symlink', async () => {
  const {spawnSync} = await import('node:child_process');
  const {REPO} = await import('./helpers.mjs');
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--now', NOW]);
  const linked = path.join(tempDir(), 'analyzer');
  fs.symlinkSync(path.join(REPO, 'skills', 'analyzer'), linked);
  const result = spawnSync(process.execPath, [path.join(linked, 'scripts', 'validate-state.mjs'), '--project', directory], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PASS — Analyzer7 state validation/, 'validation must actually run, not silently exit 0');
});

test('missing GSC clicks/impressions stay unknown, not zero', () => {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--seed', 'seo', '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--auth-method', 'mcp', '--now', NOW]);
  const file = writeCsv(path.join(directory, 'gsc.csv'), 'date,clicks,impressions', eightWeeks.map((date, index) => `${date},${index === 40 ? '' : 10},${index === 41 ? 'n/a' : 200}`));
  run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', file, '--now', NOW]);
  const snapshot = readSnapshot(path.join(directory, '.analyzer', 'observations', 'gsc', fs.readdirSync(path.join(directory, '.analyzer', 'observations', 'gsc'))[0]));
  assert.equal(snapshot.rows[40].clicks, null);
  assert.equal(snapshot.rows[41].impressions, null);
  const clicks = compare(directory, 'organic_clicks');
  assert.equal(clicks.analysis.comparison.after.value, 270, '27 known of 28 days × 10; the blank day is skipped, not counted as 0');
  assert.ok(clicks.analysis.data_quality.issues.some((entry) => entry.code === 'missing_values'));
  const ctr = compare(directory, 'organic_ctr');
  assert.equal(ctr.analysis.comparison.after.value, 5, 'rows missing either side of the ratio are excluded from both');
});

function monitorFixture(rows, metric, monitor) {
  const directory = project([metric]);
  ingest(directory, 'series', 'date,metric,value', rows);
  fs.writeFileSync(path.join(directory, '.analyzer', 'monitors.json'), JSON.stringify({schema_version: 1, monitors: [monitor]}));
  return run('analyze.mjs', ['monitor', '--project', directory, '--now', NOW]).results[0];
}

test('monitor: an unknown significance fails the guard', () => {
  const dates = days('2026-09-20', 6);
  const result = monitorFixture(dates.map((date, index) => `${date},score,${index < 3 ? 10 : 20}`), {id: 'score', kind: 'mean', aggregation: 'mean', series: 'score', min_sample: 1}, {id: 'MON-score', metric: 'score', window_days: 3, relative_threshold_pct: 25, absolute_threshold: 1, min_sample: 1});
  assert.equal(result.outcome, 'quiet');
  assert.equal(result.checks.significance, false);
  assert.match(result.reason, /no variance estimate/);
});

test('monitor: count collapse from a reliable baseline alerts; small-denominator ratios do not', () => {
  const dates = days('2026-09-17', 14);
  const collapse = monitorFixture(dates.map((date, index) => `${date},signups,${index < 7 ? 20 : 1}`), {id: 'signups', kind: 'count', aggregation: 'sum', series: 'signups', min_sample: 1}, {id: 'MON-signups', metric: 'signups', window_days: 7, relative_threshold_pct: 25, absolute_threshold: 10, min_sample: 50, direction: 'decrease'});
  assert.equal(collapse.outcome, 'alert', '140 → 7 counts from a 140-count baseline is a real signal');
  const ratio = monitorFixture(dates.flatMap((date, index) => [`${date},visits,${index < 7 ? 100 : 1}`, `${date},signups,${index < 7 ? 10 : (index % 2)}`]), {id: 'conversion', kind: 'ratio', unit: 'percent', aggregation: 'ratio_of_sums', numerator: 'signups', denominator: 'visits', scale: 100, min_sample: 1}, {id: 'MON-conv', metric: 'conversion', window_days: 7, relative_threshold_pct: 25, absolute_threshold: 1, min_sample: 50});
  assert.equal(ratio.checks.sample, false, 'a 7-visit current window cannot support a conversion-rate alert');
  assert.equal(ratio.outcome, 'quiet');
});

test('seo audit: a partial date window is a usage error, never a silent fallback', () => {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--seed', 'seo', '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--auth-method', 'mcp', '--now', NOW]);
  const failed = run('seo.mjs', ['audit', '--project', directory, '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--now', NOW], {expectFail: true});
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /pass all four/);
});

test('seo report: zero baseline volume never prints Infinity or NaN', () => {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--seed', 'seo', '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--auth-method', 'mcp', '--now', NOW]);
  const file = writeCsv(path.join(directory, 'site.csv'), 'date,clicks,impressions,ctr,position', eightWeeks.map((date, index) => `${date},${index < 28 ? 0 : 5},${index < 28 ? 0 : 100},0,8`));
  run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', file, '--now', NOW]);
  const result = run('seo.mjs', ['audit', '--project', directory, '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--report', '--now', NOW]);
  const report = fs.readFileSync(path.join(directory, result.report), 'utf8');
  assert.doesNotMatch(report, /Infinity|NaN/);
  assert.match(report, /new \(no baseline volume\)/);
});

test('rank changes follow the observed date, so a backfilled older snapshot is "previous"', () => {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'rankings', '--type', 'ranking', '--adapter', 'rankings', '--auth-method', 'export', '--stale-after-hours', '720', '--now', NOW]);
  const later = writeCsv(path.join(directory, 'later.csv'), 'keyword,position,observed_at', ['cmr pdf,5,2026-09-15T06:00:00Z']);
  const earlier = writeCsv(path.join(directory, 'earlier.csv'), 'keyword,position,observed_at', ['cmr pdf,20,2026-09-01T06:00:00Z']);
  run('ingest.mjs', ['--project', directory, '--source', 'rankings', '--input', later, '--retrieved-at', '2026-09-15T07:00:00Z', '--now', NOW]);
  run('ingest.mjs', ['--project', directory, '--source', 'rankings', '--input', earlier, '--retrieved-at', '2026-09-20T07:00:00Z', '--now', NOW]);
  const change = run('seo.mjs', ['rankings', '--project', directory, '--source', 'rankings', '--now', NOW]).rankings.changes[0];
  assert.equal(change.previous_position, 20);
  assert.equal(change.current_position, 5);
  assert.equal(change.movement, 'big_win', 'the backfill must not invert the timeline');
});

test('timeseries: non-numeric columns are dimensions, not phantom metrics', () => {
  const directory = project([{id: 'revenue', kind: 'count', aggregation: 'sum', series: 'revenue'}]);
  const result = ingest(directory, 'wide', 'date,country,device,revenue,signups', eightWeeks.flatMap((date) => [`${date},RO,mobile,100,3`, `${date},DE,desktop,50,1`]));
  assert.deepEqual(result.dimensions, ['date', 'metric', 'country', 'device']);
  const snapshot = readSnapshot(path.join(directory, result.observation));
  assert.deepEqual([...new Set(snapshot.rows.map((row) => row.metric))].sort(), ['revenue', 'signups']);
  assert.equal(compare(directory, 'revenue').analysis.comparison.before.value, 4200);
  assert.equal(compare(directory, 'revenue', ['--country', 'RO']).analysis.comparison.before.value, 2800);
});

test('compaction: snapshots are gzipped, old references still resolve, and pruning leaves a verifiable tombstone', async () => {
  const zlib = await import('node:zlib');
  const directory = project([{id: 'signups', kind: 'count', aggregation: 'sum', series: 'signups'}]);
  const recent = ingest(directory, 'recent', 'date,metric,value', eightWeeks.map((date) => `${date},signups,5`));
  assert.match(recent.observation, /\.json\.gz$/);
  // A legacy uncompressed snapshot, referenced by evidence, plus an old unreferenced one.
  const legacyDir = path.join(directory, '.analyzer', 'observations', 'db');
  const legacy = readSnapshot(path.join(directory, recent.observation));
  fs.writeFileSync(path.join(legacyDir, '2026-09-25-timeseries-legacy.json'), JSON.stringify(legacy, null, 2));
  const old = ingest(directory, 'old', 'date,metric,value', days('2025-01-01', 28).map((date) => `${date},signups,4`));
  compare(directory, 'signups');
  run('analyze.mjs', ['compare', '--project', directory, '--metric', 'signups', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--record', '--title', 'signups', '--now', NOW]);
  const evidenceDir = path.join(directory, '.analyzer', 'evidence');
  const evidenceFile = path.join(evidenceDir, fs.readdirSync(evidenceDir).find((name) => name.startsWith('EV-001')));
  fs.appendFileSync(evidenceFile, '\nLegacy reference: `.analyzer/observations/db/2026-09-25-timeseries-legacy.json`\n');
  const before = fs.readFileSync(path.join(legacyDir, '2026-09-25-timeseries-legacy.json')).length;
  const result = run('analyze.mjs', ['compact', '--project', directory, '--prune-unreferenced', '--older-than-days', '180', '--now', NOW]);
  assert.equal(result.converted, 1);
  assert.ok(fs.statSync(path.join(legacyDir, '2026-09-25-timeseries-legacy.json.gz')).size < before / 3, 'gzip shrinks the snapshot');
  assert.deepEqual(result.pruned, [old.observation], 'only the old, unreferenced, non-newest snapshot is pruned');
  const tombstones = fs.readFileSync(path.join(legacyDir, '..', 'pruned.md'), 'utf8');
  assert.match(tombstones, new RegExp(`${old.observation.replace(/\.gz$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — source db, timeseries`));
  assert.match(tombstones, /rows_sha256 [0-9a-f]{64}/);
  assert.equal(compare(directory, 'signups').analysis.comparison.before.value, 140, 'analysis still reads the compacted data');
  assert.ok(validateState(directory).ok, validateState(directory).output);
  assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(directory, recent.observation))).length > 0);
});

test('a timezone mismatch is informational over 7+ day windows and minor over shorter ones', () => {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--seed', 'seo', '--timezone', 'Europe/Bucharest', '--now', NOW]);
  run('record.mjs', ['source', '--project', directory, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--auth-method', 'mcp', '--timezone', 'America/Los_Angeles', '--stale-after-hours', '9999', '--now', NOW]);
  run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', writeCsv(path.join(directory, 'site.csv'), 'date,clicks,impressions,ctr,position', eightWeeks.map((date) => `${date},50,1000,0.05,6`)), '--now', NOW]);
  const long = run('analyze.mjs', ['compare', '--project', directory, '--metric', 'organic_clicks', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--now', NOW]).analysis;
  assert.equal(long.data_quality.issues.find((entry) => entry.code === 'timezone_mismatch').severity, 'info');
  assert.equal(long.data_quality.level, 'high');
  const short = run('analyze.mjs', ['compare', '--project', directory, '--metric', 'organic_clicks', '--before-start', '2026-09-20', '--before-end', '2026-09-22', '--after-start', '2026-09-23', '--after-end', '2026-09-25', '--now', NOW]).analysis;
  assert.equal(short.data_quality.issues.find((entry) => entry.code === 'timezone_mismatch').severity, 'minor');
  assert.equal(short.data_quality.level, 'medium');
});
