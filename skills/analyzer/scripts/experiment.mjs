#!/usr/bin/env node
// Measure a Marketer7 experiment. Analyzer7 never defines or decides an
// experiment: it reads the Marketer7 definition in place, records which
// definition fingerprint it measured, and reports a threshold comparison.
//
//   plan     --experiment EX-NNN [--metric <id>] [--source <id>] [--page /a,/b]
//            [--design before_after|controlled|randomized_controlled]
//            [--baseline-start <date> --baseline-end <date>] [--record-baseline]
//   evaluate --experiment EX-NNN [--record] [--allow-open-window]
//            [--context scout7:R1,...]
//   status   --experiment EX-NNN
//
// Common: [--project <dir>] [--now <ISO>]. Output: one JSON object.

import fs from 'node:fs';
import path from 'node:path';
import {UsageError, addDays, daysInclusive, findRecord, listRecords, nowIso, parseArgs, parsePeriod, parseTimestamp, printJson, readDocument, relative, renderDocument, requireInitialized, resolveProject, runCli, updateDocument, writeNew} from './lib/core.mjs';
import {analyzeComparison, resolveMetric, thresholdResult, writeEvidence} from './lib/analysis.mjs';
import {writeExternalReference} from './lib/export.mjs';
import {findMarketerExperiment} from './lib/neighbors.mjs';
import {issue} from './lib/quality.mjs';
import {recordBaseline} from './lib/records.mjs';

const LOCKED_STATUSES = new Set(['approved', 'running', 'measurement_pending', 'evaluating', 'win', 'loss', 'inconclusive']);
const DESIGNS = new Set(['before_after', 'controlled', 'randomized_controlled', 'observational']);

function planPath(root, experimentId) {
  return path.join(root, 'experiments', experimentId, 'plan.md');
}

function requireExperiment(project, experimentId) {
  if (!/^EX-\d{3,}$/.test(experimentId ?? '')) throw new UsageError('--experiment EX-NNN is required');
  const experiment = findMarketerExperiment(project, experimentId);
  if (!experiment) throw new UsageError(`${experimentId} not found in .marketer/experiments — Analyzer7 measures Marketer7 experiments and does not create its own definitions`);
  return experiment;
}

function linkedChanges(root, experimentId) {
  const changes = listRecords(root, 'change');
  const superseded = new Set(changes.map((change) => change.data.supersedes).filter(Boolean));
  return changes.filter((change) => change.data.experiment_id === experimentId && !superseded.has(change.data.id));
}

