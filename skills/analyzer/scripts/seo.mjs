#!/usr/bin/env node
// SEO subsystem commands. Analyzer7 diagnoses and measures; it never rewrites
// titles, content, or code. Opportunities go to Marketer7 for a decision.
//
//   audit     [--source gsc] [--rankings-source <id>] [--crawl-source <id>]
//             [--cwv-source <id>] [--index-source <id>] [--days 28]
//             [--before-start --before-end --after-start --after-end]
//             [--segment-key country] [--record] [--report]
//   rankings  --source <id> [--record]
//   compare   --before-start --before-end --after-start --after-end
//             [--source gsc] [--dimensions query|page|query,page]
//   rank-proxy --into <ranking source> [--source gsc] [--window-days 7] [--min-impressions 30]
//             [--top-queries 100 | --queries a,b]   (optional GSC average-position proxy)
//   technical --source <id>   cwv --source <id>   indexation --source <id>   behavior --source <clarity id>
//
// Common: [--project <dir>] [--now <ISO>]. Output: one JSON object.

import {UsageError, addDays, isoDate, listRecords, normalizePage, nowIso, parseArgs, parseTimestamp, printJson, requireInitialized, resolveProject, runCli, toCsv, writeExport} from './lib/core.mjs';
import {readScout} from './lib/neighbors.mjs';
import {sourceHealth} from './lib/quality.mjs';
import {createAnomaly, createOpportunity} from './lib/records.mjs';
import {table, writeReport} from './lib/report.mjs';
import * as seo from './lib/seo.mjs';
import {getSource, listObservations, loadSeoConfig, loadSources, selectRows} from './lib/state.mjs';
import {ingestFile} from './lib/ingest.mjs';

const COMMON = ['project', 'now'];
const SEO_CHANGE_TYPES = new Set(['seo_content_update', 'technical_seo_fix', 'content_publish', 'landing_page_change', 'performance_fix', 'schema_change', 'tracking_change']);

function context(argv, spec) {
  const args = parseArgs(argv, spec);
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  return {args, project, root, now: nowIso(args.now)};
}

function firstSourceOfType(root, type) {
  return loadSources(root).sources.find((source) => source.type === type)?.id ?? null;
}

function healthOf(root, sourceId, now) {
  const source = getSource(root, sourceId);
  return {source_id: sourceId, ...sourceHealth(source, parseTimestamp(now)), data_through: source?.data_through ?? null};
}

function periods(root, args, sourceId) {
  const given = ['beforeStart', 'beforeEnd', 'afterStart', 'afterEnd'].filter((key) => args[key]);
  // All four or none: a partial window must never fall back silently to the default one.
  if (given.length > 0 && given.length < 4) throw new UsageError('pass all four of --before-start, --before-end, --after-start, --after-end (or none, for the default windows)');
  if (given.length === 4) return {before: {start: args.beforeStart, end: args.beforeEnd}, after: {start: args.afterStart, end: args.afterEnd}};
  const source = getSource(root, sourceId);
  if (!source?.data_through) return null;
  const days = Number(args.days ?? 28);
  const through = isoDate(source.data_through);
  const after = {start: addDays(through, -(days - 1)), end: through};
  return {before: {start: addDays(after.start, -days), end: addDays(after.start, -1)}, after};
}

function gscRows(root, sourceId, period, {require = [], exclude = []} = {}) {
  const selection = selectRows(root, {sourceId, kind: 'gsc_rows', period, require, exclude});
  return {rows: selection.rows, snapshots: selection.snapshots};
}

// "Current" and "previous" follow the date the data describes, not when it was
// ingested, so a backfilled older snapshot never becomes "current". (Row
// selection elsewhere deliberately stays retrieval-ordered: a re-pull of the
// same day supersedes the earlier pull.)
function latestTwo(root, sourceId, kind) {
  const observedDate = (snapshot) => snapshot.period?.end ?? isoDate(snapshot.retrieved_at) ?? '';
  const snapshots = [...listObservations(root, {sourceId, kind})].sort((left, right) => observedDate(left).localeCompare(observedDate(right)) || String(left.retrieved_at).localeCompare(String(right.retrieved_at)));
  return {current: snapshots.at(-1) ?? null, previous: snapshots.at(-2) ?? null};
}

function gatherRankings(root, sourceId, config) {
  const {current, previous} = latestTwo(root, sourceId, 'rankings');
  if (!current) return null;
  return {current_file: current.file, previous_file: previous?.file ?? null, observed_at: current.period, ...seo.rankingChanges(previous?.rows ?? [], current.rows, config)};
}

