// MONITOR: evaluate monitors.json rules against the latest data. An alert
// needs ALL of: relative threshold, absolute threshold, minimum sample, the
// declared direction, and a significance guard (|statistic| >= 2 by default).
// Noise that passes one threshold but not the others is reported as `quiet`,
// not raised. Tracking breaks (data vanishing or dropping to zero) alert on
// their own because they invalidate every other reading.

import {addDays, isoDate, listRecords, round} from './core.mjs';
import {analyzeComparison} from './analysis.mjs';
import {getMetric, getSource, loadMonitors} from './state.mjs';
import {createAnomaly} from './records.mjs';

function windows(through, days) {
  const current = {start: addDays(through, -(days - 1)), end: through};
  const previous = {start: addDays(current.start, -days), end: addDays(current.start, -1)};
  return {current, previous};
}

function changesIn(root, period) {
  return listRecords(root, 'change').filter((change) => {
    const date = isoDate(change.data.timestamp);
    return date && date >= period.start && date <= period.end;
  }).map((change) => change.data.id);
}

export function evaluateMonitor(root, project, monitor, now) {
  const metric = getMetric(root, monitor.metric);
  if (!metric) return {monitor: monitor.id, outcome: 'misconfigured', reason: `metric ${monitor.metric} not in dictionary`};
  const sourceId = monitor.source ?? metric.canonical_source;
  const source = getSource(root, sourceId);
  if (!source) return {monitor: monitor.id, outcome: 'misconfigured', reason: `source ${sourceId} not registered`};
  if (!source.data_through) return {monitor: monitor.id, outcome: 'insufficient_data', reason: `${sourceId} has no ingested data`};
  const days = Number(monitor.window_days ?? 7);
  const {current, previous} = windows(isoDate(source.data_through), days);
  const analysis = analyzeComparison(root, project, {metricId: metric.id, sourceId, before: previous, after: current, scope: monitor.scope ?? {}, design: 'observational', now, analysisKind: 'monitor'});
  const comparison = analysis.comparison;
  const previousValue = comparison?.before?.value ?? null;
  const currentValue = comparison?.after?.value ?? null;
  const minSample = Number(monitor.min_sample ?? metric.min_sample ?? 0);
  const base = {monitor: monitor.id, metric: metric.id, source_id: sourceId, current, previous, previous_value: previousValue, current_value: currentValue, data_quality: analysis.data_quality.level, seasonality_note: days % 7 === 0 ? 'weekday-aligned windows' : `window of ${days} days is not weekday-aligned; weekday mix differs`};
  const issues = analysis.data_quality.issues;
  const sourceDown = issues.some((entry) => ['source_unavailable', 'source_unconfigured', 'source_disabled'].includes(entry.code));
  const hadVolume = (comparison?.before?.sample ?? 0) >= minSample && previousValue !== null && previousValue > 0;
  const suddenZero = issues.some((entry) => entry.code === 'sudden_zero' && entry.message.startsWith('after'));
  const vanished = !sourceDown && hadVolume && (currentValue === null || currentValue === 0 || suddenZero);
  if (vanished) {
    return {...base, outcome: 'alert', kind: 'tracking_break', severity: 'high', reason: `data for ${metric.id} vanished or dropped to zero in ${current.start} → ${current.end} after ${previousValue} in the prior window — likely a tracking or pipeline break, not a real change`, analysis};
  }
  if (analysis.data_quality.level === 'insufficient' || previousValue === null || currentValue === null) {
    return {...base, outcome: 'insufficient_data', reason: issues.filter((entry) => entry.severity === 'blocking').map((entry) => entry.message).join('; ') || 'no comparable values'};
  }
  const deltaPct = comparison.delta_pct;
  const deltaAbs = comparison.delta_abs;
  const relative = Number(monitor.relative_threshold_pct ?? 25);
  const absolute = Number(monitor.absolute_threshold ?? 0);
  const minSignificance = Number(monitor.min_significance ?? 2);
  const direction = monitor.direction ?? 'both';
  const checks = {
    relative: deltaPct !== null && Math.abs(deltaPct) >= relative,
    absolute: Math.abs(deltaAbs) >= absolute,
    sample: Math.max(comparison.before.sample ?? 0, comparison.after.sample ?? 0) >= minSample,
    direction: direction === 'both' || (direction === 'decrease' ? deltaAbs < 0 : deltaAbs > 0),
    significance: comparison.significance.statistic === null || Math.abs(comparison.significance.statistic) >= minSignificance,
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const summary = `${metric.id} ${previousValue} → ${currentValue} (${deltaPct > 0 ? '+' : ''}${deltaPct}%)`;
  if (failed.length) return {...base, outcome: 'quiet', delta_pct: deltaPct, delta_abs: round(deltaAbs), reason: `${summary}; not alerted: ${failed.join(', ')} guard not met`, checks};
  return {...base, outcome: 'alert', kind: 'threshold_breach', severity: monitor.severity ?? 'medium', delta_pct: deltaPct, delta_abs: round(deltaAbs), reason: `${summary} over ${days}-day windows; every guard met`, checks, analysis};
}

export function runMonitors(root, project, now, {record = false} = {}) {
  const {monitors} = loadMonitors(root);
  const results = [];
  for (const monitor of monitors) {
    if (monitor.enabled === false) continue;
    const result = evaluateMonitor(root, project, monitor, now);
    if (record && result.outcome === 'alert') {
      const candidates = changesIn(root, {start: result.previous.start, end: result.current.end});
      const body = [
        '## Observation',
        '',
        result.reason,
        '',
        `- Current window: ${result.current.start} → ${result.current.end}; previous window: ${result.previous.start} → ${result.previous.end} (${result.seasonality_note})`,
        `- Source: ${result.source_id}; data quality: ${result.data_quality.toUpperCase()}`,
        '',
        '## Rule',
        '',
        `Monitor \`${result.monitor}\`: ${JSON.stringify(monitors.find((entry) => entry.id === result.monitor))}`,
        '',
        '## Candidate explanations (not conclusions)',
        '',
        ...(candidates.length ? candidates.map((id) => `- ${id} registered in or just before the window`) : ['- No registered change in these windows. Unregistered changes cannot be excluded.']),
        ...(result.kind === 'tracking_break' ? ['- A tracking, consent, or export failure is the most common cause of vanished data; verify the source before interpreting.'] : []),
        '',
        '## Data quality issues',
        '',
        ...(result.analysis.data_quality.issues.length ? result.analysis.data_quality.issues.map((entry) => `- [${entry.severity}] \`${entry.code}\` — ${entry.message}`) : ['- None detected.']),
        '',
        '## Provenance',
        '',
        ...result.analysis.provenance.map((entry) => `- \`${entry.file}\` retrieved ${entry.retrieved_at}, rows sha256 \`${entry.rows_sha256}\``),
        '',
      ].join('\n');
      result.anomaly = createAnomaly(root, {
        title: `${result.kind === 'tracking_break' ? 'Tracking break' : 'Threshold breach'}: ${result.metric}`,
        kind: result.kind,
        dedupe_key: `monitor:${result.monitor}`,
        monitor_id: result.monitor,
        metric: result.metric,
        source_id: result.source_id,
        severity: result.severity,
        period_current_start: result.current.start,
        period_current_end: result.current.end,
        period_previous_start: result.previous.start,
        period_previous_end: result.previous.end,
        previous_value: result.previous_value,
        current_value: result.current_value,
        delta_pct: result.delta_pct ?? null,
        data_quality: result.data_quality,
        change_ids: candidates,
      }, body, now);
    }
    delete result.analysis;
    results.push(result);
  }
  return results;
}
