#!/usr/bin/env node
// Validate a `.analyzer/` state root.
//
// Usage: node validate-state.mjs [<state-root>|--project <dir>]
// Exit 0 = PASS (warnings allowed), 1 = FAIL. Checks append-only integrity,
// references, the three-axis evidence model, registries, observation hashes,
// and secrets.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {RECORD_KINDS, listDir, parseFrontmatter, parseTimestamp, readMaybeGzipJson, readText, resolveObservationPath, sha256} from './lib/core.mjs';
import zlib from 'node:zlib';
import {ADAPTERS} from './lib/adapters.mjs';
import {findSecrets} from './lib/redact.mjs';
import {CHANGE_ORIGINS, CHANGE_TYPES, TIMESTAMP_BASES} from './lib/records.mjs';
import {OBSERVATION_KINDS, SOURCE_TYPES} from './lib/state.mjs';
import {AGGREGATIONS} from './lib/stats.mjs';

const QUALITY = ['high', 'medium', 'low', 'insufficient'];
const STRENGTH = ['insufficient', 'low', 'medium', 'high'];
const CAUSAL = ['none', 'low', 'medium', 'high'];
const THRESHOLD_RESULTS = new Set(['success_threshold_met', 'failure_threshold_met', 'between_thresholds', 'insufficient_data', 'thresholds_unparseable', 'criteria_changed', 'criteria_not_locked', null]);
const AUTH_KEYS = new Set(['method', 'reference', 'env_vars', 'credentials_file']);

