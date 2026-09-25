#!/usr/bin/env node
// Analysis commands (AUDIT / MONITOR / MAINTAIN and ad-hoc evidence):
//
//   compare     --metric <id> --before-start --before-end --after-start --after-end
//               [--source <id>] [--page /a,/b] [--query q] [--country c] [--segment s]
//               [--change CH-1,CH-2] [--experiment EX-NNN] [--design <design>]
//               [--context ref,...] [--control auto|none | --control-page /a,/b] [--yoy]
//               [--record --title "<t>" --observation "<text>" [--supersedes EV-NNN]]
//   discrepancy --metric <id> --start <date> --end <date> [--sources a,b] [--record]
//   monitor     [--record]
//   maintain    [--report]
//   audit       --scope growth|revenue|tracking [--days 28] [--metrics a,b]
//               [--record-baselines] [--report]
//   funnel      --funnel <id> --start <date> --end <date>
//   compact     [--prune-unreferenced [--older-than-days 180]] [--dry-run]
//
// Common: [--project <dir>] [--now <ISO>]. Output: one JSON object.
// Nothing here modifies production or any neighbor harness.

import fs from 'node:fs';
import path from 'node:path';
import {UsageError, addDays, findRecord, isoDate, listDir, listRecords, nowIso, parseArgs, printJson, readMaybeGzipJson, readText, relative, requireInitialized, resolveProject, round, runCli, scopeFromArgs, sha256, writeGzipJson} from './lib/core.mjs';
import {analyzeComparison, interpretation, measurePeriod, resolveMetric, writeEvidence} from './lib/analysis.mjs';
import {runMonitors} from './lib/monitor.mjs';
import {probe, readPlans} from './lib/probe.mjs';
import {discrepancy, levelFromIssues} from './lib/quality.mjs';
import {createAnomaly, recordBaseline} from './lib/records.mjs';
import {table, writeReport} from './lib/report.mjs';
import {getSource, loadMetrics, loadMonitors, loadProject} from './lib/state.mjs';

const COMMON = ['project', 'now'];

function context(argv, spec) {
  const args = parseArgs(argv, spec);
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  return {args, project, root, now: nowIso(args.now)};
}

function compare(argv) {
  const {args, project, root, now} = context(argv, {flags: ['record', 'yoy'], options: [...COMMON, 'metric', 'source', 'before-start', 'before-end', 'after-start', 'after-end', 'query', 'country', 'device', 'segment', 'experiment', 'design', 'title', 'observation', 'supersedes', 'control'], lists: ['page', 'change', 'context', 'control-page']});
  // --yoy: the before window is the after window 52 weeks earlier (weekday-aligned).
  if (args.yoy) {
    if (!args.afterStart || !args.afterEnd) throw new UsageError('--yoy needs --after-start and --after-end');
    if (args.beforeStart || args.beforeEnd) throw new UsageError('--yoy sets the before window itself; do not pass --before-start/--before-end');
    args.beforeStart = addDays(args.afterStart, -364);
    args.beforeEnd = addDays(args.afterEnd, -364);
  }
  for (const key of ['metric', 'beforeStart', 'beforeEnd', 'afterStart', 'afterEnd']) if (!args[key]) throw new UsageError('compare needs --metric, --before-start, --before-end, --after-start, --after-end (or --after-* with --yoy)');
  const control = args.controlPage ? args.controlPage : args.control ?? 'auto';
  if (!Array.isArray(control) && !['auto', 'none'].includes(control)) throw new UsageError('--control must be auto or none (or pass --control-page /a,/b)');
  const analysis = analyzeComparison(root, project, {
    metricId: args.metric,
    sourceId: args.source ?? null,
    before: {start: args.beforeStart, end: args.beforeEnd},
    after: {start: args.afterStart, end: args.afterEnd},
    scope: scopeFromArgs(args),
    linkedChangeIds: args.change ?? [],
    experimentId: args.experiment ?? null,
    design: args.design ?? 'before_after',
    now,
    contextRefs: args.context ?? [],
    control,
    seasonality: !args.yoy,
  });
  const output = {status: 'analyzed', interpretation: interpretation(analysis), analysis};
  if (args.record) {
    if (!args.title) throw new UsageError('--record needs --title');
    if (args.supersedes && !findRecord(root, 'evidence', args.supersedes)) throw new UsageError(`--supersedes ${args.supersedes}: no such evidence`);
    const record = writeEvidence(root, analysis, {title: args.title, observation: args.observation ?? interpretation(analysis), kind: 'comparison', contextRefs: args.context ?? [], supersedes: args.supersedes ?? null});
    output.evidence = {id: record.id, path: record.path};
  }
  printJson(output);
}

