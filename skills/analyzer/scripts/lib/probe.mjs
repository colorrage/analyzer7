// Read-only resume snapshot: everything a new session needs to continue the
// analytical work without re-reading history. Built from indexes, frontmatter,
// and registries; never loads observation rows or full evidence bodies.

import fs from 'node:fs';
import path from 'node:path';
import {RECORD_KINDS, isoDate, listDir, listRecords, nextId, parsePeriod, parseTimestamp, readDocument, readIndex, stateRoot} from './core.mjs';
import {discoverNeighbors} from './neighbors.mjs';
import {sourceHealth} from './quality.mjs';
import {loadMetrics, loadMonitors, loadProject, loadSources} from './state.mjs';

const ACTIVE_MARKETER_STATUSES = new Set(['approved', 'running', 'measurement_pending', 'evaluating']);
const RECENT = 5;

export function readPlans(root) {
  const plans = [];
  for (const entry of listDir(path.join(root, 'experiments'))) {
    const planPath = path.join(root, 'experiments', entry.name, 'plan.md');
    if (!entry.isDirectory() || !fs.existsSync(planPath)) continue;
    const document = readDocument(planPath);
    if (!document.error) plans.push({...document.data, path: planPath});
  }
  return plans;
}

function experimentView(marketerExperiment, plan, sources, nowMs) {
  const window = plan ? {start: plan.window_start, end: plan.window_end} : parsePeriod(marketerExperiment?.definition?.measurement_window);
  const sourceId = plan?.source_id ?? null;
  const source = sources.find((entry) => entry.id === sourceId) ?? null;
  const windowClosed = window ? nowMs > Date.parse(`${window.end}T23:59:59Z`) : null;
  const dataThrough = source?.data_through ? isoDate(source.data_through) : null;
  const dataCovers = window && dataThrough ? dataThrough >= window.end : null;
  const evaluated = plan?.status === 'evaluated';
  let next;
  if (!marketerExperiment) next = 'Marketer7 definition not found — the plan is orphaned; confirm the experiment ID';
  else if (marketerExperiment.definition_matches_review === false) next = `definition changed after the Marketer7 review lock — ask Marketer7 before measuring ${marketerExperiment.id}`;
  else if (!plan) next = `create a measurement plan and baseline for ${marketerExperiment.id}`;
  else if (!plan.baseline_id) next = `record the baseline for ${marketerExperiment.id}`;
  else if (evaluated) next = `evaluated (${(plan.evidence_ids ?? []).join(', ')}); awaiting Marketer7 decision`;
  else if (!windowClosed) next = `wait: measurement window closes ${window?.end}`;
  else if (dataCovers === false) next = `refresh ${sourceId}: data only through ${dataThrough}, window ends ${window.end}`;
  else next = `evaluate ${marketerExperiment.id}: window closed ${window.end}`;
  return {
    id: marketerExperiment?.id ?? plan?.experiment_id,
    mission_id: marketerExperiment?.mission_id ?? plan?.mission_id ?? null,
    marketer_status: marketerExperiment?.status ?? 'missing',
    analyzer_status: plan?.status ?? 'unplanned',
    primary_metric: marketerExperiment?.definition?.primary_metric ?? plan?.metric ?? null,
    window,
    window_closed: windowClosed,
    evidence_ids: plan?.evidence_ids ?? [],
    next,
    ready_to_evaluate: Boolean(plan && plan.baseline_id && !evaluated && windowClosed && dataCovers !== false && marketerExperiment),
  };
}

