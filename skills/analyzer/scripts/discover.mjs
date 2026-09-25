#!/usr/bin/env node
// Discover neighbor harness state and optionally import changes.
//
// Usage: node discover.mjs [--project <dir>] [--import-changes]
//                          [--include signal7,hyper7] [--dry-run] [--now <ISO>]
//
// Read-only toward `.marketer/`, `.signal/`, `.hyper/`, `.scout/`. Imports
// write only `.analyzer/changes/`, idempotently (dedupe on origin_ref).
// Signal7 publications import by default; Hyper7 work is opt-in because Hyper
// records no deploy time (imports are unconfirmed, timing basis explicit).

import {nowIso, normalizePage, parseArgs, printJson, requireInitialized, resolveProject, runCli, stateRoot} from './lib/core.mjs';
import {discoverNeighbors} from './lib/neighbors.mjs';
import {activeChangeByRef, registerChange} from './lib/records.mjs';

function signalChangeType(publication) {
  const descriptor = `${publication.asset_type ?? ''} ${publication.channel ?? ''}`.toLowerCase();
  if (/seo|meta|title/.test(descriptor)) return 'seo_content_update';
  if (/landing/.test(descriptor)) return 'landing_page_change';
  if (/blog|web|site|page|cms|article/.test(descriptor)) return 'content_publish';
  return 'campaign';
}

function hyperChangeType(title) {
  const text = title.toLowerCase();
  if (/track|analytics|ga4|gtm|pixel|event|attribution/.test(text)) return 'tracking_change';
  if (/seo|canonical|sitemap|robots|schema|hreflang|meta|redirect|index/.test(text)) return 'technical_seo_fix';
  if (/perf|speed|lcp|inp|cls|web vitals|cwv|cache/.test(text)) return 'performance_fix';
  if (/pric|plan|checkout|billing/.test(text)) return 'pricing_change';
  if (/landing/.test(text)) return 'landing_page_change';
  return 'deployment';
}

function signalCandidates(signal) {
  return signal.publications.map((publication) => ({
    title: `Signal7 ${publication.task_id}/${publication.asset_id}: ${publication.title ?? 'published asset'}`,
    origin: 'signal7',
    origin_ref: publication.ref,
    type: signalChangeType(publication),
    timestamp: publication.published_at ?? undefined,
    timestamp_basis: publication.published_at ? (publication.live_time_basis === 'deploy_log' ? 'deploy_log' : publication.idempotency_key ? 'publish_ledger' : 'execution_result') : 'unknown',
    pages: publication.publication_url ? [normalizePage(publication.publication_url)] : [],
    mission_id: publication.mission_id,
    experiment_id: publication.experiment_id,
    asset_id: publication.ref,
    publication_id: publication.idempotency_key ?? publication.ref,
    source_path: publication.source_path,
    details: [
      `channel: ${publication.channel ?? 'unknown'}${publication.asset_type ? `, asset type ${publication.asset_type}` : ''}`,
      publication.publication_url ? `published at ${publication.publication_url}` : 'publication URL unknown — scope treated as site-wide',
      publication.content_hash ? `content hash ${publication.content_hash}` : 'no content hash recorded',
      publication.tracking && Object.keys(publication.tracking).length ? `tracking ${Object.entries(publication.tracking).map(([key, value]) => `${key}=${value}`).join(', ')}` : 'no tracking parameters recorded',
    ],
  }));
}

function hyperCandidates(hyper) {
  const tasks = hyper.tasks
    .filter((task) => task.phase === 'done' && ['feature', 'quick'].includes(task.scope))
    .map((task) => ({
      title: `Hyper7 ${task.id}: ${task.title}`,
      origin: 'hyper7',
      origin_ref: `hyper7:${task.id}`,
      type: hyperChangeType(task.title),
      // A Hyper task that records deployed_at is confirmed; otherwise the
      // creation time is only a proxy.
      timestamp: task.deployed_at ?? task.created ?? undefined,
      timestamp_basis: task.deployed_at ? 'deploy_log' : task.created ? 'task_created' : 'unknown',
      confirmed: Boolean(task.deployed_at),
      pages: [],
      deployment_id: `hyper7:${task.id}`,
      source_path: task.path,
      details: [`Hyper ${task.scope} task${task.bugfix ? ' (bugfix)' : ''} marked done`, 'change type classified heuristically from the title', 'pages unknown — scope treated as site-wide until confirmed'],
    }));
  const loops = hyper.loops
    .filter((loop) => ['done', 'complete'].includes(loop.status))
    .map((loop) => ({
      title: `Hyper7 ${loop.id}: ${loop.title}`,
      origin: 'hyper7',
      origin_ref: `hyper7:${loop.id}`,
      type: hyperChangeType(loop.title),
      timestamp: loop.deployed_at ?? loop.updated ?? undefined,
      timestamp_basis: loop.deployed_at ? 'deploy_log' : loop.updated ? 'loop_updated' : 'unknown',
      confirmed: Boolean(loop.deployed_at),
      pages: [],
      deployment_id: `hyper7:${loop.id}`,
      source_path: loop.path,
      details: ['Hyper loop closed', 'change type classified heuristically from the title', 'pages unknown — scope treated as site-wide until confirmed'],
    }));
  return [...tasks, ...loops];
}

function main(argv) {
  const args = parseArgs(argv, {flags: ['import-changes', 'dry-run'], options: ['project', 'now'], lists: ['include']});
  const project = resolveProject(args.project);
  const neighbors = discoverNeighbors(project);
  const summary = {
    marketer7: neighbors.marketer7.present ? {missions: neighbors.marketer7.missions, experiments: neighbors.marketer7.experiments.map(({hypothesis, ...experiment}) => experiment)} : null,
    signal7: neighbors.signal7.present ? {tasks: neighbors.signal7.tasks.length, publications: neighbors.signal7.publications} : null,
    hyper7: neighbors.hyper7.present ? {tasks: neighbors.hyper7.tasks, loops: neighbors.hyper7.loops} : null,
    scout7: neighbors.scout7.present ? {batches: neighbors.scout7.batches, territory_log: neighbors.scout7.territory_log} : null,
  };
  const warnings = Object.values(neighbors).flatMap((neighbor) => neighbor.warnings ?? []);
  if (!args.importChanges) {
    printJson({project, neighbors: summary, warnings});
    return 0;
  }
  const root = requireInitialized(project);
  const include = new Set(args.include ?? ['signal7']);
  const candidates = [
    ...(include.has('signal7') && neighbors.signal7.present ? signalCandidates(neighbors.signal7) : []),
    ...(include.has('hyper7') && neighbors.hyper7.present ? hyperCandidates(neighbors.hyper7) : []),
  ];
  const now = nowIso(args.now);
  const imported = [];
  const skipped = [];
  for (const candidate of candidates) {
    const existing = activeChangeByRef(root, candidate.origin_ref);
    if (existing) {
      skipped.push({origin_ref: candidate.origin_ref, reason: `already registered as ${existing.data.id}`});
      continue;
    }
    if (args.dryRun) {
      imported.push({origin_ref: candidate.origin_ref, dry_run: true, type: candidate.type, timestamp: candidate.timestamp ?? null});
      continue;
    }
    const result = registerChange(root, candidate, now);
    imported.push({id: result.id, origin_ref: candidate.origin_ref, type: candidate.type, timestamp: candidate.timestamp ?? null, confirmed: candidate.confirmed ?? Boolean(candidate.timestamp)});
  }
  printJson({project, state_root: stateRoot(project), include: [...include], imported, skipped, warnings});
  return 0;
}

runCli(main);