function audit(argv) {
  const {args, project, root, now} = context(argv, {flags: ['record', 'report'], options: [...COMMON, 'source', 'rankings-source', 'crawl-source', 'cwv-source', 'index-source', 'behavior-source', 'days', 'before-start', 'before-end', 'after-start', 'after-end', 'segment-key']});
  const config = loadSeoConfig(root);
  const gsc = args.source ?? firstSourceOfType(root, 'search');
  const rankingsSource = args.rankingsSource ?? firstSourceOfType(root, 'ranking');
  const crawlSource = args.crawlSource ?? firstSourceOfType(root, 'crawl');
  const cwvSource = args.cwvSource ?? firstSourceOfType(root, 'performance');
  const indexSource = args.indexSource ?? firstSourceOfType(root, 'indexation');
  const behaviorSource = args.behaviorSource ?? loadSources(root).sources.find((source) => source.adapter === 'clarity')?.id ?? null;
  const gaps = [];
  const availability = [];
  // Rankings and behavior are optional: not every project has a rank tracker
  // or Clarity, so their absence is noted, not reported as a data gap.
  const OPTIONAL = new Set(['Rankings', 'Behavior (Clarity)']);
  for (const [label, sourceId] of [['Search Console', gsc], ['Rankings', rankingsSource], ['Crawl', crawlSource], ['Core Web Vitals', cwvSource], ['Indexation', indexSource], ['Behavior (Clarity)', behaviorSource]]) {
    if (!sourceId) {
      availability.push({label, source_id: null, health: OPTIONAL.has(label) ? 'not_configured (optional)' : 'not_configured'});
      if (!OPTIONAL.has(label)) gaps.push(`${label}: no source registered — the related sections cannot be evaluated`);
      continue;
    }
    const health = healthOf(root, sourceId, now);
    availability.push({label, ...health});
    if (!['ok'].includes(health.health)) gaps.push(`${label} (${sourceId}): ${health.warning}`);
  }
  const window = gsc ? periods(root, args, gsc) : null;
  const result = {status: 'audited', periods: window, availability, data_gaps: gaps};
  const segmentKey = args.segmentKey ?? (config.segments?.length ? config.segments[0].key ?? null : null);

  if (window && healthOf(root, gsc, now).health !== 'unavailable') {
    // Totals come from headline-safe (date-only) pulls only.
    const totalsBefore = gscRows(root, gsc, window.before, {exclude: ['query', 'page']});
    const totalsAfter = gscRows(root, gsc, window.after, {exclude: ['query', 'page']});
    result.overview = totalsAfter.rows.length
      ? {headline_safe: true, before: seo.totals(totalsBefore.rows), after: seo.totals(totalsAfter.rows)}
      : {headline_safe: false, note: 'no date-only (aggregate) pull: property totals are not reported rather than derived from query/page rows'};
    if (!totalsAfter.rows.length) gaps.push('GSC overview: pull a date-only aggregate export for headline totals');
    const queryBefore = gscRows(root, gsc, window.before, {require: ['query', 'page']});
    const queryAfter = gscRows(root, gsc, window.after, {require: ['query', 'page']});
    const pageBefore = gscRows(root, gsc, window.before, {require: ['page'], exclude: ['query']});
    const pageAfter = gscRows(root, gsc, window.after, {require: ['page'], exclude: ['query']});
    if (queryAfter.rows.length) {
      // Expected CTR by position, fitted from this property's own query data.
      const fit = seo.fitCtrCurve([...queryBefore.rows, ...queryAfter.rows], config.expected_ctr_curve);
      result.ctr_curve = fit;
      const afterDays = Math.round((Date.parse(window.after.end) - Date.parse(window.after.start)) / 86400000) + 1;
      result.top_queries = seo.rollup(queryAfter.rows, ['query']).sort((a, b) => b.impressions - a.impressions).slice(0, 10);
      result.ctr_opportunities = seo.ctrOpportunities(queryAfter.rows, config, {curve: fit.curve, days: afterDays});
      result.striking_distance = seo.strikingDistance(queryAfter.rows, config, {curve: fit.curve, days: afterDays});
      result.cannibalization = seo.cannibalization(queryAfter.rows, config, {segmentKey});
    } else {
      gaps.push('Query-level GSC rows (query×page) for the current period are missing: top queries, CTR opportunities, striking distance, and cannibalization are not evaluated');
    }
    if (queryBefore.rows.length && queryAfter.rows.length) {
      const movement = seo.comparePeriodsSeo(queryBefore.rows, queryAfter.rows, {dimensions: ['query'], beforePeriod: window.before, afterPeriod: window.after});
      result.query_movement = {summary: Object.fromEntries(['big_wins', 'improved', 'stable', 'slipping', 'dropped', 'new', 'lost'].map((key) => [key, movement[key].length])), ...seo.winnersAndDecliners(movement), new: movement.new.slice(0, 10), lost: movement.lost.slice(0, 10)};
    } else if (queryAfter.rows.length) {
      gaps.push('No query-level rows for the previous period: query winners/decliners are not evaluated');
    }
    const pageRowsBefore = pageBefore.rows.length ? pageBefore.rows : queryBefore.rows;
    const pageRowsAfter = pageAfter.rows.length ? pageAfter.rows : queryAfter.rows;
    if (pageRowsAfter.length) {
      result.top_pages = seo.rollup(pageRowsAfter, ['page']).sort((a, b) => b.clicks - a.clicks).slice(0, 10);
    }
    if (pageRowsBefore.length && pageRowsAfter.length) {
      const pageMovement = seo.comparePeriodsSeo(pageRowsBefore, pageRowsAfter, {dimensions: ['page'], beforePeriod: window.before, afterPeriod: window.after});
      result.page_movement = seo.winnersAndDecliners(pageMovement);
      result.content_decay = seo.contentDecay(pageMovement, config, {beforeDays: Math.round((Date.parse(window.before.end) - Date.parse(window.before.start)) / 86400000) + 1});
    }
    result.provenance = [...queryAfter.snapshots, ...queryBefore.snapshots, ...pageAfter.snapshots, ...totalsAfter.snapshots].map((snapshot) => ({file: snapshot.file, retrieved_at: snapshot.retrieved_at, rows_sha256: snapshot.rows_sha256})).filter((entry, index, all) => all.findIndex((other) => other.file === entry.file) === index);
  } else if (gsc) {
    gaps.push(`Search Console (${gsc}) is unavailable or has no data: no GSC figures are reported (nothing is estimated)`);
  }
  if (rankingsSource) {
    const rankings = gatherRankings(root, rankingsSource, config);
    if (rankings) {
      result.ranking_changes = rankings;
      if (!rankings.previous_file) gaps.push('Rankings: only one snapshot; changes need two');
    } else gaps.push(`Rankings (${rankingsSource}): no snapshot ingested`);
  }
  if (crawlSource) {
    const {current} = latestTwo(root, crawlSource, 'crawl');
    if (current) result.technical = {file: current.file, ...seo.technicalFindings(current.rows)};
    else gaps.push(`Crawl (${crawlSource}): no crawl snapshot — technical SEO checks not evaluated`);
  }
  if (cwvSource) {
    const {current, previous} = latestTwo(root, cwvSource, 'cwv');
    if (current) result.cwv = {file: current.file, previous_file: previous?.file ?? null, ...seo.cwvFindings(current.rows, previous?.rows ?? [])};
    else gaps.push(`Core Web Vitals (${cwvSource}): no snapshot`);
  }
  if (indexSource) {
    const {current} = latestTwo(root, indexSource, 'indexation');
    if (current) result.indexation = {file: current.file, ...seo.indexationSummary(current.rows)};
    else gaps.push(`Indexation (${indexSource}): no snapshot — index status is not asserted`);
  } else {
    result.indexation = {note: 'No indexation source: Analyzer7 cannot prove index status for any URL.'};
  }
  if (behaviorSource) {
    const {current} = latestTwo(root, behaviorSource, 'behavior');
    if (current) result.behavior = behaviorContext(current, result);
    else gaps.push(`Behavior (${behaviorSource}): registered but no Clarity snapshot`);
  }
  const since = window?.before.start ?? addDays(isoDate(now), -56);
  result.recent_seo_changes = listRecords(root, 'change').filter((change) => SEO_CHANGE_TYPES.has(change.data.type) && (isoDate(change.data.timestamp) ?? '') >= since).map((change) => ({id: change.data.id, timestamp: change.data.timestamp, type: change.data.type, title: change.data.title, pages: change.data.pages}));
  const scout = readScout(project);
  result.external_context = scout.batches.filter((batch) => (batch.opened ?? '') >= since).map((batch) => ({ref: batch.ref, title: batch.title, opened: batch.opened, path: batch.path}));

  result.ranked_opportunities = rankOpportunities(result);
  if (args.record) result.recorded = recordFindings(root, result, now, config);
  if (args.report) result.report = writeSeoReport(project, result, now).relative;
  printJson(result);
}