export function probe(project, now) {
  const root = stateRoot(project);
  const nowMs = parseTimestamp(now);
  const neighbors = discoverNeighbors(project);
  const neighborPresence = Object.fromEntries(Object.entries(neighbors).map(([key, value]) => [key, value.present]));
  if (!fs.existsSync(path.join(root, 'project.md'))) {
    return {initialized: false, state_root: root, now, neighbors: neighborPresence, next_action: 'initialize Analyzer7 with init.mjs (safe: writes only .analyzer/)', warnings: []};
  }
  const warnings = [];
  const projectData = loadProject(root);
  const {sources} = loadSources(root);
  const {metrics} = loadMetrics(root);
  const {monitors} = loadMonitors(root);

  const sourceViews = sources.map((source) => {
    const health = sourceHealth(source, nowMs);
    if (health.warning && health.health !== 'ok') warnings.push(`${source.id}: ${health.warning}`);
    return {id: source.id, type: source.type, health: health.health, data_through: source.data_through ?? null, last_success_at: source.last_success_at ?? null, age_hours: health.age_hours ?? null, age_days: health.age_days ?? null, warning: health.health === 'ok' ? null : health.warning};
  });

  const plans = readPlans(root);
  const marketerExperiments = neighbors.marketer7.experiments;
  const experimentIds = new Set([...marketerExperiments.filter((experiment) => ACTIVE_MARKETER_STATUSES.has(experiment.status)).map((experiment) => experiment.id), ...plans.map((plan) => plan.experiment_id)]);
  const experiments = [...experimentIds].sort().map((id) => experimentView(marketerExperiments.find((experiment) => experiment.id === id), plans.find((plan) => plan.experiment_id === id), sources, nowMs));

  const evidenceIndex = readIndex(root, 'evidence');
  const changeRecords = listRecords(root, 'change');
  const anomalies = listRecords(root, 'anomaly').map((record) => record.data);
  const opportunities = listRecords(root, 'opportunity').map((record) => record.data);
  const openAnomalies = anomalies.filter((anomaly) => anomaly.status === 'open');
  const awaiting = opportunities.filter((opportunity) => opportunity.status === 'awaiting_review');
  const reports = listDir(path.join(root, 'reports')).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
  const proposedMetrics = metrics.filter((metric) => metric.status === 'proposed').map((metric) => metric.id);
  const unconfirmedChanges = changeRecords.filter((change) => change.data.confirmed === false && change.data.deploy_status !== 'pending' && !changeRecords.some((other) => other.data.supersedes === change.data.id)).map((change) => change.data.id);
  const supersededIds = new Set(changeRecords.map((change) => change.data.supersedes).filter(Boolean));
  const liveRecords = changeRecords.filter((change) => !supersededIds.has(change.data.id));
  const pendingDeploy = liveRecords.filter((change) => change.data.deploy_status === 'pending').map((change) => change.data.id);
  const unknownTiming = liveRecords.filter((change) => change.data.deploy_status !== 'pending' && parseTimestamp(change.data.timestamp) === null).map((change) => change.data.id);

  for (const neighbor of Object.values(neighbors)) for (const warning of neighbor.warnings ?? []) warnings.push(warning);

  // Deterministic priority for the next analytical action.
  const unavailable = sourceViews.filter((source) => source.health === 'unavailable');
  const stale = sourceViews.filter((source) => source.health === 'stale');
  const ready = experiments.filter((experiment) => experiment.ready_to_evaluate);
  const needsPlan = experiments.filter((experiment) => experiment.analyzer_status === 'unplanned' && experiment.marketer_status !== 'missing');
  let nextAction;
  if (sources.length === 0) nextAction = 'register the available data sources (record.mjs source); nothing can be measured yet';
  else if (unavailable.length) nextAction = `check source access: ${unavailable.map((source) => source.id).join(', ')} unavailable — analysis using them is degraded`;
  else if (ready.length) nextAction = ready[0].next;
  else if (openAnomalies.length) nextAction = `review open anomaly ${openAnomalies[0].id} (${openAnomalies[0].metric})`;
  else if (needsPlan.length) nextAction = needsPlan[0].next;
  else if (stale.length) nextAction = `refresh stale source data: ${stale.map((source) => source.id).join(', ')}`;
  else if (awaiting.length) nextAction = `hand ${awaiting.length} SEO opportunit${awaiting.length === 1 ? 'y' : 'ies'} to Marketer7 for review`;
  else if (proposedMetrics.length) nextAction = `confirm proposed metric definitions: ${proposedMetrics.join(', ')}`;
  else if (monitors.length) nextAction = 'run the monitor pass (analyze.mjs monitor)';
  else nextAction = 'run an audit to establish baselines (recipes: growth-baseline or seo-audit)';

  return {
    initialized: true,
    state_root: root,
    now,
    project: {name: projectData.project_name, timezone: projectData.timezone ?? 'UTC', authority: projectData.authority ?? 'read_only'},
    sources: sourceViews,
    metrics: {count: metrics.length, active: metrics.filter((metric) => metric.status !== 'proposed').map((metric) => metric.id), proposed: proposedMetrics},
    experiments,
    evidence: {count: evidenceIndex.length, recent: evidenceIndex.slice(-RECENT)},
    changes: {count: changeRecords.length, recent: readIndex(root, 'change').slice(-RECENT), unconfirmed: unconfirmedChanges, unknown_timing: unknownTiming, pending_deploy: pendingDeploy},
    anomalies: {open: openAnomalies.map((anomaly) => ({id: anomaly.id, metric: anomaly.metric, severity: anomaly.severity, detected_at: anomaly.detected_at})), total: anomalies.length},
    seo: {opportunities_awaiting_review: awaiting.length, opportunities: awaiting.slice(-RECENT).map((opportunity) => ({id: opportunity.id, type: opportunity.type, query: opportunity.query ?? null, page: opportunity.page ?? null}))},
    monitors: monitors.length,
    reports: {count: reports.length, latest: reports.at(-1) ?? null},
    memory: fs.existsSync(path.join(root, 'memory.md')),
    neighbors: neighborPresence,
    next_ids: Object.fromEntries(Object.keys(RECORD_KINDS).map((kind) => [kind, nextId(root, kind)])),
    next_action: nextAction,
    warnings,
  };
}