function valuesBySource(root, project, metric, sources, period, scope, now) {
  const projectData = loadProject(root);
  const changes = listRecords(root, 'change');
  return sources.map((sourceId) => {
    const measure = measurePeriod(root, {metric, sourceId, period, scope, label: sourceId, project: projectData, now, changes});
    return {source_id: sourceId, value: measure.value === null ? null : round(measure.value), sample: measure.sample ?? 0, data_quality: levelFromIssues(measure.issues), issues: measure.issues};
  });
}

function discrepancyCommand(argv) {
  const {args, project, root, now} = context(argv, {flags: ['record'], options: [...COMMON, 'metric', 'start', 'end', 'query', 'country', 'device', 'segment'], lists: ['sources', 'page']});
  if (!args.metric || !args.start || !args.end) throw new UsageError('discrepancy needs --metric, --start, --end');
  const metric = resolveMetric(root, args.metric);
  const sources = args.sources ?? [metric.canonical_source, ...(metric.fallback_sources ?? [])].filter(Boolean);
  const period = {start: args.start, end: args.end};
  const values = valuesBySource(root, project, metric, sources, period, scopeFromArgs(args), now);
  const result = discrepancy(metric, values);
  const output = {
    status: result.findings.length ? 'discrepancy' : result.canonical ? 'consistent' : 'insufficient_data',
    metric: metric.id,
    period,
    canonical_source: metric.canonical_source,
    canonical_value: result.canonical?.value ?? null,
    tolerance_pct: result.tolerance_pct,
    values,
    findings: result.findings,
    rule: `the canonical source (${metric.canonical_source}) is reported as the value of ${metric.id}; other sources are shown, never silently substituted`,
    note: result.note ?? null,
  };
  if (args.record && result.findings.length) {
    const lines = ['## Observation', '', `For ${period.start} → ${period.end}, sources disagree on \`${metric.id}\` beyond the ${result.tolerance_pct}% tolerance.`, '', ...table(['Source', 'Value', 'Sample', 'Data quality', 'Canonical'], values.map((entry) => [entry.source_id, entry.value ?? 'unknown', entry.sample, entry.data_quality, entry.source_id === metric.canonical_source ? 'yes' : 'no'])), '', '## Rule', '', output.rule, '', '## Possible explanations', '', '- Different definitions (event vs row), deduplication, time zones, consent/ad-blocking loss, test traffic, or refunds.', '- Verify the metric definitions in metrics.json against each source before reconciling.', ''].join('\n');
    output.anomaly = createAnomaly(root, {title: `Source discrepancy: ${metric.id}`, kind: 'discrepancy', dedupe_key: `discrepancy:${metric.id}:${sources.join('+')}:${period.start}:${period.end}`, metric: metric.id, source_id: metric.canonical_source, severity: 'medium', period_current_start: period.start, period_current_end: period.end, current_value: result.canonical?.value ?? null, data_quality: 'low'}, lines, now);
  }
  printJson(output);
}

function monitor(argv) {
  const {args, project, root, now} = context(argv, {flags: ['record'], options: COMMON});
  const results = runMonitors(root, project, now, {record: Boolean(args.record)});
  const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
  printJson({status: 'monitored', monitors: results.length, alerts: count('alert'), quiet: count('quiet'), insufficient_data: count('insufficient_data'), misconfigured: count('misconfigured'), results});
}

