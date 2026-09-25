#!/usr/bin/env node
// Analyzer7 state probe — read-only resume snapshot for the router skill.
//
// Usage: node state.mjs [--project <dir>] [--now <ISO>] [--format json|text]
// JSON is the routing surface; text is the human "ANALYZER7 RESUME" view.

import {nowIso, parseArgs, printJson, resolveProject, runCli} from './lib/core.mjs';
import {probe, renderResume} from './lib/probe.mjs';

function main(argv) {
  const args = parseArgs(argv, {options: ['project', 'now', 'format']});
  const snapshot = probe(resolveProject(args.project), nowIso(args.now));
  if ((args.format ?? 'json') === 'text') process.stdout.write(renderResume(snapshot));
  else printJson(snapshot);
  return 0;
}

runCli(main);