function walk(dir) {
  const files = [];
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export function validateAnalyzerState(root) {
  const errors = [];
  const warnings = [];
  let checks = 0;
  const check = (condition, message) => {
    checks += 1;
    if (!condition) errors.push(message);
    return condition;
  };
  const warn = (condition, message) => {
    if (!condition) warnings.push(message);
  };
  const label = (file) => path.relative(root, file).split(path.sep).join('/');
  if (!check(fs.existsSync(path.join(root, 'project.md')), 'project.md: missing (not an initialized .analyzer root)')) return {checks, errors, warnings};

  const project = parseFrontmatter(readText(path.join(root, 'project.md')));
  if (check(!project.error, `project.md: ${project.error}`)) {
    check(project.data.schema_version === 1, 'project.md: schema_version must be 1');
    check(Boolean(project.data.project_name), 'project.md: project_name is required');
    check(project.data.authority === 'read_only', 'project.md: authority must be read_only (Analyzer7 never modifies production)');
  }

  const json = (name, fallback) => {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return fallback;
    try {
      return JSON.parse(readText(file));
    } catch (error) {
      check(false, `${name}: invalid JSON (${error.message})`);
      return fallback;
    }
  };

  const sources = json('sources.json', {schema_version: 1, sources: []});
  check(sources.schema_version === 1, 'sources.json: schema_version must be 1');
  const sourceIds = new Set();
  for (const source of sources.sources ?? []) {
    check(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(source.id)), `sources.json: source id ${JSON.stringify(source.id)} is not path-safe`);
    check(!sourceIds.has(source.id), `sources.json: duplicate source ${source.id}`);
    sourceIds.add(source.id);
    check(SOURCE_TYPES.has(source.type), `sources.json: ${source.id} has unknown type ${source.type}`);
    if (source.adapter) check(Boolean(ADAPTERS[source.adapter]), `sources.json: ${source.id} has unknown adapter ${source.adapter}`);
    for (const key of Object.keys(source.auth ?? {})) check(AUTH_KEYS.has(key), `sources.json: ${source.id}.auth.${key} is not allowed — store only method, reference, env-var names, and a credentials file path`);
    if (source.auth?.credentials_file) check(!/BEGIN|\{|"private_key"/.test(String(source.auth.credentials_file)), `sources.json: ${source.id}.auth.credentials_file must be a path, not key material`);
  }

  const metrics = json('metrics.json', {schema_version: 1, metrics: [], funnels: []});
  check(metrics.schema_version === 1, 'metrics.json: schema_version must be 1');
  const metricIds = new Set();
  for (const metric of metrics.metrics ?? []) {
    check(!metricIds.has(metric.id), `metrics.json: duplicate metric ${metric.id}`);
    metricIds.add(metric.id);
    check(['active', 'proposed', 'retired'].includes(metric.status ?? 'active'), `metrics.json: ${metric.id} has unknown status ${metric.status}`);
    check(AGGREGATIONS.has(metric.aggregation), `metrics.json: ${metric.id} has unknown aggregation ${metric.aggregation}`);
    if (metric.aggregation === 'ratio_of_sums') check(Boolean(metric.numerator && metric.denominator), `metrics.json: ${metric.id} ratio needs numerator and denominator`);
    if (metric.aggregation === 'weighted_mean') check(Boolean(metric.weight), `metrics.json: ${metric.id} weighted_mean needs weight`);
    if ((metric.status ?? 'active') === 'active') {
      check(Boolean(metric.canonical_source), `metrics.json: active metric ${metric.id} needs a canonical_source`);
      check(Boolean(metric.definition) && !/^TBD/.test(metric.definition), `metrics.json: active metric ${metric.id} needs a definition`);
      if (metric.canonical_source) warn(sourceIds.has(metric.canonical_source), `metrics.json: ${metric.id} canonical source ${metric.canonical_source} is not registered yet`);
    }
    const version = metric.version ?? 1;
    check(Number.isInteger(version) && version >= 1, `metrics.json: ${metric.id} version must be a positive integer`);
    if (version > 1) check((metric.history ?? []).length >= version - 1, `metrics.json: ${metric.id} is version ${version} but history keeps ${(metric.history ?? []).length} prior definition(s) — definitions are never silently replaced`);
  }
  for (const funnel of metrics.funnels ?? []) for (const stage of funnel.stages ?? []) check(metricIds.has(stage), `metrics.json: funnel ${funnel.id} stage ${stage} is not a defined metric`);

  const monitors = json('monitors.json', {schema_version: 1, monitors: []});
  for (const monitor of monitors.monitors ?? []) check(metricIds.has(monitor.metric), `monitors.json: ${monitor.id} watches unknown metric ${monitor.metric}`);

  // Observations: immutable; the recorded hash must still match the rows.
  for (const file of walk(path.join(root, 'observations')).filter((name) => /\.json(\.gz)?$/.test(name))) {
    try {
      const snapshot = readMaybeGzipJson(file);
      check(snapshot.schema_version === 1, `${label(file)}: schema_version must be 1`);
      check(OBSERVATION_KINDS.has(snapshot.kind), `${label(file)}: unknown kind ${snapshot.kind}`);
      check(sourceIds.has(snapshot.source_id), `${label(file)}: source ${snapshot.source_id} is not registered`);
      check(sha256(JSON.stringify(snapshot.rows)) === snapshot.rows_sha256, `${label(file)}: rows no longer match rows_sha256 — observation snapshots are immutable`);
    } catch (error) {
      check(false, `${label(file)}: invalid JSON (${error.message})`);
    }
  }

  // Records and their append-only indexes.
  const ids = {};
  const records = {};
  for (const [kind, {prefix, dir}] of Object.entries(RECORD_KINDS)) {
    ids[kind] = new Set();
    records[kind] = [];
    const directory = path.join(root, dir);
    const files = listDir(directory).filter((entry) => entry.isFile() && new RegExp(`^${prefix}-\\d+-.*\\.md$`).test(entry.name)).map((entry) => entry.name);
    const indexPath = path.join(directory, 'index.md');
    const indexed = new Map();
    if (fs.existsSync(indexPath)) {
      for (const match of readText(indexPath).matchAll(/^- \[([A-Z-]+-\d+)\]\(([^)]+)\)/gm)) indexed.set(match[1], match[2]);
    }
    for (const file of files) {
      const document = parseFrontmatter(readText(path.join(directory, file)));
      if (!check(!document.error, `${dir}/${file}: ${document.error}`)) continue;
      const id = document.data.id;
      check(file.startsWith(`${id}-`), `${dir}/${file}: id ${id} must match the file name`);
      check(!ids[kind].has(id), `${dir}: duplicate id ${id}`);
      ids[kind].add(id);
      check(document.data.schema_version === 1, `${dir}/${file}: schema_version must be 1`);
      check(indexed.get(id) === file, `${dir}/index.md: missing or wrong line for ${id}`);
      records[kind].push({file: `${dir}/${file}`, data: document.data});
    }
    for (const [id, file] of indexed) check(files.includes(file), `${dir}/index.md: ${id} points to ${file}, which no longer exists — records are append-only and must not be deleted`);
  }

  // An artifact may have been compacted (x.json → x.json.gz) or pruned with a tombstone.
  const tombstones = fs.existsSync(path.join(root, 'observations', 'pruned.md')) ? readText(path.join(root, 'observations', 'pruned.md')) : '';
  const exists = (relativePath) => Boolean(resolveObservationPath(path.join(path.dirname(root), relativePath))) || tombstones.includes(relativePath);
  for (const {file, data} of records.evidence) {
    check(QUALITY.includes(data.data_quality), `${file}: data_quality must be one of ${QUALITY.join(', ')}`);
    check(STRENGTH.includes(data.evidence_strength), `${file}: evidence_strength must be one of ${STRENGTH.join(', ')}`);
    check(CAUSAL.includes(data.causal_confidence), `${file}: causal_confidence must be one of ${CAUSAL.join(', ')}`);
    check(Boolean(data.metric) && metricIds.has(data.metric), `${file}: metric ${data.metric} must be in the dictionary`);
    check(Array.isArray(data.source_ids) && data.source_ids.length > 0, `${file}: source_ids are required (provenance)`);
    check(THRESHOLD_RESULTS.has(data.threshold_result), `${file}: unknown threshold_result ${data.threshold_result}`);
    if (data.data_quality === 'insufficient') {
      check(data.evidence_strength === 'insufficient', `${file}: insufficient data quality requires insufficient evidence strength`);
      check(data.causal_confidence === 'none', `${file}: insufficient data quality requires causal confidence none`);
      check(data.delta_abs === null && data.delta_pct === null, `${file}: no delta may be reported from insufficient data`);
    }
    check(QUALITY.indexOf(data.data_quality) <= 3 - STRENGTH.indexOf(data.evidence_strength) || data.evidence_strength === 'insufficient', `${file}: evidence strength ${data.evidence_strength} exceeds what ${data.data_quality} data quality allows`);
    check(CAUSAL.indexOf(data.causal_confidence) <= Math.max(0, STRENGTH.indexOf(data.evidence_strength)), `${file}: causal confidence ${data.causal_confidence} exceeds evidence strength ${data.evidence_strength}`);
    if (data.causal_confidence !== 'none') check((data.change_ids ?? []).length > 0 || Boolean(data.experiment_id), `${file}: causal confidence above none needs a linked change or experiment`);
    for (const id of data.change_ids ?? []) check(ids.change.has(id), `${file}: change ${id} does not exist`);
    for (const id of data.baseline_ids ?? []) check(ids.baseline.has(id), `${file}: baseline ${id} does not exist`);
    if (data.supersedes) check(ids.evidence.has(data.supersedes), `${file}: supersedes ${data.supersedes}, which does not exist`);
    for (const artifact of data.artifacts ?? []) check(exists(artifact), `${file}: artifact ${artifact} does not exist`);
    if (data.experiment_id) check(/^EX-\d{3,}$/.test(data.experiment_id), `${file}: experiment_id must be EX-NNN`);
    if (['success_threshold_met', 'failure_threshold_met', 'between_thresholds'].includes(data.threshold_result) && data.criteria_basis !== undefined) check(data.criteria_basis === 'review_lock' || /^override CO-\d+/.test(String(data.criteria_basis)), `${file}: a threshold result needs locked criteria (criteria_basis ${data.criteria_basis})`);
  }
  for (const {file, data} of records.change) {
    check(CHANGE_ORIGINS.has(data.origin), `${file}: unknown origin ${data.origin}`);
    check(CHANGE_TYPES.has(data.type), `${file}: unknown type ${data.type}`);
    check(TIMESTAMP_BASES.has(data.timestamp_basis), `${file}: unknown timestamp_basis ${data.timestamp_basis}`);
    check(data.timestamp === null || parseTimestamp(data.timestamp) !== null, `${file}: timestamp must be ISO-8601 or null`);
    if (data.supersedes) check(ids.change.has(data.supersedes), `${file}: supersedes ${data.supersedes}, which does not exist`);
  }
  for (const {file, data} of records.baseline) {
    check(metricIds.has(data.metric), `${file}: metric ${data.metric} must be in the dictionary`);
    check(QUALITY.includes(data.data_quality), `${file}: data_quality must be one of ${QUALITY.join(', ')}`);
    if (data.data_quality === 'insufficient') check(data.value === null, `${file}: an insufficient baseline must not carry a value`);
  }
  for (const {file, data} of records.anomaly) check(['open', 'resolved', 'dismissed'].includes(data.status), `${file}: unknown status ${data.status}`);
  for (const {file, data} of records.opportunity) check(['awaiting_review', 'handed_off', 'dismissed', 'resolved'].includes(data.status), `${file}: unknown status ${data.status}`);

  for (const entry of listDir(path.join(root, 'experiments'))) {
    const planPath = path.join(root, 'experiments', entry.name, 'plan.md');
    if (!entry.isDirectory() || !fs.existsSync(planPath)) continue;
    const plan = parseFrontmatter(readText(planPath));
    if (!check(!plan.error, `experiments/${entry.name}/plan.md: ${plan.error}`)) continue;
    check(plan.data.experiment_id === entry.name, `experiments/${entry.name}/plan.md: experiment_id must match the folder`);
    if (plan.data.baseline_id) check(ids.baseline.has(plan.data.baseline_id), `experiments/${entry.name}/plan.md: baseline ${plan.data.baseline_id} does not exist`);
    for (const id of plan.data.evidence_ids ?? []) check(ids.evidence.has(id), `experiments/${entry.name}/plan.md: evidence ${id} does not exist`);
  }
  for (const file of walk(path.join(root, 'exports')).filter((name) => name.endsWith('.md'))) {
    const document = parseFrontmatter(readText(file));
    if (!check(!document.error, `${label(file)}: ${document.error}`)) continue;
    check(document.data.contract === 'external-evidence-reference/v1', `${label(file)}: unsupported contract ${document.data.contract}`);
    check(ids.evidence.has(document.data.external_evidence_id), `${label(file)}: ${document.data.external_evidence_id} does not exist`);
  }

  for (const file of walk(root)) {
    const found = findSecrets(file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : readText(file));
    check(found.length === 0, `${label(file)}: possible secret or personal data (${found.join(', ')}) — Analyzer7 state must not hold credentials or unnecessary PII`);
  }
  return {checks, errors, warnings};
}

// Compare real paths: installed skills are symlinks, and Node reports the
// resolved module path while argv[1] keeps the symlinked one.
const invokedDirectly = Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const projectIndex = argv.indexOf('--project');
  const root = projectIndex !== -1 ? path.join(path.resolve(argv[projectIndex + 1]), '.analyzer') : path.resolve(argv[0] ?? '.analyzer');
  const result = validateAnalyzerState(root);
  for (const warning of result.warnings) console.log(`warning — ${warning}`);
  if (result.errors.length) {
    console.error(`FAIL — Analyzer7 state validation (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}, ${result.checks} checks)`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS — Analyzer7 state validation (${result.checks} checks)`);
  }
}
