// Record writers shared by record.mjs, discover.mjs, analyze.mjs, seo.mjs,
// and experiment.mjs. Evidence, changes, baselines, and observations are
// append-only; anomalies, opportunities, and plans are living records whose
// status changes append to a `## Status history` section.

import {UsageError, createRecord, findRecord, isoDate, listRecords, parseTimestamp, updateDocument} from './core.mjs';
import {findSecrets} from './redact.mjs';
import {SOURCE_TYPES, loadProject, loadSources, saveSources} from './state.mjs';
import {ADAPTERS} from './adapters.mjs';
import {measurePeriod, resolveMetric} from './analysis.mjs';
import {levelFromIssues} from './quality.mjs';

export const CHANGE_TYPES = new Set(['seo_content_update', 'technical_seo_fix', 'tracking_change', 'pricing_change', 'product_release', 'campaign', 'deployment', 'content_publish', 'landing_page_change', 'performance_fix', 'schema_change', 'other']);
export const CHANGE_ORIGINS = new Set(['signal7', 'hyper7', 'marketer7', 'manual', 'deployment', 'external']);
export const TIMESTAMP_BASES = new Set(['manual', 'publish_ledger', 'execution_result', 'deploy_log', 'commit', 'task_created', 'loop_updated', 'unknown']);
export const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AUTH_METHODS = new Set(['none', 'env', 'mcp', 'oauth', 'service_account_file', 'api_key_env', 'cli', 'export']);

// ---------- sources ----------

export function registerSource(root, fields, {update = false} = {}) {
  // IDs become folder names under observations/: keep them path-safe.
  if (!SAFE_ID.test(fields.id ?? '')) throw new UsageError(`source id must match ${SAFE_ID} (got ${JSON.stringify(fields.id)})`);
  const registry = loadSources(root);
  const existing = registry.sources.find((source) => source.id === fields.id);
  if (existing && !update) throw new UsageError(`source ${fields.id} already registered; pass --update to change it`);
  if (!existing && !fields.type) throw new UsageError('--type is required for a new source');
  if (fields.type && !SOURCE_TYPES.has(fields.type)) throw new UsageError(`unknown source type ${fields.type}; known: ${[...SOURCE_TYPES].join(', ')}`);
  if (fields.adapter && !ADAPTERS[fields.adapter]) throw new UsageError(`unknown adapter ${fields.adapter}; known: ${Object.keys(ADAPTERS).join(', ')}`);
  if (fields.auth?.method && !AUTH_METHODS.has(fields.auth.method)) throw new UsageError(`unknown auth method ${fields.auth.method}; known: ${[...AUTH_METHODS].join(', ')}`);
  const leaks = findSecrets(JSON.stringify(fields));
  if (leaks.length) throw new UsageError(`refusing to store what looks like a secret (${leaks.join(', ')}); record only the auth method and env-var or tool names`);
  if (existing) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      existing[key] = key === 'freshness' || key === 'auth' ? {...(existing[key] ?? {}), ...value} : value;
    }
  } else {
    registry.sources.push({
      id: fields.id,
      type: fields.type,
      provider: fields.provider ?? null,
      property: fields.property ?? null,
      adapter: fields.adapter ?? null,
      auth: fields.auth ?? {method: 'none'},
      metrics: fields.metrics ?? [],
      timezone: fields.timezone ?? null,
      freshness: {expected_lag_hours: 24, stale_after_hours: 48, ...(fields.freshness ?? {})},
      limitations: fields.limitations ?? [],
      status: fields.status ?? 'configured',
      data_through: null,
      last_attempt_at: null,
      last_success_at: null,
      last_error_at: null,
      last_error: null,
    });
  }
  saveSources(root, registry);
  return registry.sources.find((source) => source.id === fields.id);
}

// ---------- changes ----------

export function activeChangeByRef(root, originRef) {
  if (!originRef) return null;
  const changes = listRecords(root, 'change');
  const superseded = new Set(changes.map((change) => change.data.supersedes).filter(Boolean));
  return changes.find((change) => change.data.origin_ref === originRef && !superseded.has(change.data.id)) ?? null;
}

