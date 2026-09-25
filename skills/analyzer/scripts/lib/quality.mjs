// Data-quality checks. Each check yields issues with a severity:
//   blocking -> data quality `insufficient` (no conclusion may be drawn)
//   major    -> `low`
//   minor    -> `medium`
//   none     -> `high`
// The level is the worst severity present. Issues are always reported, so a
// reader can see *why* a measurement was downgraded.

import {daysInclusive, eachDate, isoDate, parseTimestamp} from './core.mjs';

export const QUALITY_LEVELS = ['high', 'medium', 'low', 'insufficient'];
const SEVERITY_TO_LEVEL = {blocking: 'insufficient', major: 'low', minor: 'medium'};

export function issue(code, severity, message, detail = undefined) {
  return detail === undefined ? {code, severity, message} : {code, severity, message, detail};
}

export function levelFromIssues(issues) {
  let rank = 0;
  for (const {severity} of issues) {
    const level = SEVERITY_TO_LEVEL[severity];
    if (level) rank = Math.max(rank, QUALITY_LEVELS.indexOf(level));
  }
  return QUALITY_LEVELS[rank];
}

export function worstLevel(...levels) {
  return QUALITY_LEVELS[Math.max(...levels.filter(Boolean).map((level) => QUALITY_LEVELS.indexOf(level)))];
}