function maintain(argv) {
  const {args, project, root, now} = context(argv, {flags: ['report'], options: COMMON});
  const snapshot = probe(project, now);
  const {metrics} = loadMetrics(root);
  const {monitors} = loadMonitors(root);
  const checks = [];
  const add = (area, status, detail, action = null) => checks.push({area, status, detail, action});
  for (const source of snapshot.sources) {
    if (source.health === 'ok') add('source', 'ok', `${source.id} data through ${source.data_through}`);
    else add('source', 'attention', `${source.id}: ${source.warning}`, source.health === 'stale' ? `refresh ${source.id} data` : `check ${source.id} access`);
  }
  for (const metric of metrics) {
    if (metric.status === 'proposed') add('metric', 'attention', `${metric.id} is proposed`, 'confirm its definition and canonical source');
    else if (metric.canonical_source && !getSource(root, metric.canonical_source)) add('metric', 'attention', `${metric.id} canonical source ${metric.canonical_source} is not registered`, 'register the source or change the canonical source');
  }
  for (const monitorRule of monitors) if (!metrics.some((metric) => metric.id === monitorRule.metric)) add('monitor', 'attention', `${monitorRule.id} watches unknown metric ${monitorRule.metric}`, 'fix monitors.json');
  for (const experiment of snapshot.experiments) add('experiment', experiment.ready_to_evaluate ? 'attention' : 'ok', `${experiment.id}: ${experiment.next}`, experiment.ready_to_evaluate ? `evaluate ${experiment.id}` : null);
  const anomalies = listRecords(root, 'anomaly').filter((record) => record.data.status === 'open');
  for (const anomaly of anomalies) {
    const ageDays = Math.floor((Date.parse(now) - Date.parse(anomaly.data.detected_at)) / 86400000);
    add('anomaly', 'attention', `${anomaly.data.id} open for ${ageDays} day(s): ${anomaly.data.title}`, ageDays > 14 ? 'resolve or dismiss with a reason' : 'review');
  }
  if (snapshot.seo.opportunities_awaiting_review) add('seo', 'attention', `${snapshot.seo.opportunities_awaiting_review} opportunity record(s) awaiting Marketer7 review`, 'hand off or dismiss');
  const staleAfterDays = 90;
  for (const baseline of listRecords(root, 'baseline')) {
    const age = Math.floor((Date.parse(now) - Date.parse(`${baseline.data.period_end}T00:00:00Z`)) / 86400000);
    if (age > staleAfterDays) add('baseline', 'attention', `${baseline.data.id} (${baseline.data.metric}) ends ${baseline.data.period_end}, ${age} days ago`, 'refresh the baseline before comparing against it');
  }
  if (snapshot.changes.unconfirmed.length) add('change', 'attention', `unconfirmed change timing: ${snapshot.changes.unconfirmed.join(', ')}`, 'confirm deploy/publish times (supersede with a confirmed record)');
  if (snapshot.changes.pending_deploy.length) add('change', 'attention', `applied but not deployed: ${snapshot.changes.pending_deploy.join(', ')}`, 'when they go live, record.mjs deploy --changes … --deployed-at <time>');
  if (snapshot.changes.unknown_timing.length) add('change', 'attention', `unknown change timing: ${snapshot.changes.unknown_timing.join(', ')}`, 'record the timestamp; unplaced changes weaken every overlapping analysis');
  const uncompressed = walkFiles(path.join(root, 'observations')).filter((file) => file.endsWith('.json'));
  if (uncompressed.length) add('storage', 'attention', `${uncompressed.length} uncompressed observation snapshot(s)`, 'run analyze.mjs compact (gzip, hash-verified)');
  const plans = readPlans(root);
  for (const plan of plans) if (plan.status === 'planned' && !plan.baseline_id) add('experiment', 'attention', `${plan.experiment_id} has a plan but no baseline`, 'record the baseline before the window starts');
  const output = {status: 'maintained', now, attention: checks.filter((check) => check.status === 'attention').length, checks, next_action: snapshot.next_action, note: 'MAINTAIN reviews analytical state only; it never modifies production, neighbor harnesses, or historical evidence.'};
  if (args.report) {
    const report = writeReport(project, {mode: 'maintain', scope: 'state', now, title: `Analyzer7 maintenance — ${isoDate(now)}`, sources: snapshot.sources.map((source) => source.id), sections: [
      {title: 'Checklist', lines: table(['Area', 'Status', 'Detail', 'Action'], checks.map((check) => [check.area, check.status, check.detail, check.action ?? '']))},
      {title: 'Next analytical action', lines: [snapshot.next_action]},
    ]});
    output.report = report.relative;
  }
  printJson(output);
}

