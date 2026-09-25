// SEO analyses over normalized observations. Every function returns evidence
// rows (numbers + the rule that flagged them); none prescribes a fix. The
// decision belongs to Marketer7, execution to Signal7 (content) or Hyper7
// (technical), and verification back to Analyzer7.

import {daysInclusive, normalizePage, round} from './core.mjs';
import {belowExpectedZ, benjaminiHochberg, pOneSidedBelow, pTwoSided, rateZ} from './stats.mjs';

// ---------- aggregation ----------

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export function totals(rows) {
  // Missing cells are skipped (they are unknown, not zero); `missing` counts them.
  const known = (field) => rows.filter((row) => row[field] !== null && row[field] !== undefined && Number.isFinite(Number(row[field])));
  const clicks = known('clicks').reduce((total, row) => total + Number(row.clicks), 0);
  const impressions = known('impressions').reduce((total, row) => total + Number(row.impressions), 0);
  // Rows without a position are excluded from the average, not counted as 0.
  const positioned = rows.filter((row) => row.position !== null && row.position !== undefined && Number.isFinite(Number(row.position)));
  const positionWeight = positioned.reduce((total, row) => total + (row.impressions ?? 0), 0);
  const weighted = positioned.reduce((total, row) => total + Number(row.position) * (row.impressions ?? 0), 0);
  // CTR only over rows where both counts are known.
  const paired = rows.filter((row) => known('clicks').includes(row) && known('impressions').includes(row));
  const pairedClicks = paired.reduce((total, row) => total + Number(row.clicks), 0);
  const pairedImpressions = paired.reduce((total, row) => total + Number(row.impressions), 0);
  return {
    clicks,
    impressions,
    missing: rows.length * 2 - known('clicks').length - known('impressions').length,
    ctr_pct: pairedImpressions > 0 ? round((pairedClicks / pairedImpressions) * 100, 3) : null,
    avg_position: positionWeight > 0 ? round(weighted / positionWeight, 2) : null,
  };
}

const keyFor = (dimensions) => (row) => dimensions.map((dimension) => (dimension === 'page' ? normalizePage(row.page) : row[dimension] ?? '')).join('\u0000');

export function rollup(rows, dimensions) {
  const groups = groupBy(rows, keyFor(dimensions));
  return [...groups.values()].map((group) => {
    const identity = Object.fromEntries(dimensions.map((dimension) => [dimension, dimension === 'page' ? normalizePage(group[0].page) : group[0][dimension] ?? null]));
    return {...identity, ...totals(group)};
  });
}

// Headline totals are only trustworthy from aggregate (query-less, page-less)
// pulls. Summed query×page rows double-count and omit anonymized queries.
export function headlineTotals(snapshotSet) {
  const safe = snapshotSet.snapshots.every((snapshot) => snapshot.headline_safe === true);
  return {headline_safe: safe, ...totals(snapshotSet.rows), note: safe ? 'from aggregate rows' : 'NOT headline-safe: derived from query/page rows; use an aggregate pull for totals'};
}

// ---------- expected CTR ----------

export function expectedCtr(position, curve) {
  if (position === null || position === undefined) return null;
  const points = Object.entries(curve).map(([key, value]) => [Number(key), Number(value)]).sort((a, b) => a[0] - b[0]);
  if (position <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    if (position <= x2) return y1 + ((position - x1) / (x2 - x1)) * (y2 - y1);
  }
  return points.at(-1)[1];
}

// ---------- expected CTR curve fitted from the property's own data ----------