function plan(argv) {
  const args = parseArgs(argv, {flags: ['record-baseline'], options: ['project', 'now', 'experiment', 'metric', 'source', 'design', 'baseline-start', 'baseline-end'], lists: ['page']});
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  const now = nowIso(args.now);
  const experiment = requireExperiment(project, args.experiment);
  const target = planPath(root, experiment.id);
  if (fs.existsSync(target)) throw new UsageError(`${experiment.id} already has a measurement plan at ${relative(project, target)}`);
  const warnings = [];
  if (!LOCKED_STATUSES.has(experiment.status)) warnings.push(`Marketer7 status is ${experiment.status}: criteria are not locked yet; the plan records the current fingerprint and evaluation will flag any later change`);
  const metricKey = args.metric ?? experiment.definition.primary_metric;
  const metric = resolveMetric(root, metricKey);
  const window = parsePeriod(experiment.definition.measurement_window);
  if (!window) throw new UsageError(`cannot parse the Marketer7 measurement window "${experiment.definition.measurement_window}"`);
  const design = args.design ?? 'before_after';
  if (!DESIGNS.has(design)) throw new UsageError(`--design must be one of ${[...DESIGNS].join(', ')}`);
  const changes = linkedChanges(root, experiment.id);
  const pages = args.page ?? [...new Set(changes.flatMap((change) => change.data.pages ?? []))];
  if (pages.length === 0) warnings.push('no page scope: the measurement covers the whole property (site-wide), which weakens attribution');
  const length = daysInclusive(window.start, window.end);
  const before = args.baselineStart && args.baselineEnd ? {start: args.baselineStart, end: args.baselineEnd} : {start: addDays(window.start, -length), end: addDays(window.start, -1)};
  const data = {
    schema_version: 1,
    experiment_id: experiment.id,
    mission_id: experiment.mission_id,
    status: 'planned',
    marketer_path: experiment.path,
    marketer_status_at_plan: experiment.status,
    marketer_fingerprint: experiment.fingerprint,
    criteria_locked_at: experiment.criteria_locked_at,
    metric: metric.id,
    metric_version: metric.version ?? 1,
    source_id: args.source ?? metric.canonical_source,
    scope_pages: pages,
    design,
    before_start: before.start,
    before_end: before.end,
    window_start: window.start,
    window_end: window.end,
    baseline_id: null,
    change_ids: changes.map((change) => change.data.id),
    evidence_ids: [],
    planned_at: now,
    updated_at: now,
  };
  const body = [
    `# ${experiment.id} — measurement plan`,
    '',
    '## Reference',
    '',
    `The experiment is defined and owned by Marketer7 at \`${experiment.path}\`. This plan does not copy or reinterpret it; it records what Analyzer7 will measure and which definition version it measured (fingerprint \`${experiment.fingerprint}\`).`,
    '',
    `- Primary metric (Marketer7): ${experiment.definition.primary_metric} → dictionary metric \`${metric.id}\` v${metric.version ?? 1}`,
    `- Thresholds (Marketer7): success ${experiment.definition.success_threshold}; failure ${experiment.definition.failure_threshold}`,
    `- Measurement window (Marketer7): ${window.start} → ${window.end}`,
    `- Baseline period (Analyzer7): ${before.start} → ${before.end}${args.baselineStart ? ' (explicit)' : ' (same length, immediately before the window)'}`,
    `- Scope: ${pages.length ? pages.join(', ') : 'site-wide'}`,
    `- Design: ${design}`,
    `- Linked changes: ${changes.map((change) => change.data.id).join(', ') || 'none registered yet'}`,
    '',
    ...(warnings.length ? ['## Warnings', '', ...warnings.map((warning) => `- ${warning}`), ''] : []),
    '## Status history',
    '',
    `- ${now} — planned`,
    '',
  ].join('\n');
  writeNew(target, renderDocument(data, body));
  let baseline = null;
  if (args.recordBaseline) {
    baseline = recordBaseline(root, {metricId: metric.id, sourceId: data.source_id, period: before, scope: pages.length ? {page: pages} : {}, experimentId: experiment.id, now});
    updateDocument(target, {baseline_id: baseline.id, status: 'baseline_recorded', updated_at: now}, `- ${now} — baseline recorded as ${baseline.id}\n`);
  }
  printJson({status: baseline ? 'baseline_recorded' : 'planned', plan: relative(project, target), experiment_id: experiment.id, metric: metric.id, before, window, scope_pages: pages, baseline_id: baseline?.id ?? null, warnings});
  return 0;
}

