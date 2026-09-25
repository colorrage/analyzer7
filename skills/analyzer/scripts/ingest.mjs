#!/usr/bin/env node
// Normalize a provider export into an immutable observation snapshot.
//
// Usage:
//   node ingest.mjs --source <id> --input <file> [--adapter <name>]
//        [--dimensions date,page] [--start YYYY-MM-DD --end YYYY-MM-DD]
//        [--metric <series>] [--set key=value,...] [--segment-map de=DEU,...] [--provider <name>]
//        [--observed-at <ISO>] [--retrieved-at <ISO>] [--now <ISO>] [--project <dir>]
//   node ingest.mjs --source <id> --fail "<error message>" [--now <ISO>]
//
// The source must already be registered. A failed fetch is recorded, never
// papered over: the source becomes `unavailable` until the next success.

import {UsageError, nowIso, parseArgs, printJson, requireInitialized, resolveProject, runCli} from './lib/core.mjs';
import {ingestFile, recordFailure} from './lib/ingest.mjs';
import {getSource} from './lib/state.mjs';

function pairs(list, label) {
  return Object.fromEntries((list ?? []).map((pair) => {
    const [key, ...rest] = pair.split('=');
    if (!key || rest.length === 0) throw new UsageError(`${label} expects key=value, got ${pair}`);
    return [key.trim(), rest.join('=').trim()];
  }));
}

function main(argv) {
  const args = parseArgs(argv, {options: ['project', 'source', 'input', 'adapter', 'start', 'end', 'metric', 'provider', 'observed-at', 'retrieved-at', 'now', 'fail', 'property'], lists: ['dimensions', 'set', 'segment-map']});
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  if (!args.source) throw new UsageError('--source is required');
  if (!getSource(root, args.source)) throw new UsageError(`source ${args.source} is not registered; register it with record.mjs source first (Analyzer7 never assumes a source exists)`);
  const now = nowIso(args.now);
  if (args.fail !== undefined) {
    printJson(recordFailure(root, args.source, args.fail, now));
    return 0;
  }
  if (!args.input) throw new UsageError('--input is required (or --fail to record a failed fetch)');
  printJson(ingestFile(root, project, args.source, {...args, set: pairs(args.set, '--set'), segmentMap: pairs(args.segmentMap, '--segment-map'), retrievedAt: args.retrievedAt ? nowIso(args.retrievedAt) : undefined}, now));
  return 0;
}

runCli(main);
