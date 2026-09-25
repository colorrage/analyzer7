// SEO analyses over normalized observations. Every function returns evidence
// rows (numbers + the rule that flagged them); none prescribes a fix. The
// decision belongs to Marketer7, execution to Signal7 (content) or Hyper7
// (technical), and verification back to Analyzer7.

import {daysInclusive, normalizePage, round} from './core.mjs';

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

// ---------- opportunities ----------

// High impressions, position 4–15 (configurable), CTR well under the expected
// CTR for that position. Flag only — the title rewrite is not Analyzer7's call.
export function ctrOpportunities(rows, config, {dimensions = ['query', 'page']} = {}) {
  const {thresholds, expected_ctr_curve: curve} = config;
  return rollup(rows, dimensions)
    .filter((row) => row.impressions >= thresholds.high_impressions && row.avg_position !== null)
    .filter((row) => row.avg_position >= 1 && row.avg_position <= thresholds.quick_win_position_max)
    .map((row) => ({...row, expected_ctr_pct: round(expectedCtr(row.avg_position, curve), 2)}))
    .filter((row) => row.ctr_pct !== null && row.ctr_pct < row.expected_ctr_pct * thresholds.ctr_gap_ratio)
    .map((row) => ({...row, ctr_gap_pct_points: round(row.expected_ctr_pct - row.ctr_pct, 2), rule: `impressions >= ${thresholds.high_impressions}, position <= ${thresholds.quick_win_position_max}, CTR < ${thresholds.ctr_gap_ratio} × heuristic expected CTR`}))
    .sort((a, b) => b.impressions * b.ctr_gap_pct_points - a.impressions * a.ctr_gap_pct_points);
}

export function strikingDistance(rows, config, {dimensions = ['query', 'page']} = {}) {
  const {thresholds} = config;
  const rolled = rollup(rows, dimensions).filter((row) => row.impressions >= thresholds.min_impressions && row.avg_position !== null);
  return {
    positions_4_15: rolled.filter((row) => row.avg_position >= thresholds.quick_win_position_min && row.avg_position <= thresholds.quick_win_position_max).sort((a, b) => b.impressions - a.impressions),
    positions_15_30: rolled.filter((row) => row.avg_position > thresholds.striking_distance_min && row.avg_position <= thresholds.striking_distance_max).sort((a, b) => b.impressions - a.impressions),
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
      rule: `>= 2 URLs each with >= ${thresholds.cannibalization_min_share * 100}% of the query's impressions and an average position <= ${thresholds.cannibalization_max_position ?? 20}`,
    });
  }
  return findings.sort((a, b) => b.query_impressions - a.query_impressions);
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
    moved.push({
      ...Object.fromEntries(dimensions.map((dimension) => [dimension, current[dimension]])),
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
export function winnersAndDecliners(comparison, {limit = 10, minClicks = 5} = {}) {
  const all = [...comparison.big_wins, ...comparison.improved, ...comparison.stable, ...comparison.slipping, ...comparison.dropped]
    .filter((row) => Math.max(row.before.clicks, row.after.clicks) >= minClicks);
  return {
    winning: [...all].sort((a, b) => b.clicks_delta - a.clicks_delta).filter((row) => row.clicks_delta > 0).slice(0, limit),
    declining: [...all].sort((a, b) => a.clicks_delta - b.clicks_delta).filter((row) => row.clicks_delta < 0).slice(0, limit),
  };
}

// Content decay: pages whose clicks fell by >= decline_pct between periods.
export function contentDecay(comparison, config) {
  const {decline_pct: declinePct, min_clicks_for_decline: minClicks} = config.thresholds;
  return [...comparison.slipping, ...comparison.dropped, ...comparison.stable, ...comparison.improved]
    .filter((row) => row.before.clicks >= minClicks)
    .map((row) => ({...row, clicks_change_pct: round((row.clicks_delta / row.before.clicks) * 100, 1)}))
    .filter((row) => row.clicks_change_pct <= -declinePct)
    .sort((a, b) => a.clicks_change_pct - b.clicks_change_pct);
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
