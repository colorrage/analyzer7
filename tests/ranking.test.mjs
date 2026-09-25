// Opportunity ranking by estimated click gain, the fitted expected-CTR curve,
// and false-discovery-rate control over many comparisons.

import test from 'node:test';
import assert from 'node:assert/strict';
import {benjaminiHochberg, normalCdf} from '../skills/analyzer/scripts/lib/stats.mjs';
import {DEFAULT_SEO_CONFIG} from '../skills/analyzer/scripts/lib/state.mjs';
import * as seo from '../skills/analyzer/scripts/lib/seo.mjs';

test('Benjamini–Hochberg matches a textbook example', () => {
  // Benjamini & Hochberg (1995)-style example, q = 0.05: the first 4 survive.
  const p = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1.0];
  assert.deepEqual(benjaminiHochberg(p, 0.05).map((keep, index) => (keep ? index : null)).filter((index) => index !== null), [0, 1, 2, 3]);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
});

test('the fitted CTR curve is non-increasing and falls back where data is thin', () => {
  const rows = [];
  for (let position = 1; position <= 10; position += 1) {
    for (let query = 0; query < 6; query += 1) {
      // Real CTR ≈ 30% / position, with a deliberate bump at position 6.
      const ctr = position === 6 ? 0.08 : 0.3 / position;
      rows.push({query: `q${position}-${query}`, page: '/p', impressions: 400, clicks: Math.round(400 * ctr), position});
    }
  }
  const fit = seo.fitCtrCurve(rows, DEFAULT_SEO_CONFIG.expected_ctr_curve);
  assert.equal(fit.source, 'fitted');
  assert.equal(fit.fitted_buckets, 10);
  for (let position = 2; position <= 20; position += 1) assert.ok(fit.curve[position] <= fit.curve[position - 1], `non-increasing at ${position}`);
  assert.ok(Math.abs(fit.curve[1] - 30) < 0.5, 'position 1 comes from the data (30%), not the heuristic (27%)');
  assert.ok(fit.curve[6] <= fit.curve[5], 'the bump at position 6 is pooled away');
  assert.equal(fit.curve[15], seo.expectedCtr(15, DEFAULT_SEO_CONFIG.expected_ctr_curve) <= fit.curve[10] ? fit.curve[15] : fit.curve[10], 'thin buckets use the heuristic, capped by the monotone constraint');
});

test('CTR opportunities are ranked by estimated click gain and must be significant', () => {
  const config = DEFAULT_SEO_CONFIG;
  const rows = [
    {query: 'big', page: '/a', impressions: 20000, clicks: 100, position: 6}, // 0.5% at position 6
    {query: 'small', page: '/b', impressions: 800, clicks: 4, position: 6}, // 0.5% but little volume
    {query: 'borderline', page: '/c', impressions: 520, clicks: 10, position: 9}, // 1.9% vs ~2.4% expected: not below half
  ];
  const opportunities = seo.ctrOpportunities(rows, config, {days: 28});
  assert.deepEqual(opportunities.map((row) => row.query), ['big', 'small']);
  assert.ok(opportunities[0].estimated_click_gain_28d > opportunities[1].estimated_click_gain_28d * 10);
  assert.ok(opportunities.every((row) => row.significant && row.p_value < 0.05));
});

test('winners and decliners exclude chance moves across hundreds of queries', () => {
  const beforeRows = [];
  const afterRows = [];
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let index = 0; index < 200; index += 1) {
    // Pure noise: same expected clicks (~8) in both periods.
    const noise = () => Math.max(0, Math.round(8 + (random() - 0.5) * 8));
    beforeRows.push({query: `noise-${index}`, clicks: noise(), impressions: 300, position: 8});
    afterRows.push({query: `noise-${index}`, clicks: noise(), impressions: 300, position: 8});
  }
  for (const [query, before, after] of [['real-win', 40, 160], ['real-drop', 150, 20], ['real-win-2', 60, 180]]) {
    beforeRows.push({query, clicks: before, impressions: 3000, position: 5});
    afterRows.push({query, clicks: after, impressions: 3000, position: 5});
  }
  const period = {start: '2026-08-01', end: '2026-08-28'};
  const later = {start: '2026-08-29', end: '2026-09-25'};
  const movement = seo.comparePeriodsSeo(beforeRows, afterRows, {dimensions: ['query'], beforePeriod: period, afterPeriod: later});
  assert.ok(movement.big_wins.length + movement.dropped.length > 3, 'the raw classification flags noise as big wins/drops');
  const listed = seo.winnersAndDecliners(movement, {minClicks: 5});
  assert.ok(listed.tested > 190, 'rows under the 5-click minimum in both periods are not tested');
  assert.deepEqual([...listed.winning, ...listed.declining].map((row) => row.query).sort(), ['real-drop', 'real-win', 'real-win-2']);
});