const SCOPE_FILTERS = {
  growth: () => true,
  revenue: (metric) => ['payment', 'willingness_to_pay', 'retention'].includes(metric.marketer_tier) || metric.unit === 'currency',
  tracking: () => true,
};

function audit(argv) {
  const {args, project, root, now} = context(argv, {flags: ['report', 'record-baselines'], options: [...COMMON, 'scope', 'days'], lists: ['metrics']});
  const scope = args.scope ?? 'growth';
  if (!SCOPE_FILTERS[scope]) throw new UsageError('audit --scope must be growth, revenue, or tracking (use seo.mjs audit for SEO)');
  const days = Number(args.days ?? 28);
  const snapshot = probe(project, now);
  const {metrics} = loadMetrics(root);
  const selected = metrics.filter((metric) => (args.metrics ? args.metrics.includes(metric.id) : metric.status !== 'proposed' && SCOPE_FILTERS[scope](metric)));
  const rows = [];
  const gaps = [];
  const discrepancies = [];
  const baselines = [];
  for (const metric of selected) {
    const source = getSource(root, metric.canonical_source);
    if (!source) {
      gaps.push(`${metric.id}: canonical source ${metric.canonical_source ?? '(none)'} is not registered`);
      continue;
    }
    if (!source.data_through) {
      gaps.push(`${metric.id}: ${source.id} has no ingested data`);
      continue;
    }
    const through = isoDate(source.data_through);
    const current = {start: addDays(through, -(days - 1)), end: through};
    const previous = {start: addDays(current.start, -days), end: addDays(current.start, -1)};
    const analysis = analyzeComparison(root, project, {metricId: metric.id, before: previous, after: current, design: 'observational', now, analysisKind: 'audit'});
    const comparison = analysis.comparison;
    rows.push({metric: metric.id, source: source.id, previous, current, previous_value: comparison?.before?.value ?? null, current_value: comparison?.after?.value ?? null, delta_pct: comparison?.delta_pct ?? null, data_quality: analysis.data_quality.level, evidence_strength: analysis.evidence_strength.level, issues: analysis.data_quality.issues, overlapping_changes: analysis.changes.overlapping});
    if (analysis.data_quality.level === 'insufficient') gaps.push(`${metric.id}: INSUFFICIENT DATA — ${analysis.data_quality.issues.filter((entry) => entry.severity === 'blocking').map((entry) => entry.message).join('; ')}`);
    discrepancies.push(...analysis.discrepancies.map((entry) => ({metric: metric.id, ...entry})));
    if (args.recordBaselines && analysis.data_quality.level !== 'insufficient') baselines.push(recordBaseline(root, {metricId: metric.id, period: current, scope: {}, now}).id);
  }
  const monitorResults = runMonitors(root, project, now, {record: false});
  const changes = listRecords(root, 'change').filter((change) => {
    const date = isoDate(change.data.timestamp);
    return date && rows.some((row) => date >= row.previous.start && date <= row.current.end);
  });
  const output = {status: 'audited', scope, days, sources: snapshot.sources, metrics: rows, discrepancies, data_gaps: gaps, monitor_preview: monitorResults, registered_changes: changes.map((change) => ({id: change.data.id, title: change.data.title, timestamp: change.data.timestamp})), baselines_recorded: baselines};
  if (args.report) {
    const report = writeReport(project, {mode: 'audit', scope, now, title: `${scope[0].toUpperCase()}${scope.slice(1)} audit — ${isoDate(now)}`, sources: snapshot.sources.map((source) => source.id), artifacts: baselines, sections: [
      {title: 'Data availability and source health', lines: table(['Source', 'Health', 'Data through', 'Warning'], snapshot.sources.map((source) => [source.id, source.health, source.data_through ?? 'never', source.warning ?? '']))},
      {title: scope === 'tracking' ? 'Tracking integrity' : 'Current baseline (observation)', lines: table(['Metric', 'Source', `Previous ${days}d`, `Current ${days}d`, 'Δ%', 'Data quality', 'Evidence strength'], rows.map((row) => [row.metric, row.source, row.previous_value ?? 'unknown', row.current_value ?? 'unknown', row.delta_pct ?? 'unknown', row.data_quality.toUpperCase(), row.evidence_strength.toUpperCase()]))},
      {title: 'Data quality issues', lines: rows.flatMap((row) => row.issues.map((entry) => `- ${row.metric}: [${entry.severity}] \`${entry.code}\` — ${entry.message}`))},
      {title: 'Source discrepancies', lines: discrepancies.map((entry) => `- ${entry.metric} (${entry.period}): ${entry.other_source} ${entry.other_value} vs canonical ${entry.canonical_source} ${entry.canonical_value} (${entry.difference_pct}%)`)},
      {title: 'Anomalies (monitor preview, not recorded)', lines: monitorResults.map((result) => `- ${result.monitor}: ${result.outcome} — ${result.reason}`)},
      {title: 'Registered changes in the audited windows (candidate explanations only)', lines: changes.map((change) => `- ${change.data.id} ${change.data.timestamp} — ${change.data.title}`)},
      {title: 'Data gaps', lines: gaps.map((gap) => `- ${gap}`)},
      {title: 'Evidence confidence', lines: ['Audit comparisons are observational (no linked change), so causal confidence is NONE by construction. They establish baselines and surface questions; attribution needs a registered change or a Marketer7 experiment.']},
    ]});
    output.report = report.relative;
  }
  printJson(output);
}

