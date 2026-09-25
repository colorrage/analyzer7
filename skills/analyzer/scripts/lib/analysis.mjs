// The shared measurement pipeline: observations → data quality → comparison →
// evidence strength → confounders → causal confidence. Used by ad-hoc period
// comparisons, experiment evaluation, and baselines, so every path applies the
// same rules.

import {UsageError, createRecord, daysInclusive, isoDate, listRecords, normalizePage, nowIso, parseTimestamp, round} from './core.mjs';
import {differenceInDifferences, lastYear, scopedRows, selectControlPages} from './control.mjs';
import {ADAPTERS} from './adapters.mjs';
import {causalConfidence, classifyChanges, confounders, evidenceStrength} from './confidence.mjs';
import {checkBoundaryZero, checkComparability, checkPeriodRows, checkSample, checkSuddenZero, checkTimezone, checkTrackingChanges, discrepancy, healthIssues, issue, levelFromIssues, sourceHealth} from './quality.mjs';
import {getMetric, getSource, loadProject, loadSeoConfig, selectRows} from './state.mjs';
import {aggregate, comparePeriods, dailyValues, filterRows, meetsThreshold, parseThreshold, resolveMapping} from './stats.mjs';
import {totals} from './seo.mjs';

const NUMERIC_FIELDS = {gsc_rows: ['clicks', 'impressions', 'position'], timeseries: ['value']};

export function resolveMetric(root, metricId) {
  const metric = getMetric(root, metricId);
  if (!metric) throw new UsageError(`metric ${metricId} is not in metrics.json — Analyzer7 does not define metrics on the fly; add it to the dictionary first`);
  return metric;
}

function kindForSource(source) {
  return source && ADAPTERS[source.adapter] ? ADAPTERS[source.adapter].kind : null;
}

// Gather, scope, and quality-check one period for one source.
export function measurePeriod(root, {metric, sourceId, period, scope, label, project, now, changes}) {
  const source = getSource(root, sourceId);
  const nowMs = parseTimestamp(now);
  const health = sourceHealth(source, nowMs);
  const issues = [...healthIssues(sourceId, health)];
  const kind = kindForSource(source);
  if (!source || !kind) {
    if (source && !kind) issues.push(issue('adapter_unknown', 'blocking', `${sourceId}: adapter ${source.adapter} is not a known Analyzer7 adapter`));
    return {source_id: sourceId, health, issues, rows: [], snapshots: [], value: null, kind};
  }
  // Scoped reads need the scope dimension; property-level reads prefer a
  // headline-safe grain (no query/page) and fall back only when none exists.
  const required = ['page', 'query', 'country', 'device', 'segment'].filter((dimension) => scope?.[dimension] !== undefined);
  let selection = selectRows(root, {sourceId, kind, period, require: required, exclude: kind === 'gsc_rows' && required.length === 0 ? ['query', 'page'] : []});
  if (selection.rows.length === 0 && kind === 'gsc_rows' && required.length === 0) selection = selectRows(root, {sourceId, kind, period});
  const rows = filterRows(selection.rows, {start: period.start, end: period.end, scope});
  const mapping = resolveMapping(metric, sourceId);
  let volumeDaily = [];
  if (selection.note && rows.length === 0) issues.push(issue('no_covering_snapshot', 'blocking', `${label}: ${selection.note}`));
  else issues.push(...checkPeriodRows(rows, {period, label, expectDaily: selection.expectDaily, dimensions: selection.dimensions.filter((dimension) => dimension !== 'date'), numericFields: NUMERIC_FIELDS[kind] ?? [], dataThrough: source.data_through}));
  const aggregateResult = rows.length ? aggregate(rows, mapping, kind) : {value: null, sample: 0, row_count: 0, missing_values: 0};
  if (rows.length && aggregateResult.row_count === 0) {
    issues.push(issue('metric_absent', 'blocking', `${label}: ${sourceId} has rows for the period but none for ${metric.id} (${kind === 'timeseries' ? `series ${[mapping.series ?? mapping.field, mapping.numerator, mapping.denominator].filter((name) => name && name !== 'value').join('/') || metric.id}` : 'fields missing'})`));
  } else if (aggregateResult.value === null && rows.length) {
    issues.push(issue('metric_absent', 'blocking', `${label}: no usable ${metric.id} value (every relevant cell is missing or the denominator is zero)`));
  }
  if (aggregateResult.missing_values > 0) {
    const share = aggregateResult.missing_values / Math.max(1, aggregateResult.row_count);
    issues.push(issue('missing_values', share > 0.1 ? 'major' : 'minor', `${label}: ${aggregateResult.missing_values} missing or non-numeric value(s) skipped, not counted as zero`));
  }
  if (rows.length) {
    const volumeMapping = mapping.aggregation === 'ratio_of_sums' ? {...mapping, aggregation: 'sum', field: mapping.denominator, series: mapping.denominator} : mapping;
    if (['sum', 'ratio_of_sums'].includes(mapping.aggregation)) {
      volumeDaily = dailyValues(rows, volumeMapping, kind);
      issues.push(...checkSuddenZero(volumeDaily, {label}));
    }
    issues.push(...checkSample(aggregateResult.sample, metric.min_sample, `${label} (${sourceId})`));
  }
  if (kind === 'gsc_rows' && rows.length) {
    const dimensions = selection.dimensions;
    const scoped = scope && (scope.page || scope.query);
    if (!scoped && (dimensions.includes('query') || dimensions.includes('page'))) issues.push(issue('headline_unsafe', 'major', `${label}: property-level ${metric.id} derived from ${dimensions.join('×')} rows double-counts pages and omits anonymized queries; pull an aggregate (date-only) export`));
    else if (dimensions.includes('query') && !scope?.query) issues.push(issue('anonymized_queries_excluded', 'minor', `${label}: query-level rows omit anonymized queries; totals undercount`));
  }
  issues.push(...checkTimezone(source.timezone, project.timezone, sourceId));
  issues.push(...checkTrackingChanges(changes, period, label));
  return {source_id: sourceId, health, issues, rows, snapshots: selection.snapshots, value: aggregateResult.value, sample: aggregateResult.sample, kind, mapping, volumeDaily};
}

