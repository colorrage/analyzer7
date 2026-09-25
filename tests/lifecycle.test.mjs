// Fresh project, resume, missing source, and stale source scenarios.
// Run: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {T, copyFixture, evaluateEx014, hashTree, ingestDailyPages, neighborHashes, run, setupEcosystem, tempDir, validateState} from './helpers.mjs';

test('fresh project: the probe writes nothing and init bootstraps safely and idempotently', () => {
  const project = tempDir();
  const probe = run('state.mjs', ['--project', project, '--now', T.planning]);
  assert.equal(probe.initialized, false);
  assert.match(probe.next_action, /initialize/);
  assert.equal(fs.existsSync(path.join(project, '.analyzer')), false, 'the probe must be read-only');

  const init = run('init.mjs', ['--project', project, '--now', T.planning]);
  assert.equal(init.status, 'initialized');
  for (const file of ['project.md', 'context.md', 'sources.json', 'metrics.json', 'monitors.json', 'seo/config.json', 'memory.md']) {
    assert.ok(fs.existsSync(path.join(project, '.analyzer', file)), `${file} should exist`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.analyzer', 'sources.json'), 'utf8')).sources, [], 'no source is assumed');
  assert.ok(validateState(project).ok, validateState(project).output);

  const before = hashTree(path.join(project, '.analyzer'));
  const again = run('init.mjs', ['--project', project, '--seed', 'seo', '--now', T.ingest]);
  assert.equal(again.status, 'already_initialized');
  assert.equal(hashTree(path.join(project, '.analyzer')), before, 'a second init must not change anything');

  const resumed = run('state.mjs', ['--project', project, '--now', T.planning]);
  assert.equal(resumed.initialized, true);
  assert.match(resumed.next_action, /register the available data sources/);
});

test('fresh project with neighbors: init reads neighbor state into context and never writes it', () => {
  const project = copyFixture();
  const neighbors = neighborHashes(project);
  run('init.mjs', ['--project', project, '--seed', 'seo,funnel', '--now', T.planning]);
  assert.deepEqual(neighborHashes(project), neighbors);
  const context = fs.readFileSync(path.join(project, '.analyzer', 'context.md'), 'utf8');
  assert.match(context, /Marketer7 \(`\.marketer\/`\): 1 mission\(s\), 1 experiment\(s\) — EX-014 measurement_pending/);
  assert.match(context, /Signal7 \(`\.signal\/`\): 2 task\(s\), 2 published asset\(s\)/);
  const metrics = JSON.parse(fs.readFileSync(path.join(project, '.analyzer', 'metrics.json'), 'utf8')).metrics;
  assert.equal(metrics.find((metric) => metric.id === 'organic_ctr').status, 'active');
  assert.equal(metrics.find((metric) => metric.id === 'signups').status, 'proposed', 'project-specific funnel metrics start unconfirmed');
  const probe = run('state.mjs', ['--project', project, '--now', T.planning]);
  assert.deepEqual(probe.metrics.proposed.sort(), ['activated_users', 'paid_conversions', 'retained_paid_users', 'returning_users_30d', 'returning_users_7d', 'signups', 'visitors']);
});

test('resume: an existing project reconstructs its analytical picture without restarting analysis', () => {
  const project = setupEcosystem(copyFixture());
  evaluateEx014(project);
  run('record.mjs', ['source', '--project', project, '--id', 'rankings', '--type', 'ranking', '--adapter', 'rankings', '--auth-method', 'export', '--stale-after-hours', '48', '--now', T.planning]);
  run('ingest.mjs', ['--project', project, '--source', 'rankings', '--input', path.join(project, 'inputs', 'rankings-2026-09-22.csv'), '--now', '2026-09-22T07:00:00Z']);
  const stateBefore = hashTree(path.join(project, '.analyzer'));

  const probe = run('state.mjs', ['--project', project, '--now', '2026-09-28T10:00:00Z']);
  assert.equal(probe.project.name, 'Fixture Micro Tax');
  assert.equal(probe.evidence.count, 1);
  assert.equal(probe.evidence.recent[0].id, 'EV-001');
  assert.equal(probe.next_ids.evidence, 'EV-002');
  assert.equal(probe.next_ids.change, 'CH-003');
  const experiment = probe.experiments.find((entry) => entry.id === 'EX-014');
  assert.equal(experiment.analyzer_status, 'evaluated');
  assert.deepEqual(experiment.evidence_ids, ['EV-001']);
  assert.match(experiment.next, /awaiting Marketer7 decision/);
  assert.equal(probe.sources.find((source) => source.id === 'gsc').health, 'ok');
  assert.equal(probe.sources.find((source) => source.id === 'rankings').health, 'stale');

  const text = run('state.mjs', ['--project', project, '--now', '2026-09-28T10:00:00Z', '--format', 'text'], {json: false});
  assert.match(text, /ANALYZER7 RESUME/);
  assert.match(text, /Project: Fixture Micro Tax/);
  assert.match(text, /rankings\s+stale 6 days/);
  assert.match(text, /EX-014\s+measurement_pending\/evaluated/);
  assert.match(text, /EV-001 .*organic_ctr 1\.0952 → 2\.3963/);
  assert.match(text, /Next analytical action:/);
  assert.equal(hashTree(path.join(project, '.analyzer')), stateBefore, 'resume must not modify state');
});

test('resume: the probe routes a closed experiment window to evaluation', () => {
  const project = setupEcosystem(copyFixture());
  run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-014', '--record-baseline', '--now', T.planning]);
  const during = run('state.mjs', ['--project', project, '--now', T.midWindow]);
  assert.match(during.experiments[0].next, /wait: measurement window closes 2026-09-25/);
  ingestDailyPages(project);
  const after = run('state.mjs', ['--project', project, '--now', T.ingest]);
  assert.equal(after.experiments[0].ready_to_evaluate, true);
  assert.equal(after.next_action, 'evaluate EX-014: window closed 2026-09-25');
});

test('missing source: GSC configured but unavailable degrades the analysis and fabricates nothing', () => {
  const project = setupEcosystem(copyFixture());
  run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-014', '--record-baseline', '--now', T.planning]);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--fail', 'HTTP 403: user lacks permission for sc-domain:example.test', '--now', T.ingest]);
  const probe = run('state.mjs', ['--project', project, '--now', T.ingest]);
  assert.equal(probe.sources[0].health, 'unavailable');
  assert.match(probe.next_action, /check source access: gsc unavailable/);

  const result = run('experiment.mjs', ['evaluate', '--project', project, '--experiment', 'EX-014', '--record', '--now', T.evaluate]);
  assert.equal(result.threshold.result, 'insufficient_data');
  assert.equal(result.threshold.observed, null);
  assert.equal(result.analysis.data_quality.level, 'insufficient');
  assert.equal(result.analysis.evidence_strength.level, 'insufficient');
  assert.equal(result.analysis.causal_confidence.level, 'none');
  assert.ok(result.analysis.data_quality.issues.some((entry) => entry.code === 'source_unavailable'));
  const evidence = fs.readFileSync(path.join(project, result.evidence.path), 'utf8');
  assert.match(evidence, /^before_value: null$/m);
  assert.match(evidence, /^after_value: null$/m);
  assert.match(evidence, /INSUFFICIENT DATA — no conclusion is drawn/);
  assert.match(evidence, /No observation snapshot supplied data/);
  assert.ok(validateState(project).ok, validateState(project).output);
  const baseline = fs.readdirSync(path.join(project, '.analyzer', 'baselines')).find((name) => name.startsWith('BL-001'));
  assert.match(fs.readFileSync(path.join(project, '.analyzer', 'baselines', baseline), 'utf8'), /^value: null$/m, 'a baseline without data is unknown, not zero');

  const seoAudit = run('seo.mjs', ['audit', '--project', project, '--now', T.evaluate]);
  assert.equal(seoAudit.overview, undefined, 'no GSC figures are reported from an unavailable source');
  assert.ok(seoAudit.data_gaps.some((gap) => /gsc.*last fetch failed/.test(gap)));
});