function funnel(argv) {
  const {args, project, root, now} = context(argv, {options: [...COMMON, 'funnel', 'start', 'end']});
  if (!args.funnel || !args.start || !args.end) throw new UsageError('funnel needs --funnel, --start, --end');
  const {funnels} = loadMetrics(root);
  const definition = (funnels ?? []).find((entry) => entry.id === args.funnel);
  if (!definition) throw new UsageError(`funnel ${args.funnel} is not defined in metrics.json`);
  const period = {start: args.start, end: args.end};
  const projectData = loadProject(root);
  const changes = listRecords(root, 'change');
  const stages = definition.stages.map((metricId) => {
    const metric = resolveMetric(root, metricId);
    if (metric.status === 'proposed' || !metric.canonical_source) return {metric: metricId, value: null, data_quality: 'insufficient', note: 'definition not confirmed; excluded rather than guessed'};
    const measure = measurePeriod(root, {metric, sourceId: metric.canonical_source, period, scope: {}, label: metricId, project: projectData, now, changes});
    const quality = levelFromIssues(measure.issues);
    return {metric: metricId, source_id: metric.canonical_source, value: quality === 'insufficient' ? null : round(measure.value), data_quality: quality, issues: measure.issues};
  });
  const steps = stages.slice(1).map((stage, index) => {
    const previous = stages[index];
    const rate = previous.value && stage.value !== null ? round((stage.value / previous.value) * 100, 2) : null;
    return {from: previous.metric, to: stage.metric, conversion_pct: rate, note: rate === null ? 'unknown: a stage value is missing or unconfirmed' : previous.source_id !== stage.source_id ? `stages come from different sources (${previous.source_id} → ${stage.source_id}); the rate mixes systems` : null};
  });
  printJson({status: 'measured', funnel: definition.id, definition_status: definition.status ?? 'active', period, stages, steps});
}