// Clarity rows for the pages the audit points at (top pages and opportunity
// pages), sessions-weighted across devices. Context only.
function behaviorContext(snapshot, result) {
  const pages = [...new Set([...(result.top_pages ?? []).map((row) => row.page), ...(result.ctr_opportunities ?? []).map((row) => row.page), ...(result.content_decay ?? []).map((row) => row.page)].filter(Boolean))];
  const byPage = new Map();
  for (const row of snapshot.rows) {
    const page = normalizePage(row.url);
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(row);
  }
  const weighted = (rows, field) => {
    const usable = rows.filter((row) => row[field] !== null && row[field] !== undefined);
    const sessions = usable.reduce((total, row) => total + (row.sessions ?? 0), 0);
    return usable.length ? Math.round((sessions ? usable.reduce((total, row) => total + row[field] * (row.sessions ?? 0), 0) / sessions : usable.reduce((total, row) => total + row[field], 0) / usable.length) * 10) / 10 : null;
  };
  const rows = pages.filter((page) => byPage.has(page)).map((page) => {
    const group = byPage.get(page);
    return {page, sessions: group.reduce((total, row) => total + (row.sessions ?? 0), 0), dead_click_pct: weighted(group, 'dead_click_pct'), rage_click_pct: weighted(group, 'rage_click_pct'), quickback_pct: weighted(group, 'quickback_pct'), scroll_depth_pct: weighted(group, 'scroll_depth_pct')};
  });
  return {file: snapshot.file, period: snapshot.period, rows, missing_pages: pages.filter((page) => !byPage.has(page)), note: 'Behavioral context from Microsoft Clarity: it can suggest why a page under-performs, but it is never evidence for a metric and never changes a confidence level.'};
}

