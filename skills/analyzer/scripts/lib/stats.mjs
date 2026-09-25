// Metric aggregation and period comparison.
//
// Rules the family learned the hard way (CMR SEO audits) and that are enforced
// here rather than left to prose:
// - ratios are ratios of sums, never averages of ratios;
// - positions are impression-weighted;
// - sums are compared per day when period lengths differ;
// - significance is estimated from daily variation when daily rows exist,
//   because web counts are over-dispersed and Poisson alone is overconfident.

import {daysInclusive, isoDate, normalizePage, round} from './core.mjs';

export const AGGREGATIONS = new Set(['sum', 'ratio_of_sums', 'weighted_mean', 'mean', 'last']);

// Merge the metric's defaults with its per-source mapping.
export function resolveMapping(metric, sourceId) {
  const override = metric.source_mappings?.[sourceId] ?? {};
  return {
    aggregation: override.aggregation ?? metric.aggregation,
    field: override.field ?? metric.field ?? 'value',
    series: override.series ?? metric.series ?? null,
    numerator: override.numerator ?? metric.numerator ?? null,
    denominator: override.denominator ?? metric.denominator ?? null,
    weight: override.weight ?? metric.weight ?? null,
    scale: override.scale ?? metric.scale ?? 1,
    filter: {...(metric.filter ?? {}), ...(override.filter ?? {})},
    metric_id: metric.id,
  };
}

// Timeseries rows carry {metric, value}; the "field" of a timeseries metric is
// a series name. Wide rows (GSC) carry named numeric columns. A missing or
// non-numeric cell is `null` — never 0 — and is skipped and counted.
function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function valueOf(row, name, kind) {
  if (kind === 'timeseries') return row.metric === name ? numeric(row.value) : null;
  return numeric(row[name]);
}

// A timeseries metric reads the series named by `series`, else a non-default
// `field`, else a series named after the metric itself.
function seriesFieldFor(mapping, kind) {
  if (kind !== 'timeseries') return mapping.field;
  return mapping.series ?? (mapping.field && mapping.field !== 'value' ? mapping.field : mapping.metric_id);
}

export function matchesScope(row, scope = {}) {
  for (const [key, expected] of Object.entries(scope)) {
    if (expected === null || expected === undefined || (Array.isArray(expected) && expected.length === 0)) continue;
    const expectedValues = (Array.isArray(expected) ? expected : [expected]).map((value) => (key === 'page' ? normalizePage(value) : String(value)));
    const actual = key === 'page' ? normalizePage(row.page) : row[key] === undefined ? undefined : String(row[key]);
    if (actual === undefined || actual === null) return false;
    if (!expectedValues.includes(actual)) return false;
  }
  return true;
}

export function filterRows(rows, {start, end, scope} = {}) {
  return rows.filter((row) => {
    const date = isoDate(row.date);
    if ((start || end) && date) {
      if (start && date < start) return false;
      if (end && date > end) return false;
    }
    return matchesScope(row, scope);
  });
}

export function aggregate(rows, mapping, kind) {
  const seriesField = seriesFieldFor(mapping, kind);
  const relevant = kind === 'timeseries'
    ? rows.filter((row) => [seriesField, mapping.numerator, mapping.denominator, mapping.weight].filter(Boolean).includes(row.metric))
    : rows;
  const dates = new Set(relevant.map((row) => isoDate(row.date)).filter(Boolean));
  let missing = 0;
  // Sum of the named values over rows, skipping (and counting) missing cells.
  const total = (name) => relevant.reduce((sum, row) => {
    if (kind === 'timeseries' && row.metric !== name) return sum;
    const value = valueOf(row, name, kind);
    if (value === null) {
      missing += 1;
      return sum;
    }
    return sum + value;
  }, 0);
  const present = (name) => relevant.filter((row) => (kind !== 'timeseries' || row.metric === name) && valueOf(row, name, kind) !== null);
  const base = () => ({row_count: relevant.length, distinct_dates: dates.size, missing_values: missing});
  switch (mapping.aggregation) {
    case 'sum': {
      const value = total(seriesField);
      return {...base(), value: present(seriesField).length ? value : null, sample: value};
    }
    case 'ratio_of_sums': {
      const numerator = total(mapping.numerator);
      const denominator = total(mapping.denominator);
      return {...base(), numerator, denominator, value: denominator > 0 ? (numerator / denominator) * mapping.scale : null, sample: denominator};
    }
    case 'weighted_mean': {
      let weighted = 0;
      let weight = 0;
      if (kind === 'timeseries') {
        // One series per row: pair the field and weight series by date and segment.
        const groups = new Map();
        for (const row of relevant) {
          const key = `${isoDate(row.date)}\u0000${row.segment ?? ''}`;
          if (!groups.has(key)) groups.set(key, {});
          const value = numeric(row.value);
          if (value === null) missing += 1;
          else groups.get(key)[row.metric] = (groups.get(key)[row.metric] ?? 0) + value;
        }
        for (const group of groups.values()) {
          if (group[mapping.field] === undefined || group[mapping.weight] === undefined) {
            missing += 1;
            continue;
          }
          weighted += group[mapping.field] * group[mapping.weight];
          weight += group[mapping.weight];
        }
      } else {
        for (const row of relevant) {
          const value = valueOf(row, mapping.field, kind);
          const rowWeight = valueOf(row, mapping.weight, kind);
          if (value === null || rowWeight === null) {
            missing += 1;
            continue;
          }
          weighted += value * rowWeight;
          weight += rowWeight;
        }
      }
      return {...base(), weight, value: weight > 0 ? weighted / weight : null, sample: weight};
    }
    case 'mean': {
      const values = present(seriesField).map((row) => valueOf(row, seriesField, kind));
      missing += relevant.filter((row) => (kind !== 'timeseries' || row.metric === seriesField)).length - values.length;
      return {...base(), value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, sample: values.length};
    }
    case 'last': {
      const sorted = present(seriesField).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const last = sorted.at(-1);
      return {...base(), value: last ? valueOf(last, seriesField, kind) : null, sample: sorted.length};
    }
    default:
      throw new Error(`unsupported aggregation ${mapping.aggregation}`);
  }
}