test('missing source: a source is never assumed', () => {
  const project = setupEcosystem(copyFixture());
  const result = run('ingest.mjs', ['--project', project, '--source', 'ga4', '--input', path.join(project, 'inputs', 'ga4-sign-up-2026-09-01_2026-09-14.csv')], {expectFail: true});
  assert.match(result.stderr, /source ga4 is not registered/);
  const compare = run('analyze.mjs', ['compare', '--project', project, '--metric', 'organic_clicks', '--source', 'bing', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--now', T.evaluate]);
  assert.equal(compare.analysis.data_quality.level, 'insufficient');
  assert.ok(compare.analysis.data_quality.issues.some((entry) => entry.code === 'source_unconfigured'));
  assert.match(compare.interpretation, /INSUFFICIENT DATA/);
});

test('stale source: ranking data older than its SLA is flagged explicitly', () => {
  const project = setupEcosystem(copyFixture());
  run('record.mjs', ['source', '--project', project, '--id', 'rankings', '--type', 'ranking', '--adapter', 'rankings', '--auth-method', 'export', '--stale-after-hours', '48', '--now', T.planning]);
  run('ingest.mjs', ['--project', project, '--source', 'rankings', '--input', path.join(project, 'inputs', 'rankings-2026-08-28.csv'), '--retrieved-at', '2026-08-28T07:00:00Z', '--now', '2026-08-28T07:00:00Z']);
  run('ingest.mjs', ['--project', project, '--source', 'rankings', '--input', path.join(project, 'inputs', 'rankings-2026-09-22.csv'), '--retrieved-at', '2026-09-22T07:00:00Z', '--now', '2026-09-22T07:00:00Z']);
  const now = '2026-09-25T12:00:00Z';
  const probe = run('state.mjs', ['--project', project, '--now', now]);
  const rankings = probe.sources.find((source) => source.id === 'rankings');
  assert.equal(rankings.health, 'stale');
  assert.match(rankings.warning, /last data 2026-09-22, 3 days old \(threshold 48h\)/);
  assert.ok(probe.warnings.some((warning) => warning.includes('rankings: data is stale')));
  const text = run('state.mjs', ['--project', project, '--now', now, '--format', 'text'], {json: false});
  assert.match(text, /rankings\s+stale 3 days \(data through 2026-09-22\)/);
  const rankingRun = run('seo.mjs', ['rankings', '--project', project, '--source', 'rankings', '--now', now]);
  assert.match(rankingRun.stale_warning, /3 days old/);
  const maintain = run('analyze.mjs', ['maintain', '--project', project, '--now', now]);
  assert.ok(maintain.checks.some((check) => check.area === 'source' && check.status === 'attention' && /rankings/.test(check.detail)));
  const fresh = run('state.mjs', ['--project', project, '--now', '2026-09-23T12:00:00Z']);
  assert.equal(fresh.sources.find((source) => source.id === 'rankings').health, 'ok');
});