// One list across types, by estimated clicks per 28 days. Striking-distance
// upside is hypothetical and cannibalization has no click estimate; both are
// kept separate rather than mixed into the ranking.
function rankOpportunities(result) {
  const ranked = [
    ...(result.ctr_opportunities ?? []).map((row) => ({type: 'ctr_opportunity', subject: `${row.query} → ${row.page}`, estimated_clicks_28d: row.estimated_click_gain_28d, basis: `CTR ${row.ctr_pct}% vs expected ${row.expected_ctr_pct}% at position ${row.avg_position}`})),
    ...(result.content_decay ?? []).map((row) => ({type: 'content_decay', subject: row.page, estimated_clicks_28d: row.estimated_click_loss_28d, basis: `clicks ${row.clicks_change_pct}% per day; recovering the before level`})),
  ].sort((a, b) => b.estimated_clicks_28d - a.estimated_clicks_28d);
  return {ranked, hypothetical_top3_upside: (result.striking_distance?.positions_4_15 ?? []).slice(0, 5).map((row) => ({subject: `${row.query} → ${row.page}`, upside_if_top3_28d: row.upside_if_top3_28d, position: row.avg_position})), note: 'estimated clicks per 28 days; estimates, not forecasts'};
}

function recordFindings(root, result, now, config) {
  const recorded = [];
  // Records are for review, not a checklist: at most max_recorded_per_type per
  // type (the most material first); the full lists stay in the report.
  const cap = config.thresholds.max_recorded_per_type ?? 10;
  const counts = {};
  const opportunity = (fields, body) => {
    counts[fields.type] = (counts[fields.type] ?? 0) + 1;
    if (counts[fields.type] > cap) return;
    recorded.push({...createOpportunity(root, fields, body, now), type: fields.type});
  };
  const period = result.periods?.after;
  const provenance = (result.provenance ?? []).map((entry) => `- \`${entry.file}\` retrieved ${entry.retrieved_at}`).join('\n') || '- none';
  for (const row of result.ctr_opportunities ?? []) {
    opportunity({title: `High impressions, low CTR: ${row.query}`, type: 'ctr_opportunity', dedupe_key: `ctr:${row.query}:${row.page}`, query: row.query, page: row.page, impressions: row.impressions, avg_position: row.avg_position, ctr_pct: row.ctr_pct, expected_ctr_pct: row.expected_ctr_pct, estimated_click_gain_28d: row.estimated_click_gain_28d, p_value: row.p_value, period_start: period?.start, period_end: period?.end, suggested_owner: 'marketer7'},
      `## Evidence\n\n- Query \`${row.query}\` → \`${row.page}\`: ${row.impressions} impressions, average position ${row.avg_position}, CTR ${row.ctr_pct}% (expected ~${row.expected_ctr_pct}% at this position, ${result.ctr_curve?.source ?? 'heuristic'} curve), ${period?.start} → ${period?.end}.\n- Estimated gain if CTR reached the expected level: ~${row.estimated_click_gain_28d} clicks per 28 days (an estimate, not a forecast).\n- Below-expected CTR is significant after FDR control (p = ${row.p_value}). Rule: ${row.rule}.\n\n## Provenance\n\n${provenance}\n`);
  }
  for (const finding of result.cannibalization ?? []) {
    opportunity({title: `Possible cannibalization: ${finding.query}`, type: 'cannibalization', dedupe_key: `cannibalization:${finding.query}`, query: finding.query, page: finding.urls.map((url) => url.page).join(' | '), query_impressions: finding.query_impressions, contested_impressions: finding.contested_impressions, period_start: period?.start, period_end: period?.end, suggested_owner: 'marketer7'},
      `## Evidence\n\n${table(['URL', 'Impressions', 'Share %', 'Avg position', 'Clicks'], finding.urls.map((url) => [url.page, url.impressions, url.share_pct, url.avg_position, url.clicks])).join('\n')}\n\n- Rule: ${finding.rule}.\n- Competing URLs are evidence only; consolidation is not concluded here — intent may legitimately differ between pages.\n\n## Provenance\n\n${provenance}\n`);
  }
  for (const row of (result.striking_distance?.positions_4_15 ?? []).slice(0, Math.min(5, cap))) {
    opportunity({title: `Positions 4–15: ${row.query}`, type: 'striking_distance', dedupe_key: `striking:${row.query}:${row.page}`, query: row.query, page: row.page, impressions: row.impressions, avg_position: row.avg_position, upside_if_top3_28d: row.upside_if_top3_28d, period_start: period?.start, period_end: period?.end, suggested_owner: 'marketer7'},
      `## Evidence\n\n- \`${row.query}\` → \`${row.page}\`: average position ${row.avg_position}, ${row.impressions} impressions, CTR ${row.ctr_pct}% (${period?.start} → ${period?.end}).\n- Hypothetical upside at about position 3: ~${row.upside_if_top3_28d} clicks per 28 days (a ranking change is not in Analyzer7's control and may not be achievable).\n\n## Provenance\n\n${provenance}\n`);
  }
  for (const row of result.content_decay ?? []) {
    opportunity({title: `Declining page: ${row.page}`, type: 'content_decay', dedupe_key: `decay:${row.page}`, page: row.page, clicks_before: row.before.clicks, clicks_after: row.after.clicks, estimated_click_loss_28d: row.estimated_click_loss_28d, p_value: row.p_value, period_start: period?.start, period_end: period?.end, suggested_owner: 'marketer7'},
      `## Evidence\n\n- \`${row.page}\`: clicks ${row.before.clicks} → ${row.after.clicks} (${row.clicks_change_pct}% on a comparable basis), position ${row.before.avg_position} → ${row.after.avg_position}.\n- Rule: clicks fell by at least ${config.thresholds.decline_pct}% from at least ${config.thresholds.min_clicks_for_decline} clicks.\n\n## Provenance\n\n${provenance}\n`);
  }
  for (const finding of result.technical?.findings ?? []) {
    if (['duplicate_meta_description', 'missing_meta_description'].includes(finding.code)) continue;
    opportunity({title: `Technical: ${finding.code} on ${finding.url}`, type: 'technical', dedupe_key: `technical:${finding.code}:${finding.url}`, page: finding.url, finding: finding.code, suggested_owner: 'hyper7'},
      `## Evidence\n\n- ${finding.message} (crawl snapshot \`${result.technical.file}\`).\n- Diagnosis only: Hyper7 fixes, Analyzer7 verifies with a later crawl.\n`);
  }
  for (const row of result.indexation?.not_indexed ?? []) {
    opportunity({title: `Not indexed: ${row.url}`, type: 'indexation', dedupe_key: `indexation:${row.url}:${row.verdict}`, page: row.url, verdict: row.verdict, suggested_owner: 'hyper7'},
      `## Evidence\n\n- ${row.url}: ${row.coverage_state} (verdict \`${row.verdict}\`) in \`${result.indexation.file}\`.\n- The source reports status; it does not prove the cause.\n`);
  }
  for (const alert of result.ranking_changes?.alerts ?? []) {
    recorded.push({...createAnomaly(root, {title: `Ranking loss: ${alert.keyword}`, kind: 'ranking_loss', dedupe_key: `ranking:${alert.keyword}:${alert.location}:${alert.device}:${alert.engine}`, metric: 'rank_position', subject: alert.keyword, source_id: 'rankings', severity: 'medium', previous_value: alert.previous_position, current_value: alert.current_position, data_quality: 'medium'},
      `## Observation\n\n- \`${alert.keyword}\` (${alert.location}, ${alert.device}, ${alert.engine}): position ${alert.previous_position ?? 'not ranking'} → ${alert.current_position ?? 'not ranking'} (${alert.previous_observed_at} → ${alert.observed_at}).\n${alert.url_changed ? `- The ranking URL switched ${alert.previous_url} → ${alert.current_url}: check for cannibalization.\n` : ''}- One rank-tracker observation per date; a single reading can be noisy.\n`, now), type: 'ranking_loss'});
  }
  for (const regression of result.cwv?.regressions ?? []) {
    recorded.push({...createAnomaly(root, {title: `CWV regression: ${regression.metric} on ${regression.url}`, kind: 'cwv_regression', dedupe_key: `cwv:${regression.url}:${regression.form_factor}:${regression.metric}`, metric: regression.metric, subject: regression.url, source_id: 'cwv', severity: regression.status === 'poor' ? 'high' : 'medium', previous_value: regression.previous, current_value: regression.current, data_quality: 'medium'},
      `## Observation\n\n- ${regression.url} (${regression.form_factor}): ${regression.metric} ${regression.previous} → ${regression.current} (${regression.previous_status} → ${regression.status}, ${regression.change_pct}%).\n- p75 field data lags by up to 28 days; confirm with a later snapshot before acting.\n`, now), type: 'cwv_regression'});
  }
  return recorded;
}

