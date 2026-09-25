// SEO subsystem: rankings (fixtures modeled after the CMR seo-rankings skill),
// CTR opportunities, cannibalization, technical/CWV/indexation, headline
// safety, and the legacy seo-rankings markdown import. No live APIs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {FIXTURES, T, copyFixture, run, setupEcosystem, validateState} from './helpers.mjs';
import {DEFAULT_SEO_CONFIG} from '../skills/analyzer/scripts/lib/state.mjs';
import * as seo from '../skills/analyzer/scripts/lib/seo.mjs';

const NOW = '2026-09-25T12:00:00Z';

function ingestSeoSources(project) {
  const input = (name) => path.join(project, 'inputs', name);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-daily-site-2026-08-01_2026-09-25.csv'), '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-query-page-before-2026-08-01_2026-08-28.json'), '--dimensions', 'query,page', '--start', '2026-08-01', '--end', '2026-08-28', '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-query-page-after-2026-08-29_2026-09-25.json'), '--dimensions', 'query,page', '--start', '2026-08-29', '--end', '2026-09-25', '--now', NOW]);
  const source = (id, type, adapter) => run('record.mjs', ['source', '--project', project, '--id', id, '--type', type, '--adapter', adapter, '--auth-method', 'export', '--stale-after-hours', '96', '--now', T.planning]);
  source('rankings', 'ranking', 'rankings');
  source('crawl', 'crawl', 'crawl');
  source('cwv', 'performance', 'cwv');
  source('index', 'indexation', 'indexation');
  run('ingest.mjs', ['--project', project, '--source', 'rankings', '--input', input('rankings-2026-08-28.csv'), '--retrieved-at', '2026-08-28T07:00:00Z', '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'rankings', '--input', input('rankings-2026-09-22.csv'), '--retrieved-at', '2026-09-22T07:00:00Z', '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'crawl', '--input', input('crawl-2026-09-20.csv'), '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'cwv', '--input', input('cwv-2026-08.csv'), '--retrieved-at', '2026-08-28T00:00:00Z', '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'cwv', '--input', input('cwv-2026-09.csv'), '--retrieved-at', '2026-09-22T00:00:00Z', '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'index', '--input', input('indexation-2026-09-20.csv'), '--now', NOW]);
  return project;
}

test('movement classification follows the seo-rankings rules', () => {
  const classify = (positionDelta, clicksBefore = 0, clicksAfter = 0, ctrDeltaPp = null) => seo.classifyMovement({positionDelta, clicksBefore, clicksAfter, ctrDeltaPp});
  assert.equal(classify(-5), 'big_win');
  assert.equal(classify(-0.2, 10, 20), 'big_win', 'clicks doubled');
  assert.equal(classify(-2), 'improved');
  assert.equal(classify(0.2, 10, 10, 1.5), 'improved', 'CTR +1pp');
  assert.equal(classify(0.4, 10, 11, 0.2), 'stable');
  assert.equal(classify(3), 'slipping');
  assert.equal(classify(6), 'dropped');
  assert.equal(classify(0.1, 10, 5), 'dropped', 'clicks halved');
});

test('rank-tracker changes: loss > 10 positions, URL switch, lost, new, and SERP features', () => {
  const project = ingestSeoSources(setupEcosystem(copyFixture()));
  const result = run('seo.mjs', ['rankings', '--project', project, '--source', 'rankings', '--record', '--now', '2026-09-23T08:00:00Z']);
  assert.equal(result.stale_warning, null);
  const byKeyword = Object.fromEntries(result.rankings.changes.map((change) => [change.keyword, change]));
  assert.equal(byKeyword['calculator impozit micro 2026'].movement, 'improved');
  assert.deepEqual(byKeyword['calculator impozit micro 2026'].serp_feature_changes, {added: ['featured_snippet'], removed: []});
  assert.equal(byKeyword['impozit micro 2026'].delta, 13);
  assert.equal(byKeyword['impozit micro 2026'].movement, 'dropped');
  assert.equal(byKeyword['impozit micro 2026'].url_changed, true);
  assert.equal(byKeyword['impozit micro 2026'].alert, true);
  assert.equal(byKeyword['impozit micro pfa'].movement, 'lost');
  assert.equal(byKeyword['calcul impozit microintreprindere'].movement, 'new');
  assert.deepEqual(result.recorded.map((entry) => [entry.type, entry.status]), [['ranking_loss', 'opened'], ['ranking_loss', 'opened']]);
  assert.deepEqual(seo.rankingChanges([{keyword: 'a', location: 'RO', device: 'mobile', engine: 'google', position: 3}], [], DEFAULT_SEO_CONFIG).changes[0].movement, 'not_observed', 'a missing keyword is a tracking gap, not a loss');
});

test('CTR opportunity: high impressions at position 8.7 with 1.1% CTR is flagged, not rewritten', () => {
  const project = ingestSeoSources(setupEcosystem(copyFixture()));
  const before = run('seo.mjs', ['audit', '--project', project, '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-01', '--after-end', '2026-08-28', '--now', NOW]);
  const opportunity = before.ctr_opportunities.find((row) => row.query === 'calculator impozit micro 2026' && row.page === '/calculator-impozit-micro');
  assert.ok(opportunity, 'the pre-change query is flagged');
  assert.equal(opportunity.impressions, 6100);
  assert.equal(opportunity.avg_position, 8.7);
  assert.equal(opportunity.ctr_pct, 1.098);
  assert.ok(opportunity.expected_ctr_pct > opportunity.ctr_pct * 2);
  const after = run('seo.mjs', ['audit', '--project', project, '--now', NOW]);
  assert.equal(after.ctr_opportunities.length, 0, 'after the title rewrite the same query no longer qualifies');
});

test('cannibalization: several URLs competing for one query are evidence, not a consolidation decision', () => {
  const project = ingestSeoSources(setupEcosystem(copyFixture()));
  const result = run('seo.mjs', ['audit', '--project', project, '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-01', '--after-end', '2026-08-28', '--now', NOW]);
  const finding = result.cannibalization.find((entry) => entry.query === 'impozit micro 2026');
  assert.deepEqual(finding.urls.map((url) => [url.page, url.avg_position]), [['/calculator-impozit-micro', 8], ['/impozit-micro-2026', 11], ['/blog/ghid-impozit-micro', 17]]);
  assert.match(finding.rule, />= 2 URLs/);
});

test('SEO audit: full report sections, headline-safe totals, recorded opportunities with owners', () => {
  const project = ingestSeoSources(setupEcosystem(copyFixture()));
  const result = run('seo.mjs', ['audit', '--project', project, '--record', '--report', '--now', NOW]);
  assert.equal(result.overview.headline_safe, true);
  assert.equal(result.overview.before.impressions > 14000, true, 'totals come from the date-only property pull, not summed page rows');
  assert.equal(result.technical.summary.redirect_chain, 1);
  assert.equal(result.technical.summary.canonical_mismatch, 1);
  assert.equal(result.technical.summary.noindex_in_sitemap, 1);
  assert.equal(result.technical.summary.orphan_page, 1);
  assert.equal(result.technical.summary.duplicate_title, 2);
  assert.equal(result.cwv.regressions[0].metric, 'lcp_p75_ms');
  assert.equal(result.indexation.counts.crawled_not_indexed, 1);
  assert.equal(result.indexation.canonical_mismatch.length, 1);
  assert.equal(result.indexation.cannot_prove.length, 1, 'an unknown URL is "cannot prove", not "not indexed"');
  assert.ok(result.recent_seo_changes.some((change) => change.id === 'CH-002'));
  assert.ok(result.external_context.some((entry) => entry.ref === 'scout7:R1'), 'Scout7 context appears as a potential confounder');
  const report = fs.readFileSync(path.join(project, result.report), 'utf8');
  for (const section of ['Data availability', 'GSC overview', 'Organic trend', 'Top queries', 'Top pages', 'Winning queries/pages', 'Declining queries/pages', 'Positions 4–15 opportunities', 'High-impression low-CTR opportunities', 'Cannibalization candidates', 'Indexation issues', 'CWV/performance issues', 'Ranking changes', 'Recent SEO-related changes', 'Potential confounders', 'Evidence-backed opportunities', 'Data gaps', 'Interpretation']) {
    assert.ok(report.includes(`## ${section}`), `report section ${section}`);
  }
  const opportunities = fs.readdirSync(path.join(project, '.analyzer', 'seo', 'opportunities')).filter((name) => name.startsWith('SEO-OPP-'));
  assert.ok(opportunities.length > 0);
  const technical = opportunities.map((name) => fs.readFileSync(path.join(project, '.analyzer', 'seo', 'opportunities', name), 'utf8')).find((text) => /type: technical/.test(text));
  assert.match(technical, /suggested_owner: hyper7/);
  assert.match(technical, /Hyper7 executes technical fixes/);
  const again = run('seo.mjs', ['audit', '--project', project, '--record', '--now', NOW]);
  assert.ok(again.recorded.every((entry) => ['already_recorded', 'already_open'].includes(entry.status)), 'opportunities are not duplicated while open');
  assert.ok(validateState(project).ok, validateState(project).output);
});

test('headline safety: property totals are never derived from page rows', () => {
  const project = setupEcosystem(copyFixture());
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', path.join(project, 'inputs', 'gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', NOW]);
  const unsafe = run('analyze.mjs', ['compare', '--project', project, '--metric', 'organic_clicks', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--now', NOW]);
  assert.ok(unsafe.analysis.data_quality.issues.some((entry) => entry.code === 'headline_unsafe'));
  const audit = run('seo.mjs', ['audit', '--project', project, '--now', NOW]);
  assert.equal(audit.overview.headline_safe, false);
  assert.ok(audit.data_gaps.some((gap) => /date-only aggregate/.test(gap)));
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', path.join(project, 'inputs', 'gsc-daily-site-2026-08-01_2026-09-25.csv'), '--now', NOW]);
  const safe = run('analyze.mjs', ['compare', '--project', project, '--metric', 'organic_clicks', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--now', NOW]);
  assert.ok(!safe.analysis.data_quality.issues.some((entry) => entry.code === 'headline_unsafe'));
  const scoped = run('analyze.mjs', ['compare', '--project', project, '--metric', 'organic_clicks', '--page', '/calculator-impozit-micro', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--now', NOW]);
  assert.equal(scoped.analysis.comparison.before.value, 92, 'a page-scoped read uses the page grain, not the site grain');
});

test('legacy seo-rankings markdown imports in place and compares with the seo-rankings rules', () => {
  const project = copyFixture('seo-rankings-legacy');
  const legacyBefore = fs.readFileSync(path.join(project, '.hyper', 'seo', 'baselines', '2026-08-01-baseline.md'), 'utf8');
  run('init.mjs', ['--project', project, '--seed', 'seo', '--now', T.planning]);
  run('record.mjs', ['source', '--project', project, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--property', 'https://www.example.test/', '--auth-method', 'mcp', '--now', T.planning]);
  const baseline = run('ingest.mjs', ['--project', project, '--source', 'gsc', '--adapter', 'seo-rankings-md', '--input', path.join(project, '.hyper', 'seo', 'baselines', '2026-08-01-baseline.md'), '--now', T.planning]);
  assert.deepEqual(baseline.period, {start: '2026-07-04', end: '2026-07-31'});
  assert.equal(baseline.row_count, 6);
  assert.equal(baseline.headline_safe, false);
  const snapshot = run('ingest.mjs', ['--project', project, '--source', 'gsc', '--adapter', 'seo-rankings-md', '--input', path.join(project, '.hyper', 'seo', 'snapshots', '2026-08-29-snapshot.md'), '--segment-map', 'de=DEU,pl=POL', '--now', T.planning]);
  assert.deepEqual(snapshot.period, {start: '2026-08-01', end: '2026-08-28'});
  assert.equal(snapshot.row_count, 6);
  const comparison = run('seo.mjs', ['compare', '--project', project, '--before-start', '2026-07-04', '--before-end', '2026-07-31', '--after-start', '2026-08-01', '--after-end', '2026-08-28', '--dimensions', 'segment,query', '--now', T.planning]);
  const row = (list, query) => comparison.movement[list].find((entry) => entry.query === query);
  assert.equal(row('big_wins', 'cmr frachtbrief').segment, 'DEU', 'the explicit segment map aligns "Germany (de)" with "DEU"');
  assert.equal(row('big_wins', 'cmr online').position_delta, -2.8);
  assert.ok(row('new', 'cmr druk'));
  assert.ok(row('lost', 'generator cmr'));
  assert.equal(fs.readFileSync(path.join(project, '.hyper', 'seo', 'baselines', '2026-08-01-baseline.md'), 'utf8'), legacyBefore, 'legacy files are read, never rewritten');
  assert.ok(validateState(project).ok, validateState(project).output);
});

test('CWV and indexation classification', () => {
  assert.equal(seo.cwvClass('lcp_p75_ms', 2400), 'good');
  assert.equal(seo.cwvClass('inp_p75_ms', 300), 'needs_improvement');
  assert.equal(seo.cwvClass('cls_p75', 0.3), 'poor');
  const findings = seo.cwvFindings([{url: '/a', form_factor: 'phone', lcp_p75_ms: 2400, inp_p75_ms: 100, cls_p75: 0.01}], [{url: '/a', form_factor: 'phone', lcp_p75_ms: 1900, inp_p75_ms: 100, cls_p75: 0.01}]);
  assert.equal(findings.regressions[0].change_pct, 26.3, 'a ≥ 20% p75 regression is flagged even while still "good"');
  assert.ok(fs.existsSync(path.join(FIXTURES, 'ecosystem', 'inputs', 'indexation-2026-09-20.csv')));
});