// Impression-weighted CTR per rounded position (1–20), from query×page rows.
// Buckets with too little data fall back to the heuristic curve; the result
// is forced non-increasing (pool-adjacent-violators, impression-weighted).
export function fitCtrCurve(rows, fallback, {minImpressions = 500, minRows = 5, maxPosition = 20} = {}) {
  const buckets = new Map();
  for (const row of rollup(rows.filter((entry) => entry.query), ['query', 'page'])) {
    if (row.avg_position === null || row.impressions <= 0) continue;
    const position = Math.max(1, Math.round(row.avg_position));
    if (position > maxPosition) continue;
    const bucket = buckets.get(position) ?? {clicks: 0, impressions: 0, rows: 0};
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.rows += 1;
    buckets.set(position, bucket);
  }
  const points = [];
  let fitted = 0;
  for (let position = 1; position <= maxPosition; position += 1) {
    const bucket = buckets.get(position);
    if (bucket && bucket.impressions >= minImpressions && bucket.rows >= minRows) {
      points.push({position, ctr: (bucket.clicks / bucket.impressions) * 100, weight: bucket.impressions, fitted: true});
      fitted += 1;
    } else {
      points.push({position, ctr: expectedCtr(position, fallback), weight: minImpressions / 10, fitted: false});
    }
  }
  // Pool adjacent violators: enforce CTR non-increasing with position.
  const blocks = points.map((point) => ({sum: point.ctr * point.weight, weight: point.weight, members: [point.position]}));
  for (let index = 0; index < blocks.length - 1;) {
    if (blocks[index].sum / blocks[index].weight < blocks[index + 1].sum / blocks[index + 1].weight) {
      blocks[index] = {sum: blocks[index].sum + blocks[index + 1].sum, weight: blocks[index].weight + blocks[index + 1].weight, members: [...blocks[index].members, ...blocks[index + 1].members]};
      blocks.splice(index + 1, 1);
      if (index > 0) index -= 1;
    } else {
      index += 1;
    }
  }
  const curve = {};
  for (const block of blocks) for (const position of block.members) curve[position] = round(block.sum / block.weight, 3);
  curve[30] = Math.min(curve[maxPosition], expectedCtr(30, fallback));
  const source = fitted === 0 ? 'heuristic' : fitted >= 8 ? 'fitted' : 'mixed';
  return {curve, source, fitted_buckets: fitted, note: `${fitted} of ${maxPosition} position buckets fitted from this property's query data (>= ${minImpressions} impressions, >= ${minRows} rows); the rest use the heuristic curve; forced non-increasing`};
}

// ---------- opportunities ----------

const perPeriod = (value, days) => (days ? (value * 28) / days : value);

// High impressions, position within reach, CTR significantly below the
// expected CTR for that position (FDR-controlled across all candidates).
// Ranked by estimated clicks per 28 days if CTR reached the expected level.
export function ctrOpportunities(rows, config, {dimensions = ['query', 'page'], curve = null, days = null, q = 0.1} = {}) {
  const {thresholds} = config;
  const expected = curve ?? config.expected_ctr_curve;
  const candidates = rollup(rows, dimensions)
    .filter((row) => row.impressions >= thresholds.high_impressions && row.avg_position !== null)
    .filter((row) => row.avg_position >= 1 && row.avg_position <= thresholds.quick_win_position_max)
    .map((row) => ({...row, expected_ctr_pct: round(expectedCtr(row.avg_position, expected), 2)}))
    .filter((row) => row.ctr_pct !== null && row.ctr_pct < row.expected_ctr_pct * thresholds.ctr_gap_ratio);
  const pValues = candidates.map((row) => pOneSidedBelow(belowExpectedZ(row.clicks, row.impressions, row.expected_ctr_pct / 100)));
  const keep = benjaminiHochberg(pValues, q);
  return candidates
    .map((row, index) => ({...row, p_value: round(pValues[index], 6), significant: keep[index]}))
    .filter((row) => row.significant)
    .map((row) => ({...row, ctr_gap_pct_points: round(row.expected_ctr_pct - row.ctr_pct, 2), estimated_click_gain_28d: round(perPeriod((row.impressions * (row.expected_ctr_pct - row.ctr_pct)) / 100, days), 1), rule: `impressions >= ${thresholds.high_impressions}, position <= ${thresholds.quick_win_position_max}, CTR < ${thresholds.ctr_gap_ratio} × expected CTR, significant after FDR control (q = ${q}) across ${candidates.length} candidate(s)`}))
    .sort((a, b) => b.estimated_click_gain_28d - a.estimated_click_gain_28d);
}

// Upside if the query reached about position 3 — a hypothetical, labeled as
// such; ranked by it.
export function strikingDistance(rows, config, {dimensions = ['query', 'page'], curve = null, days = null} = {}) {
  const {thresholds} = config;
  const expected = curve ?? config.expected_ctr_curve;
  const rolled = rollup(rows, dimensions).filter((row) => row.impressions >= thresholds.min_impressions && row.avg_position !== null)
    .map((row) => ({...row, upside_if_top3_28d: round(Math.max(0, perPeriod((row.impressions * (expectedCtr(3, expected) - (row.ctr_pct ?? 0))) / 100, days)), 1)}));
  const byUpside = (a, b) => b.upside_if_top3_28d - a.upside_if_top3_28d;
  return {
    positions_4_15: rolled.filter((row) => row.avg_position >= thresholds.quick_win_position_min && row.avg_position <= thresholds.quick_win_position_max).sort(byUpside),
    positions_15_30: rolled.filter((row) => row.avg_position > thresholds.striking_distance_min && row.avg_position <= thresholds.striking_distance_max).sort(byUpside),
    note: 'upside_if_top3_28d is hypothetical: the clicks this query would get at about position 3 on the expected-CTR curve, per 28 days',
  };
}