function lengths(period) {
  const days = (window) => Math.round((Date.parse(window.end) - Date.parse(window.start)) / 86400000) + 1;
  return {before: days(period.before), after: days(period.after)};
}

function basisNote(period) {
  const {before, after} = lengths(period);
  return before === after ? `_Windows: ${before} days each; clicks compared as totals._` : `_Windows: ${before} vs ${after} days; click changes are normalized per day (raw totals shown for reference)._`;
}

function significanceNote(result) {
  const parts = [result.query_movement, result.page_movement].filter(Boolean).map((movement, index) => `${index === 0 && result.query_movement ? 'queries' : 'pages'}: ${movement.significant} of ${movement.tested} changes significant`);
  return parts.length ? `_Listed only if the click change survives false-discovery-rate control (q = 0.1); ${parts.join('; ')}._` : '';
}

function movementLine(kind, name, row) {
  const pct = row.before.clicks > 0 ? Math.round((row.clicks_delta / row.before.clicks) * 1000) / 10 : null;
  return `- ${kind} \`${name}\`: clicks ${row.before.clicks} → ${row.after.clicks} raw (${pct === null ? 'new' : `${pct > 0 ? '+' : ''}${pct}%`} per day), position ${row.before.avg_position} → ${row.after.avg_position} (${row.movement})`;
}