function walkFiles(directory) {
  return listDir(directory).flatMap((entry) => (entry.isDirectory() ? walkFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
}

// compact: gzip every uncompressed snapshot (hash verified before and after).
// --prune-unreferenced additionally removes snapshots older than
// --older-than-days that no record, report, or plan mentions and that are
// not the newest of their source and kind; each leaves a tombstone line with
// its hash in observations/pruned.md, so provenance stays verifiable.
function compact(argv) {
  const {args, project, root, now} = context(argv, {flags: ['prune-unreferenced', 'dry-run'], options: [...COMMON, 'older-than-days']});
  const base = path.join(root, 'observations');
  const files = walkFiles(base).filter((file) => /\.json(\.gz)?$/.test(file));
  const bytes = (list) => list.reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
  const before = bytes(files);
  const converted = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const snapshot = readMaybeGzipJson(file);
    if (sha256(JSON.stringify(snapshot.rows)) !== snapshot.rows_sha256) throw new Error(`${relative(project, file)}: rows do not match rows_sha256; refusing to compact a modified snapshot`);
    converted.push(relative(project, file));
    if (args.dryRun) continue;
    const target = `${file}.gz`;
    writeGzipJson(target, snapshot);
    const check = readMaybeGzipJson(target);
    if (sha256(JSON.stringify(check.rows)) !== snapshot.rows_sha256) throw new Error(`${relative(project, target)}: verification failed after compression`);
    fs.rmSync(file);
  }
  const pruned = [];
  if (args.pruneUnreferenced) {
    const days = Number(args.olderThanDays ?? 180);
    const cutoff = addDays(isoDate(now), -days);
    const mentions = walkFiles(root).filter((file) => file.endsWith('.md')).map((file) => readText(file)).join('\n');
    const snapshots = walkFiles(base).filter((file) => /\.json(\.gz)?$/.test(file)).map((file) => ({file, data: readMaybeGzipJson(file)}));
    const newest = new Map();
    for (const snapshot of snapshots) {
      const key = `${snapshot.data.source_id}|${snapshot.data.kind}`;
      const date = snapshot.data.period?.end ?? isoDate(snapshot.data.retrieved_at);
      if (!newest.has(key) || date > newest.get(key).date) newest.set(key, {date, file: snapshot.file});
    }
    const tombstonePath = path.join(base, 'pruned.md');
    for (const snapshot of snapshots) {
      const rel = relative(project, snapshot.file);
      const plain = rel.replace(/\.gz$/, '');
      const date = snapshot.data.period?.end ?? isoDate(snapshot.data.retrieved_at);
      const newestOfKind = newest.get(`${snapshot.data.source_id}|${snapshot.data.kind}`).file === snapshot.file;
      if (date >= cutoff || newestOfKind || mentions.includes(plain)) continue;
      pruned.push(rel);
      if (args.dryRun) continue;
      if (!fs.existsSync(tombstonePath)) fs.writeFileSync(tombstonePath, '# Pruned observations\n\nAppend-only. Each line keeps the hash of a snapshot that no record referenced when it was pruned.\n\n');
      fs.appendFileSync(tombstonePath, `- ${plain} — source ${snapshot.data.source_id}, ${snapshot.data.kind}, period ${snapshot.data.period?.start ?? '?'} → ${snapshot.data.period?.end ?? '?'}, ${snapshot.data.row_count} rows, rows_sha256 ${snapshot.data.rows_sha256}, pruned ${now} (unreferenced, older than ${days} days)\n`);
      fs.rmSync(snapshot.file);
    }
  }
  const after = bytes(walkFiles(base).filter((file) => /\.json(\.gz)?$/.test(file)));
  printJson({status: args.dryRun ? 'dry_run' : 'compacted', converted: converted.length, pruned, bytes_before: before, bytes_after: args.dryRun ? null : after});
}

function main(argv) {
  const [command, ...rest] = argv;
  const commands = {compare, discrepancy: discrepancyCommand, monitor, maintain, audit, funnel, compact};
  if (!commands[command]) throw new UsageError(`analyze.mjs <${Object.keys(commands).join('|')}> [options]`);
  commands[command](rest);
  return 0;
}

runCli(main);
