// Read-only readers for neighbor harness state in the same project.
//
// Analyzer7 never writes `.marketer/`, `.signal/`, `.hyper/`, or `.scout/`.
// Every reader tolerates absent roots, legacy files without the optional
// cross-harness metadata, and unknown additive fields; it rejects (with a
// warning, not a crash) an unknown contract major version.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {listDir, parseFrontmatter, readText} from './core.mjs';

function safeDocument(filePath) {
  try {
    return parseFrontmatter(readText(filePath));
  } catch (error) {
    return {data: null, body: '', error: error.message};
  }
}

function rel(project, filePath) {
  return path.relative(project, filePath).split(path.sep).join('/');
}

function section(body, heading) {
  const match = body.match(new RegExp(`^## ${heading}\\s*$`, 'm'));
  if (!match) return null;
  const rest = body.slice(match.index + match[0].length);
  const next = rest.search(/\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function tableFields(text) {
  const fields = {};
  for (const line of (text ?? '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => /^:?-{3,}:?$/.test(cell)) || cells[0] === 'Field') continue;
    fields[cells[0].toLowerCase().replace(/\s+/g, '_')] = cells[1].replace(/^`|`$/g, '');
  }
  return fields;
}

function markdownTable(text) {
  const rows = [];
  let headers = null;
  for (const line of (text ?? '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (!headers) {
      headers = cells.map((cell) => cell.toLowerCase().replace(/\s+/g, '_'));
      continue;
    }
    rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
  }
  return rows;
}

// ---------- Marketer7 ----------

// Identical to Marketer7's validator: SHA-256 of the definition from
// `## Hypothesis` up to `## Criteria lock`, lines right-trimmed.
export function marketerFingerprint(body) {
  const start = body.indexOf('## Hypothesis');
  const end = body.indexOf('## Criteria lock');
  if (start === -1 || end === -1 || end <= start) return null;
  const canonical = body.slice(start, end).replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function readMarketer(project) {
  const root = path.join(project, '.marketer');
  if (!fs.existsSync(root)) return {present: false, missions: [], experiments: [], warnings: []};
  const warnings = [];
  const missions = [];
  for (const entry of listDir(path.join(root, 'missions'))) {
    if (!entry.isDirectory() || !/^M\d+-/.test(entry.name)) continue;
    const filePath = path.join(root, 'missions', entry.name, 'mission.md');
    if (!fs.existsSync(filePath)) continue;
    const document = safeDocument(filePath);
    if (document.error) {
      warnings.push(`${rel(project, filePath)}: ${document.error}`);
      continue;
    }
    missions.push({id: document.data.id, title: document.data.title ?? null, status: document.data.status ?? null, primary_kpi: document.data.primary_kpi ?? null, path: rel(project, filePath)});
  }
  const experiments = [];
  for (const entry of listDir(path.join(root, 'experiments'))) {
    if (!entry.isDirectory() || !/^EX-\d+/.test(entry.name)) continue;
    const experiment = readMarketerExperimentDir(project, path.join(root, 'experiments', entry.name));
    if (experiment.error) warnings.push(experiment.error);
    else experiments.push(experiment);
  }
  experiments.sort((a, b) => a.id.localeCompare(b.id));
  return {present: true, missions, experiments, warnings};
}

function readMarketerExperimentDir(project, directory) {
  const filePath = path.join(directory, 'experiment.md');
  if (!fs.existsSync(filePath)) return {error: `${rel(project, directory)}: missing experiment.md`};
  const document = safeDocument(filePath);
  if (document.error) return {error: `${rel(project, filePath)}: ${document.error}`};
  const fields = tableFields(section(document.body, 'Definition'));
  const reviewPath = path.join(directory, 'review.md');
  const review = fs.existsSync(reviewPath) ? safeDocument(reviewPath) : null;
  const fingerprint = marketerFingerprint(document.body);
  const lockedFingerprint = review?.data?.criteria_fingerprint ?? null;
  return {
    id: document.data.id,
    mission_id: document.data.mission_id ?? null,
    title: document.data.title ?? null,
    status: document.data.status ?? null,
    criteria_locked_at: document.data.criteria_locked_at ?? null,
    hypothesis: section(document.body, 'Hypothesis'),
    definition: {
      audience: fields.audience ?? null,
      channel: fields.channel ?? null,
      action_type: fields.action_type ?? null,
      executor: fields.executor ?? null,
      primary_metric: fields.primary_metric ?? null,
      primary_kpi_tier: fields.primary_kpi_tier ?? null,
      secondary_metrics: fields.secondary_metrics ?? null,
      baseline: fields.baseline ?? null,
      success_threshold: fields.success_threshold ?? null,
      failure_threshold: fields.failure_threshold ?? null,
      measurement_window: fields.measurement_window ?? null,
      tracking: fields.tracking ?? null,
    },
    fingerprint,
    locked_fingerprint: lockedFingerprint,
    definition_matches_review: lockedFingerprint ? lockedFingerprint === fingerprint : null,
    path: rel(project, filePath),
  };
}

export function findMarketerExperiment(project, experimentId) {
  const marketer = readMarketer(project);
  return marketer.experiments.find((experiment) => experiment.id === experimentId) ?? null;
}

// ---------- Signal7 ----------

// publish-log.md is an append-only YAML list: `- key: value` starts an entry,
// indented `key: value` lines continue it, one nested level (tracking).
export function parsePublishLog(text) {
  const entries = [];
  let current = null;
  let nestedKey = null;
  for (const line of text.split('\n')) {
    const start = line.match(/^-\s+([A-Za-z_][\w-]*):\s?(.*)$/);
    if (start) {
      current = {[start[1]]: unquote(start[2])};
      entries.push(current);
      nestedKey = null;
      continue;
    }
    if (!current) continue;
    const field = line.match(/^(\s+)([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!field) continue;
    const indent = field[1].length;
    if (indent <= 2) {
      nestedKey = field[3].trim() === '' ? field[2] : null;
      current[field[2]] = nestedKey ? {} : unquote(field[3]);
    } else if (nestedKey) {
      current[nestedKey][field[2]] = unquote(field[3]);
    }
  }
  return entries;
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text === 'null' || text === '') return null;
  return text.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

const SIGNAL_RESULT_CONTRACT = 'signal7-execution-result/v1';

function readSignalTask(project, directory, warnings) {
  const taskPath = path.join(directory, 'task.md');
  if (!fs.existsSync(taskPath)) return null;
  const task = safeDocument(taskPath);
  if (task.error) {
    warnings.push(`${rel(project, taskPath)}: ${task.error}`);
    return null;
  }
  const assets = {};
  for (const entry of listDir(directory)) {
    if (!entry.isFile() || !/^A\d+-.*\.md$/.test(entry.name)) continue;
    const assetPath = path.join(directory, entry.name);
    const text = readText(assetPath);
    const asset = parseFrontmatter(text);
    if (asset.error) {
      warnings.push(`${rel(project, assetPath)}: ${asset.error}`);
      continue;
    }
    const hashes = [...text.matchAll(/content_hash:\s*(sha256:[0-9a-f]+)/g)].map((match) => match[1]);
    assets[asset.data.id] = {id: asset.data.id, title: asset.data.title ?? null, channel: asset.data.channel ?? null, asset_type: asset.data.asset_type ?? null, status: asset.data.status ?? null, mission_id: asset.data.mission_id ?? null, experiment_id: asset.data.experiment_id ?? null, content_hash: hashes.at(-1) ?? null, path: rel(project, assetPath)};
  }
  let result = null;
  const resultPath = path.join(directory, 'execution-result.md');
  if (fs.existsSync(resultPath)) {
    const document = safeDocument(resultPath);
    if (document.error) {
      warnings.push(`${rel(project, resultPath)}: ${document.error}`);
    } else if (document.data.contract && document.data.contract !== SIGNAL_RESULT_CONTRACT) {
      warnings.push(`${rel(project, resultPath)}: unsupported contract ${document.data.contract}; expected ${SIGNAL_RESULT_CONTRACT} — ignored`);
    } else {
      result = {status: document.data.status ?? null, events: markdownTable(section(document.body, 'Events')), path: rel(project, resultPath)};
    }
  }
  const logPath = path.join(directory, 'publish-log.md');
  const ledger = fs.existsSync(logPath) ? parsePublishLog(readText(logPath)) : [];
  return {
    id: task.data.id,
    title: task.data.title ?? null,
    phase: task.data.phase ?? null,
    source_system: task.data.source_system ?? null,
    mission_id: task.data.mission_id ?? null,
    experiment_id: task.data.experiment_id ?? null,
    tracking: task.nested?.tracking ?? null,
    assets,
    result,
    ledger,
    ledger_path: fs.existsSync(logPath) ? rel(project, logPath) : null,
    path: rel(project, taskPath),
  };
}

export function readSignal(project) {
  const root = path.join(project, '.signal');
  if (!fs.existsSync(root)) return {present: false, tasks: [], publications: [], warnings: []};
  const warnings = [];
  const tasks = [];
  for (const container of ['tasks', 'archive']) {
    for (const entry of listDir(path.join(root, container))) {
      if (!entry.isDirectory() || !/^S\d+-/.test(entry.name)) continue;
      const task = readSignalTask(project, path.join(root, container, entry.name), warnings);
      if (task) tasks.push(task);
    }
  }
  return {present: true, tasks, publications: publications(tasks), warnings};
}

// Published assets = publish-ledger rows with status `published`, enriched
// with the execution-result event (publication URL) and asset metadata.
// An execution-result event without a ledger row is still a publication.
function publications(tasks) {
  const list = [];
  for (const task of tasks) {
    const events = task.result?.events ?? [];
    const seen = new Set();
    for (const row of task.ledger) {
      if (row.status !== 'published') continue;
      const asset = task.assets[row.asset_id] ?? {};
      const event = events.find((item) => item.asset_id === row.asset_id && item.status === 'published');
      seen.add(row.asset_id);
      list.push({
        ref: `signal7:${task.id}/${row.asset_id}`,
        task_id: task.id,
        asset_id: row.asset_id,
        title: asset.title ?? task.title,
        channel: row.channel ?? asset.channel ?? null,
        asset_type: asset.asset_type ?? null,
        published_at: row.actual_publish_time ?? row.timestamp ?? null,
        publication_url: event && event.publication_url && event.publication_url !== 'unknown' ? event.publication_url : null,
        idempotency_key: row.idempotency_key ?? null,
        content_hash: asset.content_hash ?? null,
        mission_id: row.mission_id ?? asset.mission_id ?? task.mission_id ?? null,
        experiment_id: row.experiment_id ?? asset.experiment_id ?? task.experiment_id ?? null,
        tracking: row.tracking ?? task.tracking ?? null,
        source_path: task.ledger_path,
      });
    }
    for (const event of events) {
      if (event.status !== 'published' || seen.has(event.asset_id)) continue;
      const asset = task.assets[event.asset_id] ?? {};
      list.push({
        ref: `signal7:${task.id}/${event.asset_id}`,
        task_id: task.id,
        asset_id: event.asset_id,
        title: asset.title ?? task.title,
        channel: event.channel ?? asset.channel ?? null,
        asset_type: asset.asset_type ?? null,
        published_at: event.timestamp ?? null,
        publication_url: event.publication_url && event.publication_url !== 'unknown' ? event.publication_url : null,
        idempotency_key: null,
        content_hash: asset.content_hash ?? null,
        mission_id: task.mission_id,
        experiment_id: task.experiment_id,
        tracking: task.tracking,
        source_path: task.result.path,
      });
    }
  }
  return list;
}

// ---------- Hyper7 ----------

// Hyper tasks carry no completion or deploy timestamp. Imported Hyper changes
// are therefore unconfirmed, with their timing basis recorded explicitly.
export function readHyper(project) {
  const root = path.join(project, '.hyper');
  if (!fs.existsSync(root)) return {present: false, tasks: [], loops: [], warnings: []};
  const warnings = [];
  const tasks = [];
  for (const container of ['tasks', 'archive']) {
    for (const entry of listDir(path.join(root, container))) {
      const match = /^(?:E\d+)?T(\d+)-/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      const taskPath = path.join(root, container, entry.name, 'task.md');
      if (!fs.existsSync(taskPath)) continue;
      const document = safeDocument(taskPath);
      if (document.error) {
        warnings.push(`${rel(project, taskPath)}: ${document.error}`);
        continue;
      }
      tasks.push({id: document.data.id ?? `T${match[1]}`, title: document.data.title ?? entry.name, phase: document.data.phase ?? null, scope: document.data.scope ?? null, bugfix: document.data.bugfix ?? null, created: document.data.created ?? null, path: rel(project, taskPath)});
    }
  }
  const loops = [];
  for (const entry of listDir(path.join(root, 'loops'))) {
    if (!entry.isDirectory() || !/^L\d+-/.test(entry.name)) continue;
    const loopPath = path.join(root, 'loops', entry.name, 'loop.md');
    if (!fs.existsSync(loopPath)) continue;
    const document = safeDocument(loopPath);
    if (document.error) {
      warnings.push(`${rel(project, loopPath)}: ${document.error}`);
      continue;
    }
    loops.push({id: document.data.id, title: document.data.title ?? entry.name, status: document.data.status ?? null, created: document.data.created ?? null, updated: document.data.updated ?? null, path: rel(project, loopPath)});
  }
  return {present: true, tasks, loops, warnings};
}

// ---------- Scout7 ----------

export function readScout(project) {
  const root = path.join(project, '.scout');
  if (!fs.existsSync(root)) return {present: false, batches: [], warnings: []};
  const warnings = [];
  const batches = [];
  for (const entry of listDir(path.join(root, 'batches'))) {
    if (!entry.isDirectory() || !/^R\d+-/.test(entry.name)) continue;
    const batchPath = path.join(root, 'batches', entry.name, 'batch.md');
    if (!fs.existsSync(batchPath)) continue;
    const document = safeDocument(batchPath);
    if (document.error) {
      warnings.push(`${rel(project, batchPath)}: ${document.error}`);
      continue;
    }
    batches.push({ref: `scout7:${document.data.id}`, id: document.data.id, title: document.data.title ?? null, phase: document.data.phase ?? null, opened: document.data.opened ?? null, path: rel(project, batchPath)});
  }
  const log = path.join(root, 'context', 'territory-checks-log.md');
  return {present: true, batches, territory_log: fs.existsSync(log) ? rel(project, log) : null, warnings};
}

export function discoverNeighbors(project) {
  return {marketer7: readMarketer(project), signal7: readSignal(project), hyper7: readHyper(project), scout7: readScout(project)};
}