// Several URLs of ours receive a material share of one query's impressions.
// Evidence of competition only; consolidation is a separate decision.
export function cannibalization(rows, config, {segmentKey = null} = {}) {
  const {thresholds} = config;
  const byQuery = groupBy(rows.filter((row) => row.query && row.page), (row) => `${segmentKey ? row[segmentKey] ?? '' : ''}\u0000${row.query}`);
  const findings = [];
  for (const group of byQuery.values()) {
    const pages = rollup(group, ['page']);
    const queryImpressions = pages.reduce((total, page) => total + page.impressions, 0);
    if (queryImpressions < thresholds.cannibalization_min_impressions) continue;
    // A URL competes only if it holds a material share AND ranks within reach;
    // a page at position 80 is not competing with one at position 3.
    const maxPosition = thresholds.cannibalization_max_position ?? 20;
    const competing = pages.filter((page) => page.impressions / queryImpressions >= thresholds.cannibalization_min_share && page.avg_position !== null && page.avg_position <= maxPosition).sort((a, b) => (a.avg_position ?? 999) - (b.avg_position ?? 999));
    if (competing.length < 2) continue;
    findings.push({
      query: group[0].query,
      ...(segmentKey ? {[segmentKey]: group[0][segmentKey] ?? null} : {}),
      query_impressions: queryImpressions,
      urls: competing.map((page) => ({page: page.page, impressions: page.impressions, share_pct: round((page.impressions / queryImpressions) * 100, 1), avg_position: page.avg_position, clicks: page.clicks})),
      contested_impressions: competing.slice(1).reduce((total, page) => total + page.impressions, 0),
      rule: `>= 2 URLs each with >= ${thresholds.cannibalization_min_share * 100}% of the query's impressions and an average position <= ${thresholds.cannibalization_max_position ?? 20}`,
    });
  }
  // Impressions held by the non-leading URLs: how much is actually contested.
  return findings.sort((a, b) => b.contested_impressions - a.contested_impressions);
}

// ---------- movement between periods (seo-rankings classification) ----------

export function classifyMovement({positionDelta, clicksBefore, clicksAfter, ctrDeltaPp}) {
  const improvedBy = positionDelta === null ? null : -positionDelta; // negative delta = better position
  if ((improvedBy !== null && improvedBy >= 5) || (clicksBefore >= 2 && clicksAfter >= clicksBefore * 2)) return 'big_win';
  if ((improvedBy !== null && improvedBy <= -5) || (clicksBefore >= 2 && clicksAfter <= clicksBefore / 2)) return 'dropped';
  if ((improvedBy !== null && improvedBy >= 1) || (ctrDeltaPp !== null && ctrDeltaPp > 1)) return 'improved';
  if (improvedBy !== null && improvedBy <= -1) return 'slipping';
  return 'stable';
}