export function registerChange(root, fields, now) {
  if (!fields.title) throw new UsageError('change --title is required');
  if (!CHANGE_ORIGINS.has(fields.origin)) throw new UsageError(`change --origin must be one of ${[...CHANGE_ORIGINS].join(', ')}`);
  if (!CHANGE_TYPES.has(fields.type)) throw new UsageError(`change --type must be one of ${[...CHANGE_TYPES].join(', ')}`);
  const basis = fields.timestamp_basis ?? (fields.timestamp && fields.timestamp !== 'unknown' ? 'manual' : 'unknown');
  if (!TIMESTAMP_BASES.has(basis)) throw new UsageError(`change timestamp basis must be one of ${[...TIMESTAMP_BASES].join(', ')}`);
  const timestamp = fields.timestamp && fields.timestamp !== 'unknown' ? fields.timestamp : null;
  if (timestamp && parseTimestamp(timestamp) === null) throw new UsageError(`invalid change timestamp ${fields.timestamp}`);
  if (fields.supersedes && !findRecord(root, 'change', fields.supersedes)) throw new UsageError(`supersedes ${fields.supersedes}: no such change`);
  const existing = fields.supersedes ? null : activeChangeByRef(root, fields.origin_ref);
  if (existing) return {status: 'already_registered', id: existing.data.id, file: existing.file};
  const data = {
    title: fields.title,
    timestamp,
    timestamp_basis: basis,
    timestamp_has_timezone: timestamp ? /[zZ]$|[+-]\d{2}:?\d{2}$/.test(timestamp) : null,
    origin: fields.origin,
    origin_ref: fields.origin_ref ?? null,
    type: fields.type,
    pages: fields.pages ?? [],
    mission_id: fields.mission_id ?? null,
    experiment_id: fields.experiment_id ?? null,
    asset_id: fields.asset_id ?? null,
    publication_id: fields.publication_id ?? null,
    deployment_id: fields.deployment_id ?? null,
    confirmed: fields.confirmed ?? basis !== 'unknown',
    recorded_at: now,
    source_path: fields.source_path ?? null,
    supersedes: fields.supersedes ?? null,
  };
  const details = (fields.details ?? []).map((line) => `- ${line.replace(/^-\s*/, '')}`);
  const body = (id) => [
    `# ${id} — ${fields.title}`,
    '',
    '## What changed',
    '',
    ...(details.length ? details : ['- Not described by the originating record.']),
    '',
    '## Timing',
    '',
    `- Timestamp: ${timestamp ?? 'unknown'} (basis: ${basis}${data.confirmed ? '' : ', unconfirmed'})`,
    ...(timestamp && !data.timestamp_has_timezone ? ['- The originating record carries no timezone; the analysis timezone is assumed.'] : []),
    ...(basis === 'task_created' || basis === 'loop_updated' ? ['- Hyper7 records no deploy time; this timestamp is a proxy and must be confirmed before causal use.'] : []),
    '',
    '## Source record',
    '',
    `- ${fields.source_path ?? 'manual entry'}${fields.origin_ref ? ` (${fields.origin_ref})` : ''}`,
    '',
    'Analyzer7 records that this change happened. It does not evaluate the change here; measurements cite this record.',
    '',
  ].join('\n');
  const record = createRecord(root, 'change', {title: fields.title, data, body, summary: `${isoDate(timestamp) ?? 'unknown date'} — ${fields.origin} ${fields.type}${fields.experiment_id ? ` — ${fields.experiment_id}` : ''} — ${fields.title}`});
  return {status: 'registered', ...record};
}

// ---------- baselines ----------

export function recordBaseline(root, {metricId, sourceId, period, scope, experimentId = null, now}) {
  const metric = resolveMetric(root, metricId);
  const source = sourceId ?? metric.canonical_source;
  const projectData = loadProject(root);
  const changes = listRecords(root, 'change');
  const measure = measurePeriod(root, {metric, sourceId: source, period, scope, label: 'baseline', project: projectData, now, changes});
  const issues = [...measure.issues];
  if (metric.status === 'proposed') issues.push({code: 'metric_unconfirmed', severity: 'blocking', message: `metric ${metric.id} is proposed, not confirmed`});
  const quality = levelFromIssues(issues);
  const value = quality === 'insufficient' ? null : measure.value;
  const segment = Object.entries(scope ?? {}).map(([key, entry]) => `${key}=${Array.isArray(entry) ? entry.join('|') : entry}`).join(', ') || 'all';
  const data = {
    title: `${metric.id} baseline ${period.start} → ${period.end}`,
    metric: metric.id,
    metric_version: metric.version ?? 1,
    unit: metric.unit ?? null,
    value: value === null ? null : Math.round(value * 10000) / 10000,
    period_start: period.start,
    period_end: period.end,
    source_id: source,
    segment,
    scope_pages: scope?.page ? (Array.isArray(scope.page) ? scope.page : [scope.page]) : [],
    sample_size: measure.sample ?? 0,
    data_quality: quality,
    experiment_id: experimentId,
    recorded_at: now,
    artifacts: measure.snapshots.map((snapshot) => snapshot.file),
  };
  const body = (id) => [
    `# ${id} — ${metric.id} baseline`,
    '',
    `- Value: ${value === null ? 'unknown (INSUFFICIENT DATA)' : `${data.value}${metric.unit === 'percent' ? '%' : ` ${metric.unit ?? ''}`}`}`,
    `- Period: ${period.start} → ${period.end}`,
    `- Source: ${source}${source === metric.canonical_source ? ' (canonical)' : ''}`,
    `- Segment: ${segment}`,
    `- Sample: ${data.sample_size}`,
    `- Data quality: ${quality.toUpperCase()}`,
    '',
    '## Data quality issues',
    '',
    ...(issues.length ? issues.map((entry) => `- [${entry.severity}] \`${entry.code}\` — ${entry.message}`) : ['- None detected.']),
    '',
    '## Provenance',
    '',
    ...(measure.snapshots.length ? measure.snapshots.map((snapshot) => `- \`${snapshot.file}\` retrieved ${snapshot.retrieved_at}, rows sha256 \`${snapshot.rows_sha256}\``) : ['- No observation snapshot covered this period.']),
    '',
  ].join('\n');
  return createRecord(root, 'baseline', {title: data.title, data, body, summary: `${period.start}..${period.end} — ${metric.id} = ${data.value ?? 'unknown'} — quality ${quality}${experimentId ? ` — ${experimentId}` : ''}`});
}