function trendLines(overview, period) {
  const {before, after} = lengths(period);
  const perDay = (value, days) => Math.round((value / days) * 10) / 10;
  // No baseline volume means no percentage: say so instead of printing Infinity/NaN.
  const change = (b, a) => (b > 0 ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 1000) / 10}%` : a > 0 ? 'new (no baseline volume)' : 'no volume in either window');
  return [
    `Clicks ${overview.before.clicks} (${before} d, ${perDay(overview.before.clicks, before)}/day) → ${overview.after.clicks} (${after} d, ${perDay(overview.after.clicks, after)}/day): ${change(overview.before.clicks / before, overview.after.clicks / after)} per day.`,
    `Impressions ${overview.before.impressions} (${perDay(overview.before.impressions, before)}/day) → ${overview.after.impressions} (${perDay(overview.after.impressions, after)}/day): ${change(overview.before.impressions / before, overview.after.impressions / after)} per day.`,
    `CTR ${overview.before.ctr_pct}% → ${overview.after.ctr_pct}%; average position ${overview.before.avg_position} → ${overview.after.avg_position}.`,
    before === after ? 'Equal-length windows.' : 'Unequal windows: weekday mix differs slightly.',
    'Observation only: no change is attributed here. Use the evidence skill with a registered change for attribution.',
  ];
}

function writeSeoReport(project, result, now) {
  const fmt = (value) => (value === null || value === undefined ? 'unknown' : value);
  const period = result.periods;
  const sections = [
    {title: 'Data availability', lines: table(['Area', 'Source', 'Health', 'Data through'], result.availability.map((entry) => [entry.label, entry.source_id ?? '—', entry.health, entry.data_through ?? '—']))},
    {title: 'GSC overview', lines: result.overview ? (result.overview.headline_safe ? table(['Period', 'Clicks', 'Impressions', 'CTR %', 'Avg position'], [[`${period.before.start} → ${period.before.end}`, result.overview.before.clicks, result.overview.before.impressions, fmt(result.overview.before.ctr_pct), fmt(result.overview.before.avg_position)], [`${period.after.start} → ${period.after.end}`, result.overview.after.clicks, result.overview.after.impressions, fmt(result.overview.after.ctr_pct), fmt(result.overview.after.avg_position)]]) : [`DATA GAP — ${result.overview.note}`]) : ['DATA GAP — no Search Console data.']},
    {title: 'Organic trend', lines: result.overview?.headline_safe ? trendLines(result.overview, period) : ['DATA GAP — needs a date-only aggregate pull.']},
    {title: 'Top queries', lines: result.top_queries ? table(['Query', 'Impressions', 'Clicks', 'CTR %', 'Avg position'], result.top_queries.map((row) => [row.query, row.impressions, row.clicks, row.ctr_pct, row.avg_position])) : ['DATA GAP — no query-level rows.']},
    {title: 'Top pages', lines: result.top_pages ? table(['Page', 'Clicks', 'Impressions', 'CTR %', 'Avg position'], result.top_pages.map((row) => [row.page, row.clicks, row.impressions, row.ctr_pct, row.avg_position])) : ['DATA GAP — no page-level rows.']},
    {title: 'Top opportunities by estimated click gain', lines: [...table(['Type', 'Subject', 'Est. clicks / 28 d', 'Basis'], (result.ranked_opportunities?.ranked ?? []).slice(0, 10).map((row) => [row.type, row.subject, row.estimated_clicks_28d, row.basis])), '', ...(result.ranked_opportunities?.hypothetical_top3_upside?.length ? ['Hypothetical upside if a positions 4–15 query reached about position 3 (not a forecast):', ...result.ranked_opportunities.hypothetical_top3_upside.map((row) => `- ${row.subject} (position ${row.position}): ~${row.upside_if_top3_28d} clicks / 28 d`)] : []), '', result.ctr_curve ? `Expected-CTR curve: ${result.ctr_curve.source} — ${result.ctr_curve.note}.` : 'Expected-CTR curve: heuristic (no query data).']},
    {title: 'Winning queries/pages', lines: [basisNote(period), significanceNote(result), ...(result.query_movement?.winning ?? []).map((row) => movementLine('query', row.query, row)), ...(result.page_movement?.winning ?? []).map((row) => movementLine('page', row.page, row))]},
    {title: 'Declining queries/pages', lines: [basisNote(period), significanceNote(result), ...(result.query_movement?.declining ?? []).map((row) => movementLine('query', row.query, row)), ...(result.page_movement?.declining ?? []).map((row) => movementLine('page', row.page, row))]},
    {title: 'Positions 4–15 opportunities', lines: table(['Query', 'Page', 'Avg position', 'Impressions', 'CTR %'], (result.striking_distance?.positions_4_15 ?? []).slice(0, 10).map((row) => [row.query, row.page, row.avg_position, row.impressions, row.ctr_pct]))},
    {title: 'High-impression low-CTR opportunities', lines: table(['Query', 'Page', 'Impressions', 'Avg position', 'CTR %', 'Expected CTR %', 'Est. clicks / 28 d'], (result.ctr_opportunities ?? []).map((row) => [row.query, row.page, row.impressions, row.avg_position, row.ctr_pct, row.expected_ctr_pct, row.estimated_click_gain_28d]))},
    {title: 'Cannibalization candidates', lines: (result.cannibalization ?? []).flatMap((finding) => [`- \`${finding.query}\` (${finding.query_impressions} impressions): ${finding.urls.map((url) => `${url.page} pos ${url.avg_position} (${url.share_pct}%)`).join('; ')} — evidence of competition, not a consolidation decision`])},
    {title: 'Indexation issues', lines: result.indexation?.counts ? [`Counts: ${Object.entries(result.indexation.counts).map(([key, value]) => `${key} ${value}`).join(', ')}`, ...result.indexation.not_indexed.map((row) => `- ${row.url}: ${row.coverage_state}`), ...result.indexation.canonical_mismatch.map((row) => `- ${row.url}: Google canonical ${row.google_canonical} ≠ declared ${row.user_canonical}`), ...result.indexation.cannot_prove.map((row) => `- ${row.url}: cannot prove (${row.coverage_state})`), result.indexation.coverage_note] : [result.indexation?.note ?? 'DATA GAP']},
    {title: 'Technical SEO', lines: result.technical ? [`Summary: ${Object.entries(result.technical.summary).map(([key, value]) => `${key} ${value}`).join(', ') || 'no findings'}`, ...result.technical.findings.map((finding) => `- ${finding.code}: ${finding.url} — ${finding.message}`)] : ['DATA GAP — no crawl snapshot.']},
    {title: 'CWV/performance issues', lines: result.cwv ? [...result.cwv.regressions.map((row) => `- regression: ${row.url} ${row.metric} ${row.previous} → ${row.current} (${row.previous_status} → ${row.status})`), ...result.cwv.poor.map((page) => `- poor: ${page.url} (${page.form_factor})`), ...(result.cwv.regressions.length || result.cwv.poor.length ? [] : ['No regressions or poor pages in the snapshot.'])] : ['DATA GAP — no Core Web Vitals snapshot.']},
    {title: 'Ranking changes', lines: result.ranking_changes ? [`Summary: ${Object.entries(result.ranking_changes.summary).map(([key, value]) => `${key} ${value}`).join(', ')} (${result.ranking_changes.previous_file ?? 'no previous'} → ${result.ranking_changes.current_file})`, ...result.ranking_changes.changes.map((row) => `- \`${row.keyword}\` ${row.location}/${row.device}: ${row.previous_position ?? '—'} → ${row.current_position ?? '—'} (${row.movement})${row.url_changed ? ' — ranking URL switched' : ''}${row.alert ? ' — ALERT' : ''}`)] : ['DATA GAP — no rank-tracker source.']},
    {title: 'Behavior context (Clarity, optional)', lines: result.behavior ? [...table(['Page', 'Sessions', 'Dead click %', 'Rage click %', 'Quick-back %', 'Scroll depth %'], result.behavior.rows.map((row) => [row.page, row.sessions, row.dead_click_pct ?? '—', row.rage_click_pct ?? '—', row.quickback_pct ?? '—', row.scroll_depth_pct ?? '—'])), '', `${result.behavior.note} Snapshot ${result.behavior.file} (${result.behavior.period?.start} → ${result.behavior.period?.end}).`] : ['Not configured (optional).']},
    {title: 'Recent SEO-related changes', lines: result.recent_seo_changes.map((change) => `- ${change.id} ${change.timestamp ?? 'unknown time'} ${change.type}: ${change.title}`)},
    {title: 'Potential confounders', lines: [...result.recent_seo_changes.map((change) => `- ${change.id} lands inside the compared windows`), ...result.external_context.map((entry) => `- ${entry.ref} (${entry.title}, opened ${entry.opened}) — external context from Scout7`), ...result.availability.filter((entry) => entry.health && entry.warning && !String(entry.health).startsWith('not_configured') && entry.health !== 'ok').map((entry) => `- ${entry.label}: ${entry.warning}`)]},
    {title: 'Evidence-backed opportunities', lines: result.recorded ? result.recorded.map((entry) => `- ${entry.id} (${entry.type}) — ${entry.status}`) : ['Run with --record to register opportunities as SEO-OPP records for Marketer7 review.']},
    {title: 'Data gaps', lines: result.data_gaps.map((gap) => `- ${gap}`)},
  ];
  return writeReport(project, {mode: 'audit', scope: 'seo', now, title: `SEO health — ${isoDate(now)}`, sources: result.availability.map((entry) => entry.source_id).filter(Boolean), artifacts: (result.provenance ?? []).map((entry) => entry.file), sections});
}