export function dailyValues(rows, mapping, kind) {
  const byDate = new Map();
  for (const row of rows) {
    const date = isoDate(row.date);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dayRows]) => ({date, ...aggregate(dayRows, mapping, kind)}))
    .filter((day) => day.value !== null);
}

function meanAndVariance(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  return {mean, variance};
}

const STAT_CAP = 99;

function capped(value) {
  if (!Number.isFinite(value)) return value > 0 ? STAT_CAP : -STAT_CAP;
  return Math.max(-STAT_CAP, Math.min(STAT_CAP, value));
}

// Returns {method, statistic, note}. |statistic| ~ standard errors of the
// observed shift. Methods, in order of preference:
//   welch_daily — Welch t over daily metric values (>= 7 days per period);
//   two_proportion — pooled z for ratio metrics expressed as rates;
//   poisson_rate — z for per-day count rates.
// The fallbacks divide by sqrt(overdispersion) because web traffic is
// over-dispersed; the default factor 2 is conservative, not exact.
export function significance(before, after, mapping, kind, {overdispersion = 2} = {}) {
  const beforeDaily = before.daily ?? [];
  const afterDaily = after.daily ?? [];
  if (beforeDaily.length >= 7 && afterDaily.length >= 7) {
    const left = meanAndVariance(beforeDaily.map((day) => day.value));
    const right = meanAndVariance(afterDaily.map((day) => day.value));
    const standardError = Math.sqrt(left.variance / beforeDaily.length + right.variance / afterDaily.length);
    const difference = right.mean - left.mean;
    const statistic = standardError === 0 ? (difference === 0 ? 0 : Math.sign(difference) * STAT_CAP) : difference / standardError;
    return {method: 'welch_daily', statistic: round(capped(statistic), 3), note: `${beforeDaily.length} vs ${afterDaily.length} daily values`};
  }
  const factor = Math.sqrt(Math.max(1, overdispersion));
  if (mapping.aggregation === 'ratio_of_sums' && before.denominator > 0 && after.denominator > 0 && before.numerator <= before.denominator && after.numerator <= after.denominator) {
    const p1 = before.numerator / before.denominator;
    const p2 = after.numerator / after.denominator;
    const pooled = (before.numerator + after.numerator) / (before.denominator + after.denominator);
    const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / before.denominator + 1 / after.denominator));
    const statistic = standardError === 0 ? 0 : (p2 - p1) / standardError / factor;
    return {method: 'two_proportion', statistic: round(capped(statistic), 3), note: `pooled z divided by sqrt(${overdispersion}) for over-dispersion`};
  }
  if (mapping.aggregation === 'sum' && before.days > 0 && after.days > 0 && before.value !== null && after.value !== null) {
    const beforeRate = before.value / before.days;
    const afterRate = after.value / after.days;
    const standardError = Math.sqrt(before.value / before.days ** 2 + after.value / after.days ** 2);
    const statistic = standardError === 0 ? 0 : (afterRate - beforeRate) / standardError / factor;
    return {method: 'poisson_rate', statistic: round(capped(statistic), 3), note: `per-day rate z divided by sqrt(${overdispersion}) for over-dispersion`};
  }
  return {method: 'none', statistic: null, note: 'no variance estimate available for this aggregation without daily rows'};
}