export function comparePeriodsSeo(beforeRows, afterRows, {dimensions = ['query'], beforePeriod, afterPeriod}) {
  const perDay = beforePeriod && afterPeriod && daysInclusive(beforePeriod.start, beforePeriod.end) !== daysInclusive(afterPeriod.start, afterPeriod.end);
  const scale = perDay ? daysInclusive(beforePeriod.start, beforePeriod.end) / daysInclusive(afterPeriod.start, afterPeriod.end) : 1;
  const before = new Map(rollup(beforeRows, dimensions).map((row) => [keyFor(dimensions)(row), row]));
  const after = new Map(rollup(afterRows, dimensions).map((row) => [keyFor(dimensions)(row), row]));
  const moved = [];
  const added = [];
  const lost = [];
  for (const [key, current] of after) {
    const previous = before.get(key);
    if (!previous) {
      added.push(current);
      continue;
    }
    const clicksAfter = current.clicks * scale;
    const positionDelta = current.avg_position !== null && previous.avg_position !== null ? round(current.avg_position - previous.avg_position, 2) : null;
    const ctrDeltaPp = current.ctr_pct !== null && previous.ctr_pct !== null ? round(current.ctr_pct - previous.ctr_pct, 2) : null;
    const beforeDays = beforePeriod ? daysInclusive(beforePeriod.start, beforePeriod.end) : 28;
    const afterDays = afterPeriod ? daysInclusive(afterPeriod.start, afterPeriod.end) : 28;
    moved.push({
      ...Object.fromEntries(dimensions.map((dimension) => [dimension, current[dimension]])),
      p_value: round(pTwoSided(rateZ(previous.clicks, beforeDays, current.clicks, afterDays)), 6),
      before: previous,
      after: current,
      position_delta: positionDelta,
      clicks_delta: round(clicksAfter - previous.clicks, 1),
      impressions_delta: round(current.impressions * scale - previous.impressions, 1),
      ctr_delta_pp: ctrDeltaPp,
      movement: classifyMovement({positionDelta, clicksBefore: previous.clicks, clicksAfter, ctrDeltaPp}),
    });
  }
  for (const [key, previous] of before) if (!after.has(key)) lost.push(previous);
  const by = (movement) => moved.filter((row) => row.movement === movement);
  return {
    basis: perDay ? 'after period scaled to the before period length' : 'totals',
    big_wins: by('big_win'),
    improved: by('improved'),
    stable: by('stable'),
    slipping: by('slipping'),
    dropped: by('dropped'),
    new: added.sort((a, b) => b.impressions - a.impressions),
    lost: lost.sort((a, b) => b.impressions - a.impressions),
  };
}

// Winners and decliners by clicks (per-day normalized when lengths differ).
// Only changes that survive FDR control across every compared row are listed:
// with hundreds of queries, some "big" moves are chance.
export function winnersAndDecliners(comparison, {limit = 10, minClicks = 5, q = 0.1} = {}) {
  const all = [...comparison.big_wins, ...comparison.improved, ...comparison.stable, ...comparison.slipping, ...comparison.dropped]
    .filter((row) => Math.max(row.before.clicks, row.after.clicks) >= minClicks);
  const keep = benjaminiHochberg(all.map((row) => row.p_value ?? 1), q);
  const significant = all.filter((_, index) => keep[index]);
  return {
    tested: all.length,
    significant: significant.length,
    fdr_q: q,
    winning: [...significant].sort((a, b) => b.clicks_delta - a.clicks_delta).filter((row) => row.clicks_delta > 0).slice(0, limit),
    declining: [...significant].sort((a, b) => a.clicks_delta - b.clicks_delta).filter((row) => row.clicks_delta < 0).slice(0, limit),
  };
}

// Content decay: pages whose clicks fell by >= decline_pct between periods,
// significant after FDR control; ranked by clicks lost per 28 days.
export function contentDecay(comparison, config, {beforeDays = 28, q = 0.1} = {}) {
  const {decline_pct: declinePct, min_clicks_for_decline: minClicks} = config.thresholds;
  const candidates = [...comparison.slipping, ...comparison.dropped, ...comparison.stable, ...comparison.improved]
    .filter((row) => row.before.clicks >= minClicks)
    .map((row) => ({...row, clicks_change_pct: round((row.clicks_delta / row.before.clicks) * 100, 1)}))
    .filter((row) => row.clicks_change_pct <= -declinePct);
  const keep = benjaminiHochberg(candidates.map((row) => row.p_value ?? 1), q);
  return candidates
    .filter((_, index) => keep[index])
    .map((row) => ({...row, estimated_click_loss_28d: round((-row.clicks_delta * 28) / beforeDays, 1)}))
    .sort((a, b) => b.estimated_click_loss_28d - a.estimated_click_loss_28d);
}

// ---------- rank-tracker observations ----------

const rankKey = (row) => [row.keyword.toLowerCase(), row.location, row.device, row.engine].join('\u0000');