function rankings(argv) {
  const {args, root, now} = context(argv, {flags: ['record'], options: [...COMMON, 'source']});
  const sourceId = args.source ?? firstSourceOfType(root, 'ranking');
  if (!sourceId) throw new UsageError('no ranking source registered');
  const health = healthOf(root, sourceId, now);
  const changes = gatherRankings(root, sourceId, loadSeoConfig(root));
  const output = {status: changes ? 'compared' : 'insufficient_data', source_health: health, stale_warning: health.health === 'stale' ? health.warning : null, rankings: changes};
  if (args.record && changes) output.recorded = recordFindings(root, {ranking_changes: changes}, now, loadSeoConfig(root));
  printJson(output);
}

function compare(argv) {
  const {args, root} = context(argv, {options: [...COMMON, 'source', 'before-start', 'before-end', 'after-start', 'after-end'], lists: ['dimensions']});
  const gsc = args.source ?? firstSourceOfType(root, 'search');
  const window = periods(root, args, gsc);
  if (!window) throw new UsageError('no periods: pass --before-*/--after-* or ingest GSC data');
  const dimensions = args.dimensions ?? ['query'];
  const before = gscRows(root, gsc, window.before, {require: dimensions});
  const after = gscRows(root, gsc, window.after, {require: dimensions});
  if (!before.rows.length || !after.rows.length) {
    printJson({status: 'insufficient_data', periods: window, reason: `no ${dimensions.join('×')} rows for ${before.rows.length ? 'the after' : 'the before'} period`});
    return;
  }
  const movement = seo.comparePeriodsSeo(before.rows, after.rows, {dimensions, beforePeriod: window.before, afterPeriod: window.after});
  printJson({status: 'compared', periods: window, dimensions, summary: Object.fromEntries(['big_wins', 'improved', 'stable', 'slipping', 'dropped', 'new', 'lost'].map((key) => [key, movement[key].length])), movement});
}