// Does the change persist across both halves of the after period?
export function persistence(beforeValue, afterRows, mapping, kind) {
  const dates = [...new Set(afterRows.map((row) => isoDate(row.date)).filter(Boolean))].sort();
  if (dates.length < 14 || beforeValue === null) return {checked: false, persistent: null, note: 'needs >= 14 dated days in the after period'};
  const midpoint = dates[Math.floor(dates.length / 2)];
  const firstHalf = aggregate(afterRows.filter((row) => isoDate(row.date) < midpoint), mapping, kind);
  const secondHalf = aggregate(afterRows.filter((row) => isoDate(row.date) >= midpoint), mapping, kind);
  const normalize = (part, days) => (mapping.aggregation === 'sum' ? part.value / days : part.value);
  const firstDays = dates.filter((date) => date < midpoint).length;
  const secondDays = dates.length - firstDays;
  const firstDelta = normalize(firstHalf, firstDays) - beforeValue;
  const secondDelta = normalize(secondHalf, secondDays) - beforeValue;
  const persistent = firstDelta !== 0 && Math.sign(firstDelta) === Math.sign(secondDelta);
  return {checked: true, persistent, first_half_value: round(normalize(firstHalf, firstDays)), second_half_value: round(normalize(secondHalf, secondDays)), note: persistent ? 'both halves move in the same direction' : 'halves disagree in direction'};
}

// Compare a metric between two periods over already-filtered rows.
export function comparePeriods({metric, sourceId, kind, beforeRows, afterRows, before, after, overdispersion}) {
  const mapping = resolveMapping(metric, sourceId);
  const beforeDays = daysInclusive(before.start, before.end);
  const afterDays = daysInclusive(after.start, after.end);
  const beforeAggregate = {...aggregate(beforeRows, mapping, kind), days: beforeDays, daily: dailyValues(beforeRows, mapping, kind)};
  const afterAggregate = {...aggregate(afterRows, mapping, kind), days: afterDays, daily: dailyValues(afterRows, mapping, kind)};
  const perDay = mapping.aggregation === 'sum' && beforeDays !== afterDays;
  const comparableBefore = beforeAggregate.value === null ? null : perDay ? beforeAggregate.value / beforeDays : beforeAggregate.value;
  const comparableAfter = afterAggregate.value === null ? null : perDay ? afterAggregate.value / afterDays : afterAggregate.value;
  const deltaAbs = comparableBefore === null || comparableAfter === null ? null : comparableAfter - comparableBefore;
  const deltaPct = deltaAbs === null || comparableBefore === 0 ? null : (deltaAbs / Math.abs(comparableBefore)) * 100;
  const persistenceBase = mapping.aggregation === 'sum' ? (beforeAggregate.value === null ? null : beforeAggregate.value / beforeDays) : beforeAggregate.value;
  return {
    metric: metric.id,
    unit: metric.unit ?? null,
    aggregation: mapping.aggregation,
    basis: perDay ? 'per_day' : 'total',
    before: {period: before, days: beforeDays, value: round(beforeAggregate.value), comparable_value: round(comparableBefore), sample: round(beforeAggregate.sample, 2), row_count: beforeAggregate.row_count, distinct_dates: beforeAggregate.distinct_dates, numerator: beforeAggregate.numerator, denominator: beforeAggregate.denominator},
    after: {period: after, days: afterDays, value: round(afterAggregate.value), comparable_value: round(comparableAfter), sample: round(afterAggregate.sample, 2), row_count: afterAggregate.row_count, distinct_dates: afterAggregate.distinct_dates, numerator: afterAggregate.numerator, denominator: afterAggregate.denominator},
    delta_abs: round(deltaAbs),
    delta_pct: round(deltaPct, 2),
    significance: significance(beforeAggregate, afterAggregate, mapping, kind, {overdispersion}),
    persistence: persistence(persistenceBase, afterRows, mapping, kind),
  };
}

// Threshold strings as Marketer7 writes them: ">= 1.8", "<= 1.2 percent".
export function parseThreshold(value) {
  const match = String(value ?? '').trim().match(/^(>=|<=|>|<|==|=)\s*(-?\d+(?:\.\d+)?)(?:\s+.*)?$/);
  return match ? {operator: match[1], value: Number(match[2])} : null;
}

export function meetsThreshold(actual, threshold) {
  if (actual === null || actual === undefined || !threshold) return false;
  switch (threshold.operator) {
    case '>': return actual > threshold.value;
    case '>=': return actual >= threshold.value;
    case '<': return actual < threshold.value;
    case '<=': return actual <= threshold.value;
    default: return actual === threshold.value;
  }
}