export function rankingChanges(previousRows, currentRows, config) {
  const lossAlert = config.thresholds.ranking_loss_alert;
  const previous = new Map(previousRows.map((row) => [rankKey(row), row]));
  const current = new Map(currentRows.map((row) => [rankKey(row), row]));
  const changes = [];
  for (const [key, now] of current) {
    const before = previous.get(key);
    const entry = {keyword: now.keyword, location: now.location, device: now.device, engine: now.engine, previous_position: before?.position ?? null, current_position: now.position, previous_url: before?.url ?? null, current_url: now.url, previous_observed_at: before?.observed_at ?? null, observed_at: now.observed_at, serp_features: now.serp_features, provider: now.provider};
    if (!before) {
      entry.movement = now.position === null ? 'not_ranking' : 'new';
    } else if (before.position === null && now.position !== null) {
      entry.movement = 'new';
    } else if (before.position !== null && now.position === null) {
      entry.movement = 'lost';
    } else if (before.position === null && now.position === null) {
      entry.movement = 'not_ranking';
    } else {
      entry.delta = round(now.position - before.position, 1);
      entry.movement = classifyMovement({positionDelta: entry.delta, clicksBefore: 0, clicksAfter: 0, ctrDeltaPp: null});
    }
    entry.url_changed = Boolean(before && before.url && now.url && normalizePage(before.url) !== normalizePage(now.url));
    const addedFeatures = (now.serp_features ?? []).filter((feature) => !(before?.serp_features ?? []).includes(feature));
    const removedFeatures = (before?.serp_features ?? []).filter((feature) => !(now.serp_features ?? []).includes(feature));
    if (addedFeatures.length || removedFeatures.length) entry.serp_feature_changes = {added: addedFeatures, removed: removedFeatures};
    entry.alert = entry.movement === 'lost' || (entry.delta !== undefined && entry.delta >= lossAlert);
    changes.push(entry);
  }
  for (const [key, before] of previous) {
    if (!current.has(key)) changes.push({keyword: before.keyword, location: before.location, device: before.device, engine: before.engine, previous_position: before.position, current_position: null, movement: 'not_observed', note: 'keyword missing from the current snapshot (tracking gap, not a ranking loss)', alert: false});
  }
  const summary = {};
  for (const change of changes) summary[change.movement] = (summary[change.movement] ?? 0) + 1;
  return {summary, alerts: changes.filter((change) => change.alert), url_switches: changes.filter((change) => change.url_changed), changes};
}

// ---------- technical SEO (crawl rows) ----------

export function technicalFindings(crawlRows) {
  const findings = [];
  const add = (code, url, message, detail) => findings.push({code, url, message, ...(detail ? {detail} : {})});
  const titles = groupBy(crawlRows.filter((row) => row.status === 200 && row.title), (row) => row.title.trim().toLowerCase());
  const descriptions = groupBy(crawlRows.filter((row) => row.status === 200 && row.meta_description), (row) => row.meta_description.trim().toLowerCase());
  const byUrl = new Map(crawlRows.map((row) => [normalizePage(row.url), row]));
  for (const row of crawlRows) {
    const url = row.url;
    if (row.status >= 500) add('server_error', url, `HTTP ${row.status}`);
    else if (row.status >= 400) add('client_error', url, `HTTP ${row.status}`);
    if (row.status >= 300 && row.status < 400 && (row.redirect_hops ?? 0) > 1) add('redirect_chain', url, `${row.redirect_hops} redirect hops`);
    if (row.status === 200 && !row.title) add('missing_title', url, 'no <title>');
    if (row.status === 200 && !row.meta_description) add('missing_meta_description', url, 'no meta description');
    if (row.status === 200 && row.canonical && normalizePage(row.canonical) !== normalizePage(url)) {
      const target = byUrl.get(normalizePage(row.canonical));
      add('canonical_mismatch', url, `canonical points to ${row.canonical}${target && target.status !== 200 ? ` which returns HTTP ${target.status}` : ''}`);
    }
    if (row.robots && /noindex/i.test(row.robots) && row.in_sitemap) add('noindex_in_sitemap', url, 'noindex page listed in the sitemap');
    if (row.status !== 200 && row.in_sitemap) add('non_200_in_sitemap', url, `sitemap lists a URL returning HTTP ${row.status}`);
    if (row.status === 200 && row.inlinks === 0) add('orphan_page', url, 'no internal inlinks found by the crawl');
    if (row.structured_data_errors > 0) add('structured_data_errors', url, `${row.structured_data_errors} structured data error(s)`);
  }
  for (const group of titles.values()) if (group.length > 1) for (const row of group) add('duplicate_title', row.url, `title shared by ${group.length} URLs`, group.map((item) => item.url));
  for (const group of descriptions.values()) if (group.length > 1) for (const row of group) add('duplicate_meta_description', row.url, `meta description shared by ${group.length} URLs`, group.map((item) => item.url));
  const summary = {};
  for (const finding of findings) summary[finding.code] = (summary[finding.code] ?? 0) + 1;
  return {summary, findings};
}

// ---------- Core Web Vitals ----------

