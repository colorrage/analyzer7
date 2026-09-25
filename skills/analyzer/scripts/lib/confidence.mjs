// Evidence strength and causal confidence.
//
// Three separate axes (see reference/evidence-model.md):
//   data quality      — can the numbers be trusted?            (quality.mjs)
//   evidence strength — is the observed change real, not noise? (here)
//   causal confidence — did the linked change cause it?         (here)
// Each axis caps the next: weak data cannot yield strong evidence, and weak
// evidence cannot yield causal confidence. Every downgrade records a reason.
// The rubric result is a ceiling: an analyst may lower it with a reason,
// never raise it.

import {isoDate, normalizePage, parseTimestamp} from './core.mjs';

const STRENGTH = ['insufficient', 'low', 'medium', 'high'];
const CAUSAL = ['none', 'low', 'medium', 'high'];

function capAt(level, ceiling, scale) {
  return scale[Math.min(scale.indexOf(level), scale.indexOf(ceiling))];
}

export function evidenceStrength({dataQuality, comparison, minSample}) {
  const reasons = [];
  if (dataQuality === 'insufficient') return {level: 'insufficient', reasons: ['data quality is insufficient']};
  if (!comparison || comparison.before.value === null || comparison.after.value === null) return {level: 'insufficient', reasons: ['a period has no value']};
  if (minSample && (comparison.before.sample < minSample || comparison.after.sample < minSample)) {
    return {level: 'insufficient', reasons: [`sample below metric minimum ${minSample}`]};
  }
  const {statistic, method} = comparison.significance;
  let level;
  if (statistic === null) {
    // Without a variance estimate the shift cannot be separated from noise;
    // only a large effect earns medium, never more.
    const effect = Math.abs(comparison.delta_pct ?? 0);
    level = effect >= 20 ? 'medium' : 'low';
    reasons.push(`no variance estimate (${method}); judged by effect size alone (${effect.toFixed(1)}%), at most medium`);
  } else {
    const magnitude = Math.abs(statistic);
    level = magnitude >= 3 ? 'high' : magnitude >= 2 ? 'medium' : 'low';
    reasons.push(`shift of ${magnitude.toFixed(2)} standard errors (${method})`);
  }
  if (dataQuality === 'medium') {
    level = capAt(level, 'medium', STRENGTH);
    reasons.push('data quality medium caps strength at medium');
  }
  if (dataQuality === 'low') {
    level = capAt(level, 'low', STRENGTH);
    reasons.push('data quality low caps strength at low');
  }
  const shortest = Math.min(comparison.before.days, comparison.after.days);
  if (shortest < 7) {
    level = capAt(level, 'low', STRENGTH);
    reasons.push(`window of ${shortest} days caps strength at low`);
  } else if (shortest < 14) {
    level = capAt(level, 'medium', STRENGTH);
    reasons.push(`window of ${shortest} days caps strength at medium`);
  }
  const persistence = comparison.persistence;
  if (!persistence.checked) {
    level = capAt(level, 'medium', STRENGTH);
    reasons.push('persistence not checkable (needs daily rows); capped at medium');
  } else if (!persistence.persistent) {
    level = capAt(level, 'low', STRENGTH);
    reasons.push('the change does not persist across both halves of the after period');
  }
  if (comparison.delta_abs === 0) {
    level = capAt(level, 'low', STRENGTH);
    reasons.push('no change observed');
  }
  return {level, reasons};
}

function daySpan(start, end) {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
}

function pagesOf(change) {
  const pages = change.data.pages;
  if (!pages || (Array.isArray(pages) && pages.length === 0)) return null; // site-wide or unknown scope
  return (Array.isArray(pages) ? pages : [pages]).map(normalizePage);
}

function scopesOverlap(changePages, scopePages) {
  if (changePages === null || !scopePages || scopePages.length === 0) return true;
  const scope = new Set(scopePages.map(normalizePage));
  return changePages.some((page) => scope.has(page));
}

// Classify registered changes relative to an analysis.
export function classifyChanges(changes, {before, after, scopePages, linkedIds = [], experimentId = null}) {
  const linked = [];
  const overlapping = [];
  const unplaced = [];
  const superseded = new Set(changes.map((change) => change.data.supersedes).filter(Boolean));
  for (const change of changes) {
    if (superseded.has(change.data.id)) continue;
    const isLinked = linkedIds.includes(change.data.id) || (experimentId && change.data.experiment_id === experimentId);
    const timestamp = parseTimestamp(change.data.timestamp);
    if (isLinked) {
      linked.push(change);
      continue;
    }
    if (timestamp === null) {
      if (scopesOverlap(pagesOf(change), scopePages)) unplaced.push(change);
      continue;
    }
    const date = isoDate(change.data.timestamp);
    if (date >= before.start && date <= after.end && scopesOverlap(pagesOf(change), scopePages)) overlapping.push(change);
  }
  return {linked, overlapping, unplaced};
}