const pad = (text, width) => String(text).padEnd(width);

export function renderResume(snapshot) {
  if (!snapshot.initialized) return `ANALYZER7 RESUME\n\nNot initialized in this project.\nNeighbors: ${Object.entries(snapshot.neighbors).filter(([, present]) => present).map(([name]) => name).join(', ') || 'none'}\nNext analytical action:\n  ${snapshot.next_action}\n`;
  const lines = ['ANALYZER7 RESUME', '', `Project: ${snapshot.project.name} (timezone ${snapshot.project.timezone}, authority ${snapshot.project.authority})`, '', 'Data health:'];
  if (snapshot.sources.length === 0) lines.push('  no sources registered');
  for (const source of snapshot.sources) {
    const detail = source.health === 'stale' ? `stale ${source.age_days} days (data through ${source.data_through})` : source.health === 'ok' ? `OK (data through ${source.data_through ?? source.last_success_at})` : source.health;
    lines.push(`  ${pad(source.id, 12)} ${detail}`);
  }
  lines.push('', 'Active experiments:');
  if (snapshot.experiments.length === 0) lines.push('  none');
  for (const experiment of snapshot.experiments) lines.push(`  ${pad(experiment.id, 8)} ${experiment.marketer_status}/${experiment.analyzer_status} — ${experiment.next}`);
  lines.push('', `Recent evidence (${snapshot.evidence.count} total):`);
  if (snapshot.evidence.recent.length === 0) lines.push('  none');
  for (const entry of snapshot.evidence.recent) lines.push(`  ${entry.id} ${entry.summary}`);
  lines.push('', `Changes: ${snapshot.changes.count} registered, ${snapshot.changes.unconfirmed.length} unconfirmed, ${snapshot.changes.unknown_timing.length} with unknown timing, ${snapshot.changes.pending_deploy.length} applied but not deployed`);
  lines.push(`Anomalies: ${snapshot.anomalies.open.length} unresolved${snapshot.anomalies.open.length ? ` (${snapshot.anomalies.open.map((anomaly) => anomaly.id).join(', ')})` : ''}`);
  lines.push(`SEO: ${snapshot.seo.opportunities_awaiting_review} opportunit${snapshot.seo.opportunities_awaiting_review === 1 ? 'y' : 'ies'} awaiting review`);
  if (snapshot.metrics.proposed.length) lines.push(`Metrics awaiting confirmation: ${snapshot.metrics.proposed.join(', ')}`);
  if (snapshot.warnings.length) lines.push('', 'Warnings:', ...snapshot.warnings.map((warning) => `  - ${warning}`));
  lines.push('', 'Next analytical action:', `  ${snapshot.next_action}`, '');
  return lines.join('\n');
}