// rank-proxy: derive rank observations for the latest window and the one
// before it from dated GSC query rows, and ingest them into a ranking source.
function rankProxy(argv) {
  const {args, project, root, now} = context(argv, {options: [...COMMON, 'source', 'into', 'window-days', 'min-impressions', 'top-queries'], lists: ['queries']});
  const gsc = args.source ?? firstSourceOfType(root, 'search');
  const target = getSource(root, args.into ?? '');
  if (!target || target.type !== 'ranking' || target.adapter !== 'rankings') throw new UsageError('--into must be a registered ranking source with adapter rankings (for example: record.mjs source --id rank-proxy --type ranking --adapter rankings --provider gsc_avg_position_proxy)');
  const source = getSource(root, gsc);
  if (!source?.data_through) throw new UsageError(`${gsc} has no ingested data`);
  const days = Number(args.windowDays ?? 7);
  const through = isoDate(source.data_through);
  const current = {start: addDays(through, -(days - 1)), end: through};
  const previous = {start: addDays(current.start, -days), end: addDays(current.start, -1)};
  const {rows} = selectRows(root, {sourceId: gsc, kind: 'gsc_rows', period: {start: previous.start, end: current.end}, require: ['date', 'query']});
  if (!rows.length) throw new UsageError(`${gsc} has no dated query rows (pull GSC with --dimensions date,query or date,query,country)`);
  const options = {minImpressions: Number(args.minImpressions ?? 30), topQueries: Number(args.topQueries ?? 100)};
  const currentRows = seo.rankProxyRows(rows, {...current, ...options, queries: args.queries ?? null});
  const tracked = currentRows.map((row) => row.keyword);
  const previousRows = seo.rankProxyRows(rows, {...previous, ...options, queries: args.queries ?? tracked});
  const columns = ['keyword', 'location', 'device', 'engine', 'position', 'url', 'serp_features', 'observed_at', 'provider'];
  const results = [];
  for (const [period, list] of [[previous, previousRows], [current, currentRows]]) {
    const file = writeExport(`rank-proxy-${period.start}_${period.end}.csv`, toCsv(list, columns));
    const ingested = ingestFile(root, project, target.id, {input: file, provider: 'gsc_avg_position_proxy', retrievedAt: now}, now);
    results.push({period, keywords: list.length, observation: ingested.observation});
  }
  printJson({status: 'derived', note: 'gsc_avg_position_proxy: impression-weighted average position over each window, not a tracked SERP position', window_days: days, snapshots: results});
}

function single(kind, analyze) {
  return (argv) => {
    const {args, root, now} = context(argv, {options: [...COMMON, 'source']});
    if (!args.source) throw new UsageError('--source is required');
    const {current, previous} = latestTwo(root, args.source, kind);
    if (!current) {
      printJson({status: 'insufficient_data', source_health: healthOf(root, args.source, now), reason: `no ${kind} snapshot for ${args.source}`});
      return;
    }
    printJson({status: 'analyzed', file: current.file, source_health: healthOf(root, args.source, now), ...analyze(current, previous)});
  };
}

function main(argv) {
  const [command, ...rest] = argv;
  const commands = {
    audit,
    rankings,
    'rank-proxy': rankProxy,
    compare,
    behavior: single('behavior', (current) => ({rows: current.rows, note: 'behavioral context only; never evidence'})),
    technical: single('crawl', (current) => seo.technicalFindings(current.rows)),
    cwv: single('cwv', (current, previous) => seo.cwvFindings(current.rows, previous?.rows ?? [])),
    indexation: single('indexation', (current) => seo.indexationSummary(current.rows)),
  };
  if (!commands[command]) throw new UsageError(`seo.mjs <${Object.keys(commands).join('|')}> [options]`);
  commands[command](rest);
  return 0;
}

runCli(main);