// ---------- living-record status ----------

const STATUSES = {
  anomaly: new Set(['open', 'resolved', 'dismissed']),
  opportunity: new Set(['awaiting_review', 'handed_off', 'dismissed', 'resolved']),
};

export function updateStatus(root, id, status, note, now) {
  const kind = id.startsWith('AN-') ? 'anomaly' : id.startsWith('SEO-OPP-') ? 'opportunity' : null;
  if (!kind) throw new UsageError(`status changes apply to AN-### and SEO-OPP-### records only; evidence and changes are append-only (supersede them instead)`);
  if (!STATUSES[kind].has(status)) throw new UsageError(`${id}: status must be one of ${[...STATUSES[kind]].join(', ')}`);
  const record = findRecord(root, kind, id);
  if (!record) throw new UsageError(`${id} not found`);
  const hasHistory = /^## Status history\s*$/m.test(record.body);
  const entry = `${hasHistory ? '' : '\n## Status history\n\n'}- ${now} — ${record.data.status} → ${status}${note ? ` — ${note}` : ''}\n`;
  updateDocument(record.path, {status, updated_at: now}, entry);
  return {id, previous: record.data.status, status};
}

// ---------- anomalies and opportunities (deduplicated while open) ----------

function openWithKey(root, kind, openStatuses, dedupeKey) {
  return listRecords(root, kind).find((record) => record.data.dedupe_key === dedupeKey && openStatuses.includes(record.data.status)) ?? null;
}

// fields: {title, kind, dedupe_key, metric, source_id, severity, ...flat data}
// body: markdown sections (without the H1). Returns {status, id}.
export function createAnomaly(root, fields, body, now) {
  const existing = openWithKey(root, 'anomaly', ['open'], fields.dedupe_key);
  if (existing) return {status: 'already_open', id: existing.data.id};
  const data = {status: 'open', detected_at: now, updated_at: now, ...fields};
  const record = createRecord(root, 'anomaly', {
    title: fields.title,
    data,
    body: (id) => `# ${id} — ${fields.title}\n\n${body}\n## Status history\n\n- ${now} — opened\n`,
    summary: `${isoDate(now)} — ${fields.kind} — ${fields.metric ?? fields.subject ?? ''} — severity ${fields.severity ?? 'unknown'}`,
  });
  return {status: 'opened', id: record.id, file: record.file};
}

export function createOpportunity(root, fields, body, now) {
  const existing = openWithKey(root, 'opportunity', ['awaiting_review', 'handed_off'], fields.dedupe_key);
  if (existing) return {status: 'already_recorded', id: existing.data.id};
  const data = {status: 'awaiting_review', detected_at: now, updated_at: now, ...fields};
  const record = createRecord(root, 'opportunity', {
    title: fields.title,
    data,
    body: (id) => `# ${id} — ${fields.title}\n\n${body}\n## Ownership\n\nAnalyzer7 flags and measures. Marketer7 decides whether to test it; Signal7 executes content or meta changes; Hyper7 executes technical fixes; Analyzer7 measures the result.\n\n## Status history\n\n- ${now} — awaiting_review\n`,
    summary: `${isoDate(now)} — ${fields.type} — ${fields.query ?? fields.page ?? ''}`,
  });
  return {status: 'recorded', id: record.id, file: record.file};
}