// Confounders are listed even when they do not lower confidence.
// Major confounders lower causal confidence one level each; three or more
// minor confounders together lower it one level; `info` entries are listed
// for transparency and never lower it.
export function confounders({classified, before, after, context = {}}) {
  const list = [];
  for (const change of classified.overlapping) {
    const date = isoDate(change.data.timestamp);
    const where = date < after.start ? 'during the baseline period (baseline contaminated)' : 'during the measurement window';
    const tracking = change.data.type === 'tracking_change';
    // A proven same-page overlap is major. An unknown scope (no pages recorded)
    // is a possible overlap only, so it is listed as minor — except tracking
    // changes, which break comparability wherever they land.
    const knownScope = pagesOf(change) !== null;
    const severity = tracking || knownScope ? 'major' : 'minor';
    list.push({severity, code: tracking ? 'tracking_change' : knownScope ? 'overlapping_change' : 'possible_overlapping_change', ref: change.data.id, message: `${change.data.id} ${change.data.title ?? change.data.type} (${change.data.origin}) on ${date}, ${where}, ${knownScope ? 'same scope' : 'scope unknown (treated as site-wide)'}`});
  }
  for (const change of classified.unplaced) {
    list.push({severity: 'minor', code: 'unplaced_change', ref: change.data.id, message: `${change.data.id} ${change.data.title ?? ''} has unknown timing and overlapping scope`});
  }
  for (const change of classified.linked) {
    if (change.data.confirmed === false) list.push({severity: 'minor', code: 'unconfirmed_change', ref: change.data.id, message: `${change.data.id} timing is not confirmed (basis: ${change.data.timestamp_basis ?? 'unknown'})`});
    const date = isoDate(change.data.timestamp);
    // Severity scales with how much of the period the change contaminates:
    // a change on the final baseline day touches ~1/28 of it.
    if (date && before && date <= before.end && date >= before.start) {
      const share = daySpan(date, before.end) / daySpan(before.start, before.end);
      list.push({severity: share <= 0.05 ? 'info' : share <= 0.25 ? 'minor' : 'major', code: 'linked_change_in_baseline', ref: change.data.id, message: `${change.data.id} happened on ${date}, inside the baseline period (${Math.round(share * 100)}% of baseline days follow it) — the baseline may contain part of the effect`});
    } else if (date && after && date > after.start && date <= after.end) {
      const share = daySpan(after.start, date) / daySpan(after.start, after.end);
      list.push({severity: share <= 0.05 ? 'info' : 'minor', code: 'linked_change_mid_window', ref: change.data.id, message: `${change.data.id} happened on ${date}, after the measurement window started ${after.start} (${Math.round(share * 100)}% of window days precede it)`});
    }
  }
  if (context.positionShift !== undefined && context.positionShift !== null) {
    const shift = Math.abs(context.positionShift);
    if (shift >= 0.5) list.push({severity: shift >= 2 ? 'major' : 'minor', code: 'position_shift', message: `average position moved ${context.positionFrom} → ${context.positionTo} in the same scope${context.positionNet ? ` (${context.positionShift > 0 ? '+' : ''}${context.positionShift.toFixed(2)} net of the control group)` : ''}; CTR depends on position`});
  }
  if (context.demandShiftPct !== undefined && context.demandShiftPct !== null) {
    const shift = Math.abs(context.demandShiftPct);
    if (shift >= 10) list.push({severity: shift >= 50 ? 'major' : 'minor', code: 'demand_shift', message: `impressions (search demand/visibility) changed ${context.demandShiftPct > 0 ? '+' : ''}${context.demandShiftPct.toFixed(1)}% between periods${context.demandNet ? ' net of the control group' : ''}`});
  }
  if (before && after) {
    const beforeDays = Math.round((Date.parse(before.end) - Date.parse(before.start)) / 86400000) + 1;
    const afterDays = Math.round((Date.parse(after.end) - Date.parse(after.start)) / 86400000) + 1;
    // A control group shares the weekday mix, so it cancels out.
    if (beforeDays !== afterDays || beforeDays % 7 !== 0) list.push({severity: context.controlled ? 'info' : 'minor', code: 'weekday_mix', message: `periods of ${beforeDays} and ${afterDays} days do not share the same weekday mix${context.controlled ? ' (shared by the control group, so it cancels)' : ''}`});
  }
  const seasonal = context.seasonal;
  if (seasonal?.checked && seasonal.last_year_change_pct !== null && seasonal.observed_change_pct !== null) {
    const lastYearPct = seasonal.last_year_change_pct;
    const observed = seasonal.observed_change_pct;
    const explains = Math.sign(lastYearPct) === Math.sign(observed) && Math.abs(lastYearPct) >= 0.5 * Math.abs(observed);
    const message = `the same windows 52 weeks earlier moved ${lastYearPct > 0 ? '+' : ''}${lastYearPct}% (${seasonal.periods.before.start} → ${seasonal.periods.after.end}) vs ${observed > 0 ? '+' : ''}${observed}% now`;
    if (context.controlled) list.push({severity: 'info', code: 'seasonal_pattern', message: `${message}; shared seasonality is absorbed by the control group`});
    else if (explains) list.push({severity: 'major', code: 'seasonal_pattern', message: `${message} — a recurring seasonal pattern can explain much of the change`});
    else if (Math.abs(lastYearPct) >= 10) list.push({severity: 'minor', code: 'seasonal_pattern', message});
    else list.push({severity: 'info', code: 'seasonality_checked', message: `${message}; no comparable seasonal swing`});
  }
  if (context.parallelTrends && !context.parallelTrends.passed) list.push({severity: 'major', code: 'parallel_trends_violated', message: `treated and control pages were already diverging before the change (pre-trend statistic ${context.parallelTrends.statistic}); the control does not fully isolate the effect`});
  for (const ref of context.externalContext ?? []) list.push({severity: 'minor', code: 'external_context', ref, message: `external context recorded: ${ref}`});
  for (const note of context.extra ?? []) list.push(note);
  return list;
}