function evaluate(argv) {
  const args = parseArgs(argv, {flags: ['record', 'allow-open-window'], options: ['project', 'now', 'experiment'], lists: ['context']});
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  const now = nowIso(args.now);
  const experiment = requireExperiment(project, args.experiment);
  const target = planPath(root, experiment.id);
  if (!fs.existsSync(target)) throw new UsageError(`${experiment.id} has no measurement plan; run experiment.mjs plan first`);
  const planDocument = readDocument(target);
  const planData = planDocument.data;
  const window = {start: planData.window_start, end: planData.window_end};
  const before = {start: planData.before_start, end: planData.before_end};
  const warnings = [];
  const extraIssues = [];
  if (planData.marketer_fingerprint !== experiment.fingerprint) {
    warnings.push(`the Marketer7 definition changed since the plan (planned ${planData.marketer_fingerprint}, now ${experiment.fingerprint}); thresholds are read from the current definition — Marketer7 governs whether that change is legitimate`);
  }
  if (experiment.definition_matches_review === false) warnings.push('the current Marketer7 definition does not match its review-time lock');
  if (parseTimestamp(now) <= Date.parse(`${window.end}T23:59:59Z`)) {
    if (!args.allowOpenWindow) {
      printJson({status: 'window_open', experiment_id: experiment.id, window, message: `the measurement window closes ${window.end}; no evidence is produced before then (pass --allow-open-window for an explicitly partial read)`});
      return 0;
    }
    extraIssues.push(issue('window_open', 'major', `measurement window ${window.start} → ${window.end} has not closed; this is a partial read`));
  }
  const baseline = planData.baseline_id ? findRecord(root, 'baseline', planData.baseline_id) : null;
  if (!baseline) warnings.push('no recorded baseline; the before period is measured now');
  const linked = linkedChanges(root, experiment.id);
  const analysis = analyzeComparison(root, project, {
    metricId: planData.metric,
    sourceId: planData.source_id,
    before,
    after: window,
    scope: (planData.scope_pages ?? []).length ? {page: planData.scope_pages} : {},
    linkedChangeIds: [...new Set([...(planData.change_ids ?? []), ...linked.map((change) => change.data.id)])],
    experimentId: experiment.id,
    design: planData.design ?? 'before_after',
    now,
    contextRefs: args.context ?? [],
    analysisKind: 'experiment_evaluation',
    extraIssues,
    baselineCheck: baseline ? {id: baseline.data.id, value: baseline.data.value} : null,
  });
  const threshold = thresholdResult(experiment, analysis.comparison?.after?.value ?? null, analysis.data_quality.level);
  const result = {
    status: 'evaluated',
    experiment_id: experiment.id,
    mission_id: experiment.mission_id,
    marketer_status: experiment.status,
    measured_fingerprint: experiment.fingerprint,
    threshold: {...threshold, success: experiment.definition.success_threshold, failure: experiment.definition.failure_threshold},
    decision_owner: 'marketer7',
    warnings,
    analysis,
  };
  if (args.record) {
    const previous = (planData.evidence_ids ?? []).at(-1) ?? null;
    const changeRecords = linked;
    const record = writeEvidence(root, analysis, {
      title: `${experiment.id} ${analysis.metric.id} evaluation`,
      observation: `${experiment.id} (${experiment.title ?? 'Marketer7 experiment'}): ${analysis.metric.id} over the locked window ${window.start} → ${window.end}, compared with ${before.start} → ${before.end}${(planData.scope_pages ?? []).length ? ` for ${planData.scope_pages.join(', ')}` : ' (site-wide)'}.${warnings.length ? ` Warnings: ${warnings.join(' ')}` : ''}`,
      kind: 'experiment_evaluation',
      experiment,
      threshold,
      assetIds: changeRecords.map((change) => change.data.asset_id).filter(Boolean),
      publicationIds: changeRecords.map((change) => change.data.publication_id).filter(Boolean),
      deploymentIds: changeRecords.map((change) => change.data.deployment_id).filter(Boolean),
      baselineIds: baseline ? [baseline.data.id] : [],
      contextRefs: args.context ?? [],
      supersedes: previous,
    });
    const exported = writeExternalReference(project, record.id, {now});
    updateDocument(target, {status: 'evaluated', evidence_ids: [...(planData.evidence_ids ?? []), record.id], updated_at: now}, `- ${now} — evaluated as ${record.id}${previous ? ` (supersedes ${previous})` : ''}; threshold result ${threshold.result}; export ${exported.relative}\n`);
    result.evidence = {id: record.id, path: relative(project, record.path), supersedes: previous};
    result.export = exported.relative;
  }
  printJson(result);
  return 0;
}

function status(argv) {
  const args = parseArgs(argv, {options: ['project', 'now', 'experiment']});
  if (!/^EX-\d{3,}$/.test(args.experiment ?? '')) throw new UsageError('--experiment EX-NNN is required');
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  const experiment = findMarketerExperiment(project, args.experiment);
  const target = planPath(root, args.experiment);
  const planData = fs.existsSync(target) ? readDocument(target).data : null;
  printJson({experiment_id: args.experiment, marketer: experiment ? {status: experiment.status, fingerprint: experiment.fingerprint, window: experiment.definition.measurement_window, primary_metric: experiment.definition.primary_metric} : null, plan: planData});
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  const commands = {plan, evaluate, status};
  if (!commands[command]) throw new UsageError('experiment.mjs <plan|evaluate|status> --experiment EX-NNN [options]');
  return commands[command](rest);
}

runCli(main);
