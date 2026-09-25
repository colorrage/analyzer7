#!/usr/bin/env node
// Write Analyzer7 records. Subcommands:
//
//   source   --id <id> --type <type> [--provider] [--property] [--adapter]
//            [--metrics a,b] [--auth-method env|mcp|oauth|service_account_file|api_key_env|cli|export|none]
//            [--auth-reference <tool or doc name>] [--env-vars NAME,NAME] [--credentials-file <path>]
//            [--timezone <tz>] [--expected-lag-hours N] [--stale-after-hours N]
//            [--limitations "a|b"] [--status configured|disabled] [--update]
//   metric-status --id <metric> --status active|proposed|retired --reason "<why>"
//   change   --title <t> --origin <o> --type <type> [--timestamp <ISO>|unknown]
//            [--basis <basis>] [--pages /a,/b] [--experiment EX-NNN] [--mission M<N>]
//            [--asset <ref>] [--publication <ref>] [--deployment <ref>]
//            [--origin-ref <ref>] [--details "a|b"] [--confirmed true|false]
//            [--supersedes CH-NNN] [--source-path <path>]
//            [--applied-at <ISO>] [--deploy-status deployed|pending|unknown]
//   deploy   --changes CH-NNN,... --deployed-at <ISO> [--basis deploy_log] [--deployment <id>] [--note <text>]
//   import-changes --file <csv|md> [--table <heading>] [--date-means applied|deployed]
//            [--default-type <type>] [--origin <origin>] [--deploy-status pending] [--dry-run]
//   baseline --metric <id> --start <date> --end <date> [--source <id>]
//            [--page /a] [--query <q>] [--country <c>] [--segment <s>] [--experiment EX-NNN]
//   status   --id AN-NNN|SEO-OPP-NNN --status <status> [--note <text>]
//
// Common: [--project <dir>] [--now <ISO>]. Output: one JSON object.

import path from 'node:path';
import {UsageError, nowIso, parseArgs, printJson, readJson, requireInitialized, resolveProject, runCli, scopeFromArgs, writeJson} from './lib/core.mjs';
import {activeChangeByRef, deployChanges, recordBaseline, registerChange, registerSource, updateStatus} from './lib/records.mjs';
import {parseChangeLog} from './lib/changelog.mjs';

const COMMON = ['project', 'now'];

function listOf(value) {
  if (value === undefined) return undefined;
  return String(value).split('|').map((item) => item.trim()).filter(Boolean);
}

