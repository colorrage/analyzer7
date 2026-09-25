// Control groups and seasonality.
//
// Difference-in-differences: a page-scoped change is compared with untouched
// pages in the same markets over the same windows, so shared shocks
// (seasonality, demand, algorithm updates) cancel out. Year-over-year: the
// same windows 52 weeks earlier show whether the "effect" is a seasonal
// pattern. Both only ever lower or clarify confidence; neither fabricates
// data — without enough control or last-year data the analysis says so.

import {addDays, isoDate, normalizePage, round} from './core.mjs';
import {selectRows} from './state.mjs';
import {dailyValues, filterRows} from './stats.mjs';

// Market of a page: the longest configured segment URL prefix, else the first
// path segment when it looks like a language/market code, else the root market.
export function segmentOf(page, segments = []) {
  const path = normalizePage(page) ?? '/';
  const prefixes = segments.map((segment) => normalizePage(segment.url_prefix)).filter((prefix) => prefix && prefix !== '/').sort((a, b) => b.length - a.length);
  const configured = prefixes.find((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (configured) return configured;
  if (prefixes.length) return '/';
  const first = path.split('/')[1] ?? '';
  return /^[a-z]{2}(?:-[a-z]{2})?$/i.test(first) ? `/${first}` : '/';
}

function changedPagesInWindow(changes, start, end) {
  const pages = new Set();
  let unknownScope = 0;
  for (const change of changes) {
    const date = isoDate(change.data.timestamp);
    if (!date || date < start || date > end) continue;
    const list = Array.isArray(change.data.pages) ? change.data.pages : [];
    if (list.length === 0) unknownScope += 1;
    for (const page of list) pages.add(normalizePage(page));
  }
  return {pages, unknownScope};
}

// Untouched pages in the treated pages' markets that have rows in both windows.
// At planning time there is no after window yet: pass after = null and only
// before-window data is required (the evaluation re-checks both windows).
export function selectControlPages(root, {sourceId, before, after = null, treatedPages, changes, segments = [], limit = 200}) {
  const end = after ? after.end : before.end;
  const treated = new Set(treatedPages.map(normalizePage));
  const markets = new Set([...treated].map((page) => segmentOf(page, segments)));
  const {pages: changed, unknownScope} = changedPagesInWindow(changes, before.start, end);
  const selection = selectRows(root, {sourceId, kind: 'gsc_rows', period: {start: before.start, end}, require: ['page'], exclude: ['query']});
  const seen = {before: new Map(), after: new Map()};
  for (const row of selection.rows) {
    const page = normalizePage(row.page);
    const date = isoDate(row.date);
    const window = date <= before.end ? 'before' : after && date >= after.start ? 'after' : null;
    if (!window || treated.has(page) || changed.has(page) || !markets.has(segmentOf(page, segments))) continue;
    seen[window].set(page, (seen[window].get(page) ?? 0) + (Number(row.impressions) || 0));
  }
  const pages = [...seen.before.keys()].filter((page) => !after || seen.after.has(page)).sort((a, b) => seen.before.get(b) - seen.before.get(a)).slice(0, limit);
  return {pages, markets: [...markets].sort(), excluded_changed: changed.size, unknown_scope_changes: unknownScope};
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function welch(left, right) {
  if (left.length < 3 || right.length < 3) return null;
  const variance = (values, average) => values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
  const leftMean = mean(left);
  const rightMean = mean(right);
  const standardError = Math.sqrt(variance(left, leftMean) / left.length + variance(right, rightMean) / right.length);
  if (standardError === 0) return rightMean === leftMean ? 0 : Math.sign(rightMean - leftMean) * 99;
  return Math.max(-99, Math.min(99, (rightMean - leftMean) / standardError));
}

// DiD over daily series. Counts use an index (each day ÷ the group's own
// before-period daily mean) so groups of different size are comparable;
// ratios and means use levels.
export function differenceInDifferences({mapping, kind, treatedBeforeRows, treatedAfterRows, controlBeforeRows, controlAfterRows}) {
  const byDate = (rows) => new Map(dailyValues(rows, mapping, kind).map((day) => [day.date, day.value]));
  const treatedBefore = byDate(treatedBeforeRows);
  const treatedAfter = byDate(treatedAfterRows);
  const controlBefore = byDate(controlBeforeRows);
  const controlAfter = byDate(controlAfterRows);
  const mode = mapping.aggregation === 'sum' ? 'index' : 'level';
  const treatedBase = mean([...treatedBefore.values()]);
  const controlBase = mean([...controlBefore.values()]);
  if (mode === 'index' && (!treatedBase || !controlBase)) return {usable: false, reason: 'a group has no volume in the before window'};
  const scale = (value, base) => (mode === 'index' ? value / base : value);
  const series = (treated, control) => [...treated.keys()].filter((date) => control.has(date)).sort().map((date) => ({date, value: scale(treated.get(date), treatedBase) - scale(control.get(date), controlBase)}));
  const before = series(treatedBefore, controlBefore);
  const after = series(treatedAfter, controlAfter);
  if (before.length < 7 || after.length < 7) return {usable: false, reason: `needs >= 7 matched days per window (have ${before.length} and ${after.length})`};
  const effect = mean(after.map((day) => day.value)) - mean(before.map((day) => day.value));
  const statistic = welch(before.map((day) => day.value), after.map((day) => day.value));
  const half = Math.floor(before.length / 2);
  const preTrend = welch(before.slice(0, half).map((day) => day.value), before.slice(half).map((day) => day.value));
  return {
    usable: true,
    mode,
    effect: round(mode === 'index' ? effect * 100 : effect, 3),
    effect_unit: mode === 'index' ? 'percent of the before level, net of control' : 'metric units, net of control',
    statistic: statistic === null ? null : round(statistic, 3),
    method: 'did_welch_daily',
    pre_trend: {statistic: preTrend === null ? null : round(preTrend, 3), passed: preTrend !== null && Math.abs(preTrend) < 2, note: 'difference series, first vs second half of the before window'},
    matched_days: {before: before.length, after: after.length},
  };
}

export function lastYear(period) {
  return {start: addDays(period.start, -364), end: addDays(period.end, -364)};
}

export function scopedRows(root, {sourceId, kind, period, scope}) {
  const required = ['page', 'query', 'country', 'device', 'segment'].filter((dimension) => scope?.[dimension] !== undefined);
  let selection = selectRows(root, {sourceId, kind, period, require: required, exclude: kind === 'gsc_rows' && required.length === 0 ? ['query', 'page'] : []});
  if (selection.rows.length === 0 && kind === 'gsc_rows' && required.length === 0) selection = selectRows(root, {sourceId, kind, period});
  return filterRows(selection.rows, {start: period.start, end: period.end, scope});
}