function scopePages(scope) {
  if (!scope?.page) return [];
  return Array.isArray(scope.page) ? scope.page : [scope.page];
}

export function analyzeComparison(root, project, {metricId, sourceId = null, before, after, scope = {}, linkedChangeIds: requestedLinks = [], experimentId = null, design = 'before_after', now, contextRefs = [], analysisKind = 'comparison', extraIssues = [], baselineCheck = null, control = 'auto', seasonality = true}) {
  const metric = resolveMetric(root, metricId);
  const projectData = loadProject(root);
  const canonical = metric.canonical_source;
  const primarySource = sourceId ?? canonical;
  if (!primarySource) throw new UsageError(`metric ${metric.id} has no canonical_source; set one in metrics.json`);
  const changes = listRecords(root, 'change');
  let linkedChangeIds = requestedLinks;
  const unknownLinks = linkedChangeIds.filter((id) => !changes.some((change) => change.data.id === id));
  if (unknownLinks.length) throw new UsageError(`unknown change id(s): ${unknownLinks.join(', ')} — register the change first`);
  // A linked change that was later superseded (e.g. marked deployed) is
  // followed to its current record.
  const successor = (id) => {
    let current = id;
    for (let guard = 0; guard < 100; guard += 1) {
      const next = changes.find((change) => change.data.supersedes === current);
      if (!next) return current;
      current = next.data.id;
    }
    return current;
  };
  linkedChangeIds = [...new Set(linkedChangeIds.map(successor))];
  const issues = [];
  if (metric.status === 'proposed') issues.push(issue('metric_unconfirmed', 'blocking', `metric ${metric.id} is proposed, not confirmed; a human must set status: active before it can support evidence`));
  if (primarySource !== canonical) issues.push(issue('non_canonical_source', 'minor', `${primarySource} is not the canonical source for ${metric.id} (canonical: ${canonical})`));
  const beforeMeasure = measurePeriod(root, {metric, sourceId: primarySource, period: before, scope, label: 'before', project: projectData, now, changes});
  const afterMeasure = measurePeriod(root, {metric, sourceId: primarySource, period: after, scope, label: 'after', project: projectData, now, changes});
  const dedupe = new Set();
  for (const entry of [...beforeMeasure.issues, ...afterMeasure.issues]) {
    const key = entry.code === 'timezone_mismatch' || entry.code.startsWith('source_') ? entry.code : `${entry.code}:${entry.message}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    issues.push(entry);
  }
  issues.push(...checkComparability(beforeMeasure.snapshots, afterMeasure.snapshots));
  const boundary = checkBoundaryZero(beforeMeasure.volumeDaily ?? [], afterMeasure.volumeDaily ?? []);
  if (boundary.length) {
    for (let index = issues.length - 1; index >= 0; index -= 1) if (issues[index].code === 'sudden_zero' && issues[index].message.startsWith('after')) issues.splice(index, 1);
    issues.push(...boundary);
  }
  issues.push(...extraIssues);
  // A recorded baseline that no longer matches the source means the source
  // restated history (GSC does this for recent days) or the scope drifted.
  if (baselineCheck && baselineCheck.value !== null && beforeMeasure.value !== null) {
    const drift = baselineCheck.value === 0 ? (beforeMeasure.value === 0 ? 0 : 100) : Math.abs((beforeMeasure.value - baselineCheck.value) / baselineCheck.value) * 100;
    if (drift > 1) issues.push(issue('baseline_restated', drift > 10 ? 'major' : 'minor', `baseline ${baselineCheck.id} recorded ${round(baselineCheck.value)}; the same period now reads ${round(beforeMeasure.value)} (${round(drift, 1)}% drift)`));
  }

  // Cross-source agreement for the same metric and periods.
  const discrepancies = [];
  for (const fallback of metric.fallback_sources ?? []) {
    if (!getSource(root, fallback)) continue;
    for (const [label, period, measure] of [['before', before, beforeMeasure], ['after', after, afterMeasure]]) {
      const other = measurePeriod(root, {metric, sourceId: fallback, period, scope, label, project: projectData, now, changes});
      if (other.value === null) continue;
      const result = discrepancy(metric, [{source_id: primarySource, value: measure.value}, {source_id: fallback, value: other.value}].map((entry) => ({...entry, source_id: entry.source_id === primarySource ? canonical : entry.source_id})));
      if (result.findings.length) {
        discrepancies.push({period: label, canonical_source: primarySource, canonical_value: round(measure.value), other_source: fallback, other_value: round(other.value), difference_pct: result.findings[0].difference_pct, tolerance_pct: result.tolerance_pct});
        issues.push(issue('source_discrepancy', 'major', `${label}: ${fallback} reports ${round(other.value)} vs canonical ${primarySource} ${round(measure.value)} for ${metric.id} (${result.findings[0].difference_pct}%, tolerance ${result.tolerance_pct}%)`));
      }
    }
  }

  const dataQuality = levelFromIssues(issues);
  const kind = afterMeasure.kind ?? beforeMeasure.kind;
  const comparison = kind && (beforeMeasure.rows.length || afterMeasure.rows.length)
    ? comparePeriods({metric, sourceId: primarySource, kind, beforeRows: beforeMeasure.rows, afterRows: afterMeasure.rows, before, after, overdispersion: metric.overdispersion ?? 2})
    : null;
  if (comparison && dataQuality === 'insufficient') {
    // Keep whatever was observed, but never present a delta from insufficient data.
    comparison.delta_abs = null;
    comparison.delta_pct = null;
  }
  // Control group (difference-in-differences) for page-scoped measurements.
  const controlResult = kind && comparison ? measureControl(root, {control, scope, metric, sourceId: primarySource, kind, before, after, changes, projectData, now, beforeMeasure, afterMeasure}) : null;
  if (controlResult && !controlResult.usable && controlResult.requested) issues.push(issue('control_unusable', 'info', `control group not used: ${controlResult.reason}; the analysis is a plain before/after comparison`));
  const controlled = Boolean(controlResult?.usable);
  const effectiveDesign = controlled ? 'difference_in_differences' : design;
  const strengthInput = controlled ? {...comparison, significance: {method: controlResult.method, statistic: controlResult.statistic, note: 'difference-in-differences on daily series'}} : comparison;
  const strength = evidenceStrength({dataQuality, comparison: strengthInput, minSample: metric.min_sample});

  // SEO context for CTR-like metrics: position and demand shifts in scope,
  // net of the control group when one is used.
  const seoContext = {};
  if (kind === 'gsc_rows' && beforeMeasure.rows.length && afterMeasure.rows.length) {
    const beforeTotals = totals(beforeMeasure.rows);
    const afterTotals = totals(afterMeasure.rows);
    const controlTotals = controlled ? {before: totals(controlResult.rows.before), after: totals(controlResult.rows.after)} : null;
    if (metric.id !== 'avg_position' && beforeTotals.avg_position !== null && afterTotals.avg_position !== null) {
      const treatedShift = afterTotals.avg_position - beforeTotals.avg_position;
      const controlShift = controlTotals && controlTotals.before.avg_position !== null && controlTotals.after.avg_position !== null ? controlTotals.after.avg_position - controlTotals.before.avg_position : null;
      seoContext.positionShift = controlShift === null ? treatedShift : treatedShift - controlShift;
      seoContext.positionFrom = beforeTotals.avg_position;
      seoContext.positionTo = afterTotals.avg_position;
      seoContext.positionNet = controlShift !== null;
    }
    if (!['organic_impressions'].includes(metric.id) && beforeTotals.impressions > 0) {
      const rate = (value, period) => value / daysInclusive(period.start, period.end);
      const treatedDemand = rate(afterTotals.impressions, after) / rate(beforeTotals.impressions, before);
      const controlDemand = controlTotals && controlTotals.before.impressions > 0 ? rate(controlTotals.after.impressions, after) / rate(controlTotals.before.impressions, before) : null;
      seoContext.demandShiftPct = ((controlDemand ? treatedDemand / controlDemand : treatedDemand) - 1) * 100;
      seoContext.demandNet = Boolean(controlDemand);
    }
    seoContext.before = beforeTotals;
    seoContext.after = afterTotals;
  }
  const seasonal = seasonality && comparison ? seasonalCheck(root, {metric, sourceId: primarySource, kind, before, after, scope, observedPct: comparison.delta_pct}) : {checked: false, reason: 'not requested'};
  const classified = classifyChanges(changes, {before, after, scopePages: scopePages(scope), linkedIds: linkedChangeIds, experimentId});
  const confounderList = confounders({classified, before, after, context: {...seoContext, externalContext: contextRefs, controlled, seasonal, parallelTrends: controlled ? controlResult.pre_trend : null}});
  const designCeiling = controlled ? (controlResult.pre_trend.passed && Math.abs(controlResult.statistic ?? 0) >= 3 ? 'high' : 'medium') : null;
  const causal = causalConfidence({design: effectiveDesign, designCeiling, classified, confounderList, evidence: strength.level, before, after});

  return {
    analysis_kind: analysisKind,
    generated_at: now,
    metric: {id: metric.id, version: metric.version ?? 1, unit: metric.unit ?? null, label: metric.label ?? metric.id, evidence_grade: metric.evidence_grade ?? null, direction: metric.direction ?? null},
    source_id: primarySource,
    canonical_source: canonical,
    scope,
    before,
    after,
    comparison,
    data_quality: {level: dataQuality, issues},
    evidence_strength: strength,
    causal_confidence: causal,
    confounders: confounderList,
    changes: {linked: classified.linked.map((change) => change.data.id), overlapping: classified.overlapping.map((change) => change.data.id), unplaced: classified.unplaced.map((change) => change.data.id)},
    linked_change_details: classified.linked.map((change) => ({id: change.data.id, title: change.data.title, timestamp: change.data.timestamp, origin: change.data.origin, origin_ref: change.data.origin_ref ?? null})),
    discrepancies,
    seo_context: seoContext.before ? {before: seoContext.before, after: seoContext.after} : null,
    provenance: [...beforeMeasure.snapshots, ...afterMeasure.snapshots].filter((snapshot, index, all) => all.findIndex((other) => other.file === snapshot.file) === index).map((snapshot) => ({file: snapshot.file, source_id: snapshot.source_id, adapter: snapshot.adapter, property: snapshot.property, period: snapshot.period, retrieved_at: snapshot.retrieved_at, rows_sha256: snapshot.rows_sha256, input_sha256: snapshot.input?.sha256 ?? null})),
    source_health: {[primarySource]: afterMeasure.health},
    design: effectiveDesign,
    control: controlResult ? (({rows, ...rest}) => rest)(controlResult) : null,
    seasonality: seasonal,
  };
}

// Resolve and measure the control group. `control` is 'auto', 'none', or an
// explicit page list; only page-scoped GSC measurements can have one.
function measureControl(root, {control, scope, metric, sourceId, kind, before, after, changes, projectData, now, beforeMeasure, afterMeasure}) {
  const treatedPages = scopePages(scope);
  if (control === 'none' || control === null || control === false) return null;
  const requested = Array.isArray(control);
  if (!treatedPages.length || kind !== 'gsc_rows') return requested ? {usable: false, requested, reason: 'a control group needs a page-scoped Search Console measurement'} : null;
  const selection = requested ? {pages: control.map(normalizePage), markets: null, excluded_changed: null, unknown_scope_changes: null} : selectControlPages(root, {sourceId, before, after, treatedPages, changes, segments: loadSeoConfig(root).segments ?? []});
  const base = {requested: true, selection: requested ? 'explicit' : 'auto', pages: selection.pages.length, page_list: selection.pages.slice(0, 50), markets: selection.markets, excluded_changed_pages: selection.excluded_changed, unknown_scope_changes: selection.unknown_scope_changes};
  if (selection.pages.length < 3) return {...base, usable: false, reason: `only ${selection.pages.length} untouched page(s) with data in both windows in the same market(s); at least 3 are needed`};
  const controlScope = {...scope, page: selection.pages};
  const controlBefore = measurePeriod(root, {metric, sourceId, period: before, scope: controlScope, label: 'control before', project: projectData, now, changes});
  const controlAfter = measurePeriod(root, {metric, sourceId, period: after, scope: controlScope, label: 'control after', project: projectData, now, changes});
  if (controlBefore.value === null || controlAfter.value === null || levelFromIssues([...controlBefore.issues, ...controlAfter.issues].filter((entry) => entry.code !== 'timezone_mismatch')) === 'insufficient') {
    return {...base, usable: false, reason: 'the control pages have insufficient data in a window'};
  }
  const did = differenceInDifferences({mapping: beforeMeasure.mapping, kind, treatedBeforeRows: beforeMeasure.rows, treatedAfterRows: afterMeasure.rows, controlBeforeRows: controlBefore.rows, controlAfterRows: controlAfter.rows});
  if (!did.usable) return {...base, usable: false, reason: did.reason};
  const controlChangePct = controlBefore.value ? round(((controlAfter.value / daysFactor(beforeMeasure.mapping, after)) / (controlBefore.value / daysFactor(beforeMeasure.mapping, before)) - 1) * 100, 2) : null;
  return {...base, ...did, control_before: round(controlBefore.value), control_after: round(controlAfter.value), control_change_pct: controlChangePct, rows: {before: controlBefore.rows, after: controlAfter.rows}};
}

function daysFactor(mapping, period) {
  return mapping.aggregation === 'sum' ? daysInclusive(period.start, period.end) : 1;
}

// Year-over-year: did the same scope move the same way over the same windows
// 52 weeks earlier (weekday-aligned)? Uses only data already ingested.
function seasonalCheck(root, {metric, sourceId, kind, before, after, scope, observedPct}) {
  const previousBefore = lastYear(before);
  const previousAfter = lastYear(after);
  const beforeRows = scopedRows(root, {sourceId, kind, period: previousBefore, scope});
  const afterRows = scopedRows(root, {sourceId, kind, period: previousAfter, scope});
  const coverage = (rows, period) => new Set(rows.map((row) => isoDate(row.date)).filter(Boolean)).size / daysInclusive(period.start, period.end);
  if (!beforeRows.length || !afterRows.length || coverage(beforeRows, previousBefore) < 0.5 || coverage(afterRows, previousAfter) < 0.5) {
    return {checked: false, reason: 'no data for the same windows 52 weeks earlier', periods: {before: previousBefore, after: previousAfter}};
  }
  const result = comparePeriods({metric, sourceId, kind, beforeRows, afterRows, before: previousBefore, after: previousAfter});
  return {checked: true, periods: {before: previousBefore, after: previousAfter}, last_year_before: result.before.comparable_value, last_year_after: result.after.comparable_value, last_year_change_pct: result.delta_pct, observed_change_pct: observedPct};
}

// ---------- rendering ----------

function fmt(value, unit) {
  if (value === null || value === undefined) return 'unknown';
  const text = Number.isInteger(value) ? String(value) : String(round(value, 3));
  return unit === 'percent' ? `${text}%` : unit ? `${text} ${unit}` : text;
}

function upper(level) {
  return String(level ?? 'unknown').toUpperCase();
}

export function interpretation(analysis, {subject = null} = {}) {
  const {comparison, data_quality: quality, causal_confidence: causal, changes} = analysis;
  if (quality.level === 'insufficient' || !comparison || comparison.before.value === null || comparison.after.value === null) {
    return 'INSUFFICIENT DATA — no conclusion is drawn. See data quality issues for what is missing.';
  }
  const metric = analysis.metric.id;
  const direction = comparison.delta_abs > 0 ? 'increased' : comparison.delta_abs < 0 ? 'decreased' : 'did not change';
  const linked = changes.linked.length ? changes.linked.join(', ') : null;
  const moved = `${metric} ${direction} (${fmt(comparison.before.comparable_value, analysis.metric.unit)} → ${fmt(comparison.after.comparable_value, analysis.metric.unit)}${comparison.basis === 'per_day' ? ' per day' : ''})`;
  if (!linked) return `${moved}. No registered change is linked, so this is an observation, not an attribution.`;
  const others = analysis.confounders.filter((entry) => entry.severity === 'major').map((entry) => entry.ref ?? entry.code);
  const timing = `${moved} after ${subject ?? linked}.`;
  if (causal.level === 'none') return `${timing} Causal attribution is not supported: ${causal.reasons.join('; ')}.`;
  const caveat = others.length ? ` but concurrent factors (${others.join(', ')}) reduce causal confidence` : analysis.confounders.length ? ' but the listed minor confounders remain unexcluded' : '';
  if (analysis.control?.usable) {
    const net = analysis.control.effect;
    return `${timing} Relative to ${analysis.control.pages} untouched control page(s) in the same market(s), the net change is ${net > 0 ? '+' : ''}${net} ${analysis.control.mode === 'index' ? '% of the before level' : `${analysis.metric.unit ?? ''} (level)`}${analysis.control.pre_trend.passed ? '' : ', but the groups were already diverging before the change'}${caveat}. Causal confidence: ${upper(causal.level)} (difference-in-differences removes shared shocks such as seasonality and demand, but not page-specific causes).`;
  }
  return `${timing} The timing is consistent with the hypothesis${caveat}. Causal confidence: ${upper(causal.level)} (a ${(analysis.design ?? 'before_after').replace('before_after', 'before/after').replace(/_/g, ' ')} comparison cannot exclude unobserved causes).`;
}

export function renderEvidenceBody(analysis, {title, observation, experiment = null, threshold = null, contextRefs = []}) {
  const {comparison, metric} = analysis;
  const unit = metric.unit;
  const lines = [`# ${analysis.id ?? 'EV'} — ${title}`, '', '## Observation', '', observation, ''];
  lines.push('## Measurement', '', '| | Period | Value | Sample | Rows |', '| --- | --- | --- | --- | --- |');
  for (const label of ['before', 'after']) {
    const part = comparison?.[label];
    const period = analysis[label];
    lines.push(`| ${label === 'before' ? 'Before' : 'After'} | ${period.start} → ${period.end} | ${fmt(part?.value ?? null, unit)}${comparison?.basis === 'per_day' ? ` (${fmt(part?.comparable_value ?? null, unit)}/day)` : ''} | ${part?.sample ?? 'unknown'} | ${part?.row_count ?? 0} |`);
  }
  lines.push('', `- Metric: \`${metric.id}\` (dictionary version ${metric.version}), unit ${unit ?? 'n/a'}`, `- Source: \`${analysis.source_id}\`${analysis.source_id === analysis.canonical_source ? ' (canonical)' : ` (canonical is ${analysis.canonical_source})`}`, `- Delta: ${fmt(comparison?.delta_abs ?? null, unit)} (${comparison?.delta_pct === null || comparison?.delta_pct === undefined ? 'unknown' : `${comparison.delta_pct > 0 ? '+' : ''}${comparison.delta_pct}%`}) on a ${comparison?.basis ?? 'n/a'} basis`, `- Significance: ${comparison?.significance?.method ?? 'none'}${comparison?.significance?.statistic !== null && comparison?.significance?.statistic !== undefined ? `, statistic ${comparison.significance.statistic}` : ''}`, `- Persistence: ${comparison?.persistence?.note ?? 'not checked'}`);
  if (Object.keys(analysis.scope ?? {}).length) lines.push(`- Scope: ${Object.entries(analysis.scope).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : value}`).join(', ')}`);
  if (analysis.seo_context) lines.push(`- SEO context (same scope): impressions ${analysis.seo_context.before.impressions} → ${analysis.seo_context.after.impressions}, avg position ${analysis.seo_context.before.avg_position} → ${analysis.seo_context.after.avg_position}`);
  lines.push('');
  if (experiment) {
    lines.push('## Experiment threshold check', '', `- Experiment: ${experiment.id} (Marketer7, ${experiment.path}), status at measurement: ${experiment.status}`, `- Definition fingerprint measured: \`${experiment.fingerprint}\`${experiment.definition_matches_review === false ? ' — DOES NOT match the review-time lock' : experiment.definition_matches_review ? ' (matches the review-time lock)' : ''}`, `- Primary metric: ${experiment.definition.primary_metric}; success ${experiment.definition.success_threshold}; failure ${experiment.definition.failure_threshold}`, `- Observed primary value: ${fmt(threshold?.observed ?? null, unit)}`, `- Criteria basis: ${experiment.criteria ? `${experiment.criteria.basis} — ${experiment.criteria.detail}` : 'unknown'}`, `- Threshold result: **${threshold?.result ?? 'insufficient_data'}**${experiment.criteria && !experiment.criteria.authorized ? ' (withheld: the thresholds in force are not the locked ones)' : ''}`, '', 'Analyzer7 reports the threshold comparison only. The experiment verdict and the next decision (continue, stop, iterate, scale) belong to Marketer7.', '');
  }
  if (analysis.control) {
    const control = analysis.control;
    lines.push('## Control group', '');
    if (control.usable) {
      lines.push(`- Design: difference-in-differences against ${control.pages} untouched page(s) (${control.selection}${control.markets ? `, markets ${control.markets.join(', ')}` : ''}); pages touched by a registered change in the windows were excluded (${control.excluded_changed_pages ?? 'n/a'})${control.unknown_scope_changes ? `; ${control.unknown_scope_changes} change(s) of unknown scope could not be excluded` : ''}.`,
        `- Control: ${fmt(control.control_before, unit)} → ${fmt(control.control_after, unit)} (${control.control_change_pct === null ? 'unknown' : `${control.control_change_pct > 0 ? '+' : ''}${control.control_change_pct}%`} on a comparable basis).`,
        `- Net effect: ${control.effect > 0 ? '+' : ''}${control.effect} (${control.effect_unit}); statistic ${control.statistic} (${control.method}, ${control.matched_days.before} vs ${control.matched_days.after} matched days).`,
        `- Parallel pre-trends: ${control.pre_trend.passed ? 'hold' : 'VIOLATED'} (statistic ${control.pre_trend.statistic}).`,
        `- Control pages (first ${Math.min(control.page_list.length, 10)}): ${control.page_list.slice(0, 10).map((page) => `\`${page}\``).join(', ')}`);
    } else {
      lines.push(`- Not used: ${control.reason}. The analysis is a plain before/after comparison.`);
    }
    lines.push('');
  }
  lines.push(`## Data quality: ${upper(analysis.data_quality.level)}`, '');
  if (analysis.data_quality.issues.length === 0) lines.push('- No issues detected by the automated checks.');
  for (const entry of analysis.data_quality.issues) lines.push(`- [${entry.severity}] \`${entry.code}\` — ${entry.message}`);
  lines.push('', `## Evidence strength: ${upper(analysis.evidence_strength.level)}`, '', ...analysis.evidence_strength.reasons.map((reason) => `- ${reason}`), '');
  lines.push(`## Causal confidence: ${upper(analysis.causal_confidence.level)}`, '', ...analysis.causal_confidence.reasons.map((reason) => `- ${reason}`), '');
  lines.push('## Confounders', '');
  if (analysis.confounders.length === 0) lines.push('- None detected in the change registry or the observed data. Unregistered changes cannot be excluded.');
  for (const entry of analysis.confounders) lines.push(`- [${entry.severity}] ${entry.message}`);
  if (analysis.confounders.some((entry) => entry.severity === 'info')) lines.push('', '`info` entries are listed for transparency and do not lower causal confidence.');
  lines.push('', '## Possible explanations', '');
  const explanations = [];
  for (const change of analysis.linked_change_details) explanations.push(`${change.id} — ${change.title} (${change.origin}, ${change.timestamp}) — the linked change under test.`);
  const aboutLinked = new Set(['unconfirmed_change', 'linked_change_mid_window', 'linked_change_in_baseline']);
  for (const entry of analysis.confounders) if (!aboutLinked.has(entry.code)) explanations.push(entry.message);
  explanations.push('Unregistered changes, algorithm updates, or seasonality not visible to Analyzer7.');
  lines.push(...explanations.map((text) => `- ${text}`), '');
  const seasonalLine = analysis.control?.usable
    ? '- Seasonality: shared seasonality is absorbed by the control group.'
    : analysis.seasonality?.checked
      ? `- Seasonality: the same windows 52 weeks earlier moved ${analysis.seasonality.last_year_change_pct > 0 ? '+' : ''}${analysis.seasonality.last_year_change_pct}% (see confounders).`
      : `- Seasonality is not controlled (${analysis.seasonality?.reason ?? 'no year-over-year data'}).`;
  lines.push('## Uncertainty', '', `- Design: ${analysis.design ?? 'before_after'}${analysis.control?.usable ? '' : '; no control group'}.`, seasonalLine);
  if (analysis.discrepancies.length) for (const entry of analysis.discrepancies) lines.push(`- ${entry.period}: ${entry.other_source} disagrees with canonical ${entry.canonical_source} (${entry.other_value} vs ${entry.canonical_value}, ${entry.difference_pct}%).`);
  lines.push('', '## Interpretation', '', interpretation(analysis), '');
  lines.push('## Provenance', '');
  if (analysis.provenance.length === 0) lines.push('- No observation snapshot supplied data. Nothing was fetched or inferred.');
  for (const entry of analysis.provenance) lines.push(`- \`${entry.file}\` — source ${entry.source_id} (${entry.adapter}), property ${entry.property ?? 'unspecified'}, period ${entry.period?.start ?? '?'} → ${entry.period?.end ?? '?'}, retrieved ${entry.retrieved_at}, rows sha256 \`${entry.rows_sha256}\``);
  if (contextRefs.length) lines.push('', '## External context', '', ...contextRefs.map((ref) => `- ${ref}`));
  return `${lines.join('\n')}\n`;
}

