// Registry and observation access for a `.analyzer/` state root.

import fs from 'node:fs';
import path from 'node:path';
import {UsageError, isoDate, listDir, readDocument, readJson, readMaybeGzipJson, writeJson} from './core.mjs';

export const SOURCE_TYPES = new Set(['analytics', 'search', 'revenue', 'product', 'ranking', 'performance', 'crawl', 'indexation', 'crm', 'email', 'social', 'logs', 'harness', 'custom']);
export const OBSERVATION_KINDS = new Set(['gsc_rows', 'timeseries', 'rankings', 'crawl', 'cwv', 'indexation']);

export function loadProject(root) {
  const document = readDocument(path.join(root, 'project.md'));
  if (document.error) throw new UsageError(`project.md: ${document.error}`);
  return document.data;
}

export function loadSources(root) {
  return readJson(path.join(root, 'sources.json'), {schema_version: 1, sources: []});
}

export function saveSources(root, registry) {
  writeJson(path.join(root, 'sources.json'), registry);
}

export function getSource(root, sourceId) {
  return loadSources(root).sources.find((source) => source.id === sourceId) ?? null;
}

export function updateSource(root, sourceId, changes) {
  const registry = loadSources(root);
  const source = registry.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new UsageError(`source ${sourceId} is not registered in sources.json`);
  Object.assign(source, changes);
  saveSources(root, registry);
  return source;
}

export function loadMetrics(root) {
  return readJson(path.join(root, 'metrics.json'), {schema_version: 1, metrics: [], funnels: []});
}

// Resolve by id or alias. Proposed metrics are returned but flagged: they are
// not usable as evidence until a human confirms them (status: active).
export function getMetric(root, idOrAlias) {
  const {metrics} = loadMetrics(root);
  return metrics.find((metric) => metric.id === idOrAlias) ?? metrics.find((metric) => (metric.aliases ?? []).includes(idOrAlias)) ?? null;
}

export function loadMonitors(root) {
  return readJson(path.join(root, 'monitors.json'), {schema_version: 1, monitors: []});
}

export const DEFAULT_SEO_CONFIG = {
  schema_version: 1,
  property: null,
  segments: [],
  thresholds: {
    quick_win_position_min: 4,
    quick_win_position_max: 15,
    striking_distance_min: 15,
    striking_distance_max: 30,
    min_impressions: 100,
    high_impressions: 500,
    ctr_gap_ratio: 0.5,
    cannibalization_min_share: 0.1,
    cannibalization_min_impressions: 50,
    cannibalization_max_position: 20,
    max_recorded_per_type: 10,
    ranking_loss_alert: 10,
    decline_pct: 20,
    min_clicks_for_decline: 20,
  },
  // Heuristic expected CTR (%) by rounded position. It is a flagging aid for
  // "unusually low CTR", not a forecast. Projects should override it with a
  // curve fitted to their own GSC data when available.
  expected_ctr_curve: {1: 27, 2: 15, 3: 10, 4: 7, 5: 5.5, 6: 4.2, 7: 3.4, 8: 2.8, 9: 2.4, 10: 2.1, 11: 1.6, 12: 1.4, 13: 1.2, 14: 1.1, 15: 1.0, 20: 0.6, 30: 0.3},
};

export function loadSeoConfig(root) {
  const stored = readJson(path.join(root, 'seo', 'config.json'), {});
  return {
    ...DEFAULT_SEO_CONFIG,
    ...stored,
    thresholds: {...DEFAULT_SEO_CONFIG.thresholds, ...(stored.thresholds ?? {})},
    expected_ctr_curve: stored.expected_ctr_curve ?? DEFAULT_SEO_CONFIG.expected_ctr_curve,
  };
}

// ---------- observations ----------

export function observationDir(root, sourceId) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(sourceId))) throw new UsageError(`unsafe source id ${JSON.stringify(sourceId)}`);
  return path.join(root, 'observations', sourceId);
}

export function listObservations(root, {sourceId = null, kind = null} = {}) {
  const base = path.join(root, 'observations');
  const sourceDirs = sourceId ? [sourceId] : listDir(base).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const snapshots = [];
  for (const dir of sourceDirs) {
    for (const entry of listDir(path.join(base, dir))) {
      if (!entry.isFile() || !/\.json(\.gz)?$/.test(entry.name)) continue;
      const filePath = path.join(base, dir, entry.name);
      const snapshot = readMaybeGzipJson(filePath);
      if (kind && snapshot.kind !== kind) continue;
      snapshots.push({...snapshot, file: path.relative(path.dirname(root), filePath).split(path.sep).join('/'), absolute_path: filePath});
    }
  }
  return snapshots.sort((left, right) => String(left.retrieved_at).localeCompare(String(right.retrieved_at)) || left.file.localeCompare(right.file));
}