const CWV_THRESHOLDS = {lcp_p75_ms: [2500, 4000], inp_p75_ms: [200, 500], cls_p75: [0.1, 0.25]};

export function cwvClass(metric, value) {
  if (value === null || value === undefined) return 'unknown';
  const [good, poor] = CWV_THRESHOLDS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs_improvement' : 'poor';
}

export function cwvFindings(currentRows, previousRows = []) {
  const previous = new Map(previousRows.map((row) => [`${normalizePage(row.url)}|${row.form_factor}`, row]));
  const rank = {good: 0, needs_improvement: 1, poor: 2, unknown: -1};
  const pages = [];
  const regressions = [];
  for (const row of currentRows) {
    const before = previous.get(`${normalizePage(row.url)}|${row.form_factor}`);
    const entry = {url: row.url, form_factor: row.form_factor, metrics: {}};
    for (const metric of Object.keys(CWV_THRESHOLDS)) {
      const status = cwvClass(metric, row[metric]);
      entry.metrics[metric] = {value: row[metric], status};
      if (before && before[metric] !== null && row[metric] !== null) {
        const previousStatus = cwvClass(metric, before[metric]);
        const worsenedPct = before[metric] === 0 ? 0 : ((row[metric] - before[metric]) / before[metric]) * 100;
        if (rank[status] > rank[previousStatus] || worsenedPct >= 20) {
          regressions.push({url: row.url, form_factor: row.form_factor, metric, previous: before[metric], current: row[metric], previous_status: previousStatus, status, change_pct: round(worsenedPct, 1)});
        }
      }
    }
    pages.push(entry);
  }
  return {pages, poor: pages.filter((page) => Object.values(page.metrics).some((metric) => metric.status === 'poor')), regressions};
}

// ---------- indexation ----------

export function indexationSummary(rows) {
  const counts = {};
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  const canonicalMismatch = rows.filter((row) => row.google_canonical && row.user_canonical && normalizePage(row.google_canonical) !== normalizePage(row.user_canonical));
  const unprovable = rows.filter((row) => ['unknown', 'other'].includes(row.verdict));
  return {
    counts,
    not_indexed: rows.filter((row) => !['indexed', 'unknown', 'other', 'redirect'].includes(row.verdict)),
    canonical_mismatch: canonicalMismatch.map((row) => ({url: row.url, google_canonical: row.google_canonical, user_canonical: row.user_canonical})),
    cannot_prove: unprovable.map((row) => ({url: row.url, coverage_state: row.coverage_state, note: 'the source does not establish index status for this URL'})),
    coverage_note: 'Index status is known only for URLs present in the source rows; absence from the rows proves nothing.',
  };
}

// ---------- ranking proxy from Search Console ----------

// Rank-tracker-shaped observations derived from dated GSC query rows: the
// impression-weighted average position per query (per country when present)
// over one window. Explicitly a proxy — an average across all impressions,
// devices, and SERP layouts, not a tracked SERP position.
export function rankProxyRows(rows, {start, end, minImpressions = 30, topQueries = 100, queries = null}) {
  const inWindow = rows.filter((row) => row.query && row.date >= start && row.date <= end);
  const groups = groupBy(inWindow, (row) => `${row.query}\u0000${row.country ?? ''}`);
  const observations = [];
  for (const group of groups.values()) {
    const impressions = group.reduce((total, row) => total + (Number(row.impressions) || 0), 0);
    if (impressions < minImpressions) continue;
    const positioned = group.filter((row) => row.position !== null && row.position !== undefined);
    const weight = positioned.reduce((total, row) => total + (Number(row.impressions) || 0), 0);
    if (!weight) continue;
    const pages = group.some((row) => row.page) ? rollup(group.filter((row) => row.page), ['page']).sort((a, b) => b.impressions - a.impressions) : [];
    observations.push({
      keyword: group[0].query,
      location: group[0].country ?? 'all',
      device: group[0].device ?? 'all',
      engine: 'google',
      position: round(positioned.reduce((total, row) => total + Number(row.position) * (Number(row.impressions) || 0), 0) / weight, 1),
      url: pages[0]?.page ?? '',
      serp_features: '',
      observed_at: `${end}T23:59:59Z`,
      provider: 'gsc_avg_position_proxy',
      impressions,
    });
  }
  const wanted = queries ? observations.filter((row) => queries.includes(row.keyword)) : observations.sort((a, b) => b.impressions - a.impressions).slice(0, topQueries);
  return wanted;
}