export function thresholdResult(experiment, observed, qualityLevel) {
  const success = parseThreshold(experiment.definition.success_threshold);
  const failure = parseThreshold(experiment.definition.failure_threshold);
  if (qualityLevel === 'insufficient' || observed === null || observed === undefined) return {observed: null, result: 'insufficient_data'};
  if (!success || !failure) return {observed, result: 'thresholds_unparseable'};
  if (meetsThreshold(observed, success)) return {observed, result: 'success_threshold_met'};
  if (meetsThreshold(observed, failure)) return {observed, result: 'failure_threshold_met'};
  return {observed, result: 'between_thresholds'};
}

// Write an EV record from an analysis. Evidence is append-only: a re-analysis
// writes a new record with `supersedes`, never edits the earlier one.
export function writeEvidence(root, analysis, {title, observation, kind = 'comparison', experiment = null, threshold = null, missionId = null, assetIds = [], publicationIds = [], deploymentIds = [], baselineIds = [], contextRefs = [], supersedes = null}) {
  const {comparison} = analysis;
  const data = {
    title,
    status: 'recorded',
    kind,
    recorded_at: analysis.generated_at ?? nowIso(),
    metric: analysis.metric.id,
    metric_version: analysis.metric.version,
    unit: analysis.metric.unit,
    source_ids: [analysis.source_id],
    period_before_start: analysis.before.start,
    period_before_end: analysis.before.end,
    period_after_start: analysis.after.start,
    period_after_end: analysis.after.end,
    before_value: comparison?.before?.value ?? null,
    after_value: comparison?.after?.value ?? null,
    basis: comparison?.basis ?? null,
    delta_abs: comparison?.delta_abs ?? null,
    delta_pct: comparison?.delta_pct ?? null,
    data_quality: analysis.data_quality.level,
    evidence_strength: analysis.evidence_strength.level,
    causal_confidence: analysis.causal_confidence.level,
    evidence_grade: analysis.metric.evidence_grade,
    threshold_result: threshold?.result ?? null,
    mission_id: missionId ?? experiment?.mission_id ?? null,
    experiment_id: experiment?.id ?? null,
    experiment_fingerprint: experiment?.fingerprint ?? null,
    criteria_basis: threshold?.criteria_basis ?? null,
    change_ids: analysis.changes.linked,
    confounding_change_ids: analysis.changes.overlapping,
    asset_ids: assetIds,
    publication_ids: publicationIds,
    deployment_ids: deploymentIds,
    baseline_ids: baselineIds,
    context_refs: contextRefs,
    confounder_count: analysis.confounders.length,
    design: analysis.design ?? 'before_after',
    control_pages: analysis.control?.usable ? analysis.control.pages : 0,
    did_effect: analysis.control?.usable ? analysis.control.effect : null,
    pre_trend_passed: analysis.control?.usable ? analysis.control.pre_trend.passed : null,
    seasonality_checked: Boolean(analysis.seasonality?.checked),
    last_year_change_pct: analysis.seasonality?.checked ? analysis.seasonality.last_year_change_pct : null,
    artifacts: analysis.provenance.map((entry) => entry.file),
    supersedes,
  };
  const summary = `${isoDate(data.recorded_at)} — ${analysis.metric.id} ${data.before_value ?? 'unknown'} → ${data.after_value ?? 'unknown'} — quality ${data.data_quality}, strength ${data.evidence_strength}, causal ${data.causal_confidence}${data.experiment_id ? ` — ${data.experiment_id}` : ''}`;
  const record = createRecord(root, 'evidence', {title, data, summary, body: (id) => renderEvidenceBody({...analysis, id}, {title, observation, experiment, threshold, contextRefs})});
  return record;
}