function overlaps(snapshotPeriod, period) {
  if (!snapshotPeriod) return false;
  return snapshotPeriod.start <= period.end && snapshotPeriod.end >= period.start;
}

// Rows for a source/kind/period, from ONE dimension grain (a date-only site
// pull and a date×page pull are never mixed). `require` / `exclude` constrain
// the dimensions; among eligible grains the one covering the most days wins
// (ties: most recently retrieved). Within the grain, each day comes from the
// most recently retrieved snapshot that has it, so re-pulls supersede instead
// of double-counting. Undated aggregate rows answer only when a snapshot's
// period equals the requested period exactly.
export function selectRows(root, {sourceId, kind, period, files = null, require = [], exclude = []}) {
  let snapshots = listObservations(root, {sourceId, kind});
  if (files) {
    const wanted = new Set(files.map((file) => path.resolve(file)));
    snapshots = snapshots.filter((snapshot) => wanted.has(snapshot.absolute_path) || files.includes(snapshot.file));
  }
  const eligible = (snapshot) => require.every((dimension) => (snapshot.dimensions ?? []).includes(dimension)) && !exclude.some((dimension) => (snapshot.dimensions ?? []).includes(dimension));
  const candidates = snapshots.filter((snapshot) => overlaps(snapshot.period, period) && eligible(snapshot));
  const signature = (snapshot) => [...(snapshot.dimensions ?? [])].sort().join(',');
  const dated = candidates.filter((snapshot) => (snapshot.dimensions ?? []).includes('date'));
  if (dated.length > 0) {
    const groups = new Map();
    for (const snapshot of dated) {
      const key = signature(snapshot);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(snapshot);
    }
    let best = null;
    for (const group of groups.values()) {
      const covered = new Set(group.flatMap((snapshot) => snapshot.rows.map((row) => isoDate(row.date)).filter((date) => date && date >= period.start && date <= period.end)));
      const latest = group.map((snapshot) => String(snapshot.retrieved_at)).sort().at(-1);
      if (!best || covered.size > best.covered || (covered.size === best.covered && latest > best.latest)) best = {group, covered: covered.size, latest};
    }
    // Ownership is per date AND partition (the snapshot's fixed filters, plus
    // the series and segment of timeseries rows): a re-pull of the same slice
    // supersedes it, while different series or segments are kept side by side.
    const partition = (snapshot, row) => JSON.stringify([isoDate(row.date), Object.entries(snapshot.filters ?? {}).sort(), snapshot.kind === 'timeseries' ? row.metric ?? null : null, row.segment ?? null]);
    const owner = new Map();
    for (const snapshot of best.group) {
      for (const row of snapshot.rows) {
        const date = isoDate(row.date);
        if (date && date >= period.start && date <= period.end) owner.set(partition(snapshot, row), snapshot);
      }
    }
    const used = new Set(owner.values());
    const rows = [];
    for (const snapshot of used) {
      for (const row of snapshot.rows) {
        const date = isoDate(row.date);
        if (date && date >= period.start && date <= period.end && owner.get(partition(snapshot, row)) === snapshot) rows.push(row);
      }
    }
    return {rows, snapshots: [...used].map(stripRows), expectDaily: true, dimensions: best.group[0].dimensions ?? []};
  }
  const exact = candidates.filter((snapshot) => snapshot.period.start === period.start && snapshot.period.end === period.end).at(-1);
  if (exact) return {rows: exact.rows, snapshots: [stripRows(exact)], expectDaily: false, dimensions: exact.dimensions ?? []};
  const partial = candidates.map(stripRows);
  return {rows: [], snapshots: partial, expectDaily: false, dimensions: [], note: partial.length ? 'only undated snapshots with a different period exist; they cannot be split into this period' : 'no snapshot covers this period'};
}

export function stripRows(snapshot) {
  const {rows, absolute_path: _absolute, ...metadata} = snapshot;
  return metadata;
}

export function latestObservation(root, {sourceId, kind}) {
  return listObservations(root, {sourceId, kind}).at(-1) ?? null;
}

export function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}