// Source health is computed, never stored: it derives from fetch timestamps,
// the declared freshness SLA, and the last recorded error.
export function sourceHealth(source, nowMs) {
  if (!source) return {health: 'unconfigured', warning: 'source is not registered'};
  if (source.status === 'disabled') return {health: 'disabled', warning: 'source is disabled'};
  const lastSuccess = parseTimestamp(source.last_success_at);
  const lastError = parseTimestamp(source.last_error_at);
  if (source.status === 'unavailable' || (lastError !== null && (lastSuccess === null || lastError > lastSuccess))) {
    return {health: 'unavailable', warning: `last fetch failed${source.last_error ? `: ${source.last_error}` : ''}`};
  }
  if (lastSuccess === null) return {health: 'unknown', warning: 'no successful fetch recorded'};
  const staleAfterHours = Number(source.freshness?.stale_after_hours ?? 48);
  const through = parseTimestamp(source.data_through);
  // data_through is a date: the data is complete through the end of that day.
  const throughEnd = through === null ? lastSuccess : through + (String(source.data_through).length <= 10 ? 86400000 : 0);
  const ageHours = (nowMs - throughEnd) / 3600000;
  if (ageHours > staleAfterHours) {
    // Humans count staleness in calendar days: data through 09-22, read on 09-25 = 3 days.
    const days = through === null ? Math.floor(ageHours / 24) : Math.round((Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${isoDate(source.data_through)}T00:00:00Z`)) / 86400000);
    return {health: 'stale', age_hours: Math.round(ageHours), age_days: days, warning: `data is stale: last data ${source.data_through ?? source.last_success_at}, ${days} day${days === 1 ? '' : 's'} old (threshold ${staleAfterHours}h)`};
  }
  return {health: 'ok', age_hours: Math.round(ageHours)};
}

export function healthIssues(sourceId, health) {
  switch (health.health) {
    case 'unconfigured': return [issue('source_unconfigured', 'blocking', `${sourceId}: ${health.warning}`)];
    case 'disabled': return [issue('source_disabled', 'blocking', `${sourceId}: ${health.warning}`)];
    case 'unavailable': return [issue('source_unavailable', 'blocking', `${sourceId}: ${health.warning}`)];
    case 'stale': return [issue('source_stale', 'major', `${sourceId}: ${health.warning}`)];
    case 'unknown': return [issue('source_health_unknown', 'minor', `${sourceId}: ${health.warning}`)];
    default: return [];
  }
}

function rowKey(row, dimensions) {
  return JSON.stringify([isoDate(row.date), row.metric ?? null, ...dimensions.map((dimension) => row[dimension] ?? null)]);
}

// Row-level checks for one period. `expectDaily` is true when the snapshot
// was pulled with a date dimension (then every day must be present).
export function checkPeriodRows(rows, {period, label = 'period', expectDaily, dimensions = [], numericFields = [], dataThrough = null}) {
  const issues = [];
  if (rows.length === 0) {
    issues.push(issue('no_rows', 'blocking', `${label}: no rows for ${period.start} → ${period.end}`));
    return issues;
  }
  if (dataThrough && isoDate(dataThrough) < period.end) {
    const missingDays = daysInclusive(isoDate(dataThrough), period.end) - 1;
    const share = missingDays / daysInclusive(period.start, period.end);
    issues.push(issue('incomplete_period', share > 0.5 ? 'blocking' : 'major', `${label}: source data ends ${isoDate(dataThrough)}, ${missingDays} day(s) before the period end ${period.end}`));
  }
  if (expectDaily) {
    const present = new Set(rows.map((row) => isoDate(row.date)).filter(Boolean));
    const expected = eachDate(period.start, period.end);
    const missing = expected.filter((date) => !present.has(date));
    if (missing.length > 0) {
      const share = missing.length / expected.length;
      const severity = share > 0.5 ? 'blocking' : share > 0.1 ? 'major' : 'minor';
      issues.push(issue('missing_dates', severity, `${label}: ${missing.length} of ${expected.length} days missing`, missing.slice(0, 10)));
    }
  }
  const seen = new Map();
  let duplicates = 0;
  for (const row of rows) {
    const key = rowKey(row, dimensions);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 2) duplicates += 1;
  }
  if (duplicates > 0) issues.push(issue('duplicate_rows', 'major', `${label}: ${duplicates} duplicated row key(s) — totals would double-count`));
  const invalid = rows.filter((row) => numericFields.some((field) => row[field] !== undefined && row[field] !== null && (!Number.isFinite(Number(row[field])) || Number(row[field]) < 0)));
  if (invalid.length > 0) issues.push(issue('invalid_values', 'major', `${label}: ${invalid.length} row(s) with negative or non-numeric values`));
  return issues;
}

// Two or more consecutive zero days after a non-trivial daily average usually
// means broken tracking, not a real collapse.
export function checkSuddenZero(daily, {label = 'period', minDailyAverage = 5} = {}) {
  if (daily.length < 4) return [];
  const values = daily.map((day) => day.value ?? 0);
  let run = 0;
  let firstZeroIndex = -1;
  for (const [index, value] of values.entries()) {
    if (value === 0) {
      run += 1;
      if (run === 1) firstZeroIndex = index;
      if (run >= 2) {
        const prior = values.slice(0, firstZeroIndex);
        const average = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
        if (average >= minDailyAverage) {
          return [issue('sudden_zero', 'major', `${label}: values drop to zero from ${daily[firstZeroIndex].date} after a daily average of ${average.toFixed(1)} — possible tracking break`)];
        }
      }
    } else {
      run = 0;
    }
  }
  return [];
}

// A tracking break that starts at the period boundary is invisible to a
// per-period check (the after period has no non-zero days to compare with).
// Judge the after period's zero runs against the before period's volume.
export function checkBoundaryZero(beforeDaily, afterDaily, {minDailyAverage = 5} = {}) {
  if (beforeDaily.length < 3 || afterDaily.length < 2) return [];
  const beforeAverage = beforeDaily.reduce((total, day) => total + (day.value ?? 0), 0) / beforeDaily.length;
  if (beforeAverage < minDailyAverage) return [];
  let run = 0;
  let longest = 0;
  let firstZero = null;
  for (const day of afterDaily) {
    if ((day.value ?? 0) === 0) {
      run += 1;
      if (run === 1 && firstZero === null) firstZero = day.date;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  if (longest < 2) return [];
  const zeroDays = afterDaily.filter((day) => (day.value ?? 0) === 0).length;
  const share = zeroDays / afterDaily.length;
  return [issue('sudden_zero', share >= 0.5 ? 'blocking' : 'major', `after: ${zeroDays} of ${afterDaily.length} days are zero (from ${firstZero}) after a daily average of ${beforeAverage.toFixed(1)} before — likely a tracking break, not a real change`)];
}

export function checkSample(sample, minSample, label = 'period') {
  if (minSample && (sample === null || sample === undefined || sample < minSample)) {
    return [issue('sample_too_small', 'major', `${label}: sample ${sample ?? 0} below the metric minimum ${minSample}`)];
  }
  return [];
}

export function checkTimezone(sourceTimezone, projectTimezone, sourceId) {
  if (sourceTimezone && projectTimezone && sourceTimezone !== projectTimezone) {
    return [issue('timezone_mismatch', 'minor', `${sourceId}: source reports days in ${sourceTimezone}, analysis timezone is ${projectTimezone}; day boundaries differ`)];
  }
  return [];
}

// Before/after snapshots must be comparable: same adapter version, same
// dimensions, same property.
export function checkComparability(beforeSnapshots, afterSnapshots) {
  const issues = [];
  const signature = (snapshot) => JSON.stringify([snapshot.property ?? null, snapshot.adapter_version ?? 1, [...(snapshot.dimensions ?? [])].sort()]);
  const beforeSignatures = new Set(beforeSnapshots.map(signature));
  const afterSignatures = new Set(afterSnapshots.map(signature));
  const same = beforeSignatures.size === afterSignatures.size && [...beforeSignatures].every((value) => afterSignatures.has(value));
  if (!same && beforeSnapshots.length && afterSnapshots.length) {
    issues.push(issue('schema_change', 'major', 'before and after snapshots differ in property, adapter version, or dimensions — not directly comparable'));
  }
  const unique = [...beforeSnapshots, ...afterSnapshots].filter((snapshot, index, all) => all.findIndex((other) => (other.file ?? other) === (snapshot.file ?? snapshot)) === index);
  for (const snapshot of unique) {
    for (const warning of snapshot.warnings ?? []) issues.push(issue('source_warning', 'minor', `${snapshot.file ?? snapshot.source_id}: ${warning}`));
  }
  return issues;
}

export function checkTrackingChanges(changes, period, label = 'period') {
  return changes
    .filter((change) => change.data.type === 'tracking_change')
    .filter((change) => {
      const date = isoDate(change.data.timestamp);
      return date && date >= period.start && date <= period.end;
    })
    .map((change) => issue('tracking_change_in_window', 'major', `${label}: tracking change ${change.data.id} (${change.data.title ?? ''}) on ${isoDate(change.data.timestamp)} — values before and after it may not be comparable`));
}

// Cross-source discrepancy: canonical value vs every other source reporting
// the same metric for the same period.
export function discrepancy(metric, values) {
  const canonical = values.find((entry) => entry.source_id === metric.canonical_source);
  const tolerance = Number(metric.discrepancy_tolerance_pct ?? 5);
  const findings = [];
  if (!canonical || canonical.value === null || canonical.value === undefined) {
    return {canonical: canonical ?? null, tolerance_pct: tolerance, findings, note: canonical ? 'canonical source has no value for the period' : 'canonical source has no data for the period'};
  }
  for (const entry of values) {
    if (entry.source_id === canonical.source_id || entry.value === null || entry.value === undefined) continue;
    const differencePct = canonical.value === 0 ? (entry.value === 0 ? 0 : 100) : ((entry.value - canonical.value) / Math.abs(canonical.value)) * 100;
    if (Math.abs(differencePct) > tolerance) {
      findings.push({source_id: entry.source_id, value: entry.value, canonical_value: canonical.value, difference_pct: Math.round(differencePct * 100) / 100});
    }
  }
  return {canonical, tolerance_pct: tolerance, findings};
}