// design: randomized_controlled | controlled | before_after | observational
export function causalConfidence({design = 'before_after', designCeiling = null, classified, confounderList, evidence, before, after}) {
  const reasons = [];
  if (classified.linked.length === 0) return {level: 'none', reasons: ['no registered change or experiment is linked; this is an observation, not an attribution']};
  if (evidence === 'insufficient') return {level: 'none', reasons: ['evidence is insufficient']};
  const placed = classified.linked.filter((change) => parseTimestamp(change.data.timestamp) !== null);
  if (placed.length === 0) return {level: 'none', reasons: ['linked change timing is unknown']};
  const lateChange = placed.every((change) => isoDate(change.data.timestamp) > after.end);
  if (lateChange) return {level: 'none', reasons: ['linked change happened after the measurement window']};
  const earlyChange = before && placed.every((change) => isoDate(change.data.timestamp) < before.start);
  if (earlyChange) return {level: 'none', reasons: ['linked change predates both compared periods, so the comparison cannot isolate its effect']};
  // Difference-in-differences earns a high ceiling only with parallel
  // pre-trends and a clear net effect (the caller passes designCeiling).
  let level = designCeiling ?? {randomized_controlled: 'high', difference_in_differences: 'medium', controlled: 'medium', before_after: 'medium'}[design] ?? 'low';
  reasons.push(`${design.replace('before_after', 'before/after').replace(/_/g, ' ')} design sets a ceiling of ${level}${design === 'difference_in_differences' ? (level === 'high' ? ' (parallel pre-trends hold and the net effect is clear)' : ' (pre-trends or the net effect are not strong enough for high)') : ''}`);
  if (evidence === 'low') {
    level = capAt(level, 'low', CAUSAL);
    reasons.push('low evidence strength caps causal confidence at low');
  } else if (evidence === 'medium' && level === 'high') {
    level = 'medium';
    reasons.push('medium evidence strength caps causal confidence at medium');
  }
  const majors = confounderList.filter((entry) => entry.severity === 'major');
  const minors = confounderList.filter((entry) => entry.severity === 'minor');
  let steps = majors.length + (minors.length >= 3 ? 1 : 0);
  if (majors.length) reasons.push(`${majors.length} major confounder(s): ${majors.map((entry) => entry.ref ?? entry.code).join(', ')}`);
  if (minors.length >= 3) reasons.push(`${minors.length} minor confounders together lower confidence one level`);
  while (steps > 0 && level !== 'low') {
    level = CAUSAL[CAUSAL.indexOf(level) - 1];
    steps -= 1;
  }
  if (steps > 0) reasons.push('confidence floored at low: the linked change and the timing remain consistent with the hypothesis');
  return {level, reasons};
}