const COMMANDS = {
  source(argv) {
    const args = parseArgs(argv, {flags: ['update'], options: [...COMMON, 'id', 'type', 'provider', 'property', 'adapter', 'auth-method', 'auth-reference', 'credentials-file', 'timezone', 'expected-lag-hours', 'stale-after-hours', 'limitations', 'status'], lists: ['metrics', 'env-vars']});
    const root = requireInitialized(resolveProject(args.project));
    if (!args.id) throw new UsageError('source --id is required');
    const freshness = {};
    if (args.expectedLagHours !== undefined) freshness.expected_lag_hours = Number(args.expectedLagHours);
    if (args.staleAfterHours !== undefined) freshness.stale_after_hours = Number(args.staleAfterHours);
    // credentials_file is a path to a key file, never the key itself.
    const auth = args.authMethod || args.authReference || args.envVars || args.credentialsFile ? {method: args.authMethod ?? 'none', ...(args.authReference ? {reference: args.authReference} : {}), ...(args.envVars ? {env_vars: args.envVars} : {}), ...(args.credentialsFile ? {credentials_file: args.credentialsFile} : {})} : undefined;
    const source = registerSource(root, {id: args.id, type: args.type, provider: args.provider, property: args.property, adapter: args.adapter, metrics: args.metrics, timezone: args.timezone, freshness: Object.keys(freshness).length ? freshness : undefined, limitations: listOf(args.limitations), status: args.status, auth}, {update: Boolean(args.update)});
    printJson({status: args.update ? 'updated' : 'registered', source});
  },

  'metric-status'(argv) {
    const args = parseArgs(argv, {options: [...COMMON, 'id', 'status', 'reason']});
    const root = requireInitialized(resolveProject(args.project));
    if (!['active', 'proposed', 'retired'].includes(args.status)) throw new UsageError('metric-status --status must be active, proposed, or retired');
    if (!args.reason) throw new UsageError('metric-status --reason is required: definition changes are never silent');
    const file = path.join(root, 'metrics.json');
    const registry = readJson(file);
    const metric = registry.metrics.find((entry) => entry.id === args.id);
    if (!metric) throw new UsageError(`metric ${args.id} not found`);
    if (args.status === 'active' && !metric.canonical_source) throw new UsageError(`metric ${args.id} has no canonical_source; define it before activating`);
    if (args.status === 'active' && /^TBD/.test(metric.definition ?? '')) throw new UsageError(`metric ${args.id} still has a TBD definition`);
    const now = nowIso(args.now);
    metric.status_history = [...(metric.status_history ?? []), {at: now, from: metric.status, to: args.status, reason: args.reason}];
    metric.status = args.status;
    writeJson(file, registry);
    printJson({status: 'updated', metric: metric.id, metric_status: metric.status});
  },

  change(argv) {
    const args = parseArgs(argv, {options: [...COMMON, 'title', 'origin', 'type', 'timestamp', 'basis', 'experiment', 'mission', 'asset', 'publication', 'deployment', 'origin-ref', 'details', 'confirmed', 'supersedes', 'source-path', 'applied-at', 'deploy-status'], lists: ['pages']});
    const root = requireInitialized(resolveProject(args.project));
    const now = nowIso(args.now);
    const result = registerChange(root, {
      title: args.title,
      origin: args.origin,
      type: args.type,
      timestamp: args.timestamp,
      timestamp_basis: args.basis,
      pages: args.pages,
      experiment_id: args.experiment,
      mission_id: args.mission,
      asset_id: args.asset,
      publication_id: args.publication,
      deployment_id: args.deployment,
      origin_ref: args.originRef,
      details: listOf(args.details),
      confirmed: args.confirmed === undefined ? undefined : args.confirmed === 'true',
      supersedes: args.supersedes,
      source_path: args.sourcePath,
      applied_at: args.appliedAt,
      deploy_status: args.deployStatus,
    }, now);
    printJson(result);
  },

  deploy(argv) {
    const args = parseArgs(argv, {options: [...COMMON, 'deployed-at', 'basis', 'deployment', 'note'], lists: ['changes']});
    const root = requireInitialized(resolveProject(args.project));
    if (!args.changes) throw new UsageError('deploy needs --changes CH-NNN,...');
    printJson({status: 'recorded', results: deployChanges(root, args.changes, {deployedAt: args.deployedAt, basis: args.basis ?? 'deploy_log', deploymentId: args.deployment ?? null, note: args.note ?? null}, nowIso(args.now))});
  },

  'import-changes'(argv) {
    const args = parseArgs(argv, {flags: ['dry-run'], options: [...COMMON, 'file', 'table', 'date-means', 'default-type', 'origin', 'deploy-status']});
    const project = resolveProject(args.project);
    const root = requireInitialized(project);
    if (!args.file) throw new UsageError('import-changes needs --file <csv|md>');
    if (args.dateMeans && !['applied', 'deployed'].includes(args.dateMeans)) throw new UsageError('--date-means must be applied or deployed');
    const now = nowIso(args.now);
    const rows = parseChangeLog(path.resolve(args.file), {table: args.table ?? null, dateMeans: args.dateMeans ?? null, defaultType: args.defaultType ?? 'other', origin: args.origin ?? 'manual', deployStatus: args.deployStatus ?? null, project});
    const results = rows.map((fields) => {
      const existing = activeChangeByRef(root, fields.origin_ref);
      if (existing) return {status: 'already_registered', id: existing.data.id, title: fields.title};
      if (args.dryRun) return {status: 'dry_run', title: fields.title, deploy_status: fields.deploy_status, timestamp: fields.timestamp ?? null, applied_at: fields.applied_at, pages: fields.pages, type: fields.type};
      const result = registerChange(root, fields, now);
      return {status: result.status, id: result.id, title: fields.title, deploy_status: fields.deploy_status, pages: fields.pages.length};
    });
    printJson({status: args.dryRun ? 'dry_run' : 'imported', rows: rows.length, registered: results.filter((entry) => entry.status === 'registered').length, results});
  },

  baseline(argv) {
    const args = parseArgs(argv, {options: [...COMMON, 'metric', 'source', 'start', 'end', 'query', 'country', 'device', 'segment', 'experiment'], lists: ['page']});
    const root = requireInitialized(resolveProject(args.project));
    if (!args.metric || !args.start || !args.end) throw new UsageError('baseline needs --metric, --start, and --end');
    const record = recordBaseline(root, {metricId: args.metric, sourceId: args.source, period: {start: args.start, end: args.end}, scope: scopeFromArgs(args), experimentId: args.experiment ?? null, now: nowIso(args.now)});
    printJson({status: 'recorded', ...record});
  },

  status(argv) {
    const args = parseArgs(argv, {options: [...COMMON, 'id', 'status', 'note']});
    const root = requireInitialized(resolveProject(args.project));
    printJson(updateStatus(root, args.id, args.status, args.note, nowIso(args.now)));
  },
};

function main(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS[command]) throw new UsageError(`record.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
  COMMANDS[command](rest);
  return 0;
}

runCli(main);
