#!/usr/bin/env node
// Safe, idempotent bootstrap of `.analyzer/`.
//
// Usage: node init.mjs [--project <dir>] [--name <project name>]
//                      [--timezone <IANA tz>] [--seed seo,funnel] [--now <ISO>]
//
// Never overwrites: an existing `.analyzer/project.md` means "already
// initialized" and nothing is written. Neighbor harness roots are read, never
// written. Output: one JSON object.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nowIso, parseArgs, printJson, readJson, readText, resolveProject, runCli, stateRoot, writeNew} from './lib/core.mjs';
import {discoverNeighbors} from './lib/neighbors.mjs';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

function inferName(project) {
  const packagePath = path.join(project, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const name = JSON.parse(readText(packagePath)).name;
      if (name) return {name, basis: 'package.json name'};
    } catch {
      // fall through
    }
  }
  for (const readme of ['README.md', 'readme.md']) {
    const readmePath = path.join(project, readme);
    if (fs.existsSync(readmePath)) {
      const heading = readText(readmePath).match(/^#\s+(.+)$/m);
      if (heading) return {name: heading[1].trim(), basis: `${readme} title`};
    }
  }
  return {name: path.basename(project), basis: 'directory name'};
}

function neighborSummary(neighbors) {
  const lines = [];
  const {marketer7, signal7, hyper7, scout7} = neighbors;
  lines.push(marketer7.present ? `- Marketer7 (\`.marketer/\`): ${marketer7.missions.length} mission(s), ${marketer7.experiments.length} experiment(s)${marketer7.experiments.length ? ` — ${marketer7.experiments.map((experiment) => `${experiment.id} ${experiment.status}`).join(', ')}` : ''}. Definitions are read in place, never copied.` : '- Marketer7: not present in this project.');
  lines.push(signal7.present ? `- Signal7 (\`.signal/\`): ${signal7.tasks.length} task(s), ${signal7.publications.length} published asset(s) importable as changes.` : '- Signal7: not present in this project.');
  lines.push(hyper7.present ? `- Hyper7 (\`.hyper/\`): ${hyper7.tasks.length} task(s), ${hyper7.loops.length} loop(s). Imports are opt-in and unconfirmed (Hyper records no deploy time).` : '- Hyper7: not present in this project.');
  lines.push(scout7.present ? `- Scout7 (\`.scout/\`): ${scout7.batches.length} batch(es) available as external context.` : '- Scout7: not present in this project.');
  return lines.join('\n');
}

// Existing SEO measurement state worth importing rather than recreating: the
// seo-rankings skill's baselines/snapshots under .hyper/seo/.
function legacySeoState(project) {
  const found = [];
  for (const folder of ['baselines', 'snapshots']) {
    const directory = path.join(project, '.hyper', 'seo', folder);
    if (!fs.existsSync(directory)) continue;
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('.md'));
    if (files.length) found.push(`.hyper/seo/${folder}/ (${files.length} file${files.length === 1 ? '' : 's'})`);
  }
  return found;
}

function main(argv) {
  const args = parseArgs(argv, {options: ['project', 'name', 'timezone', 'now'], lists: ['seed']});
  const project = resolveProject(args.project);
  const root = stateRoot(project);
  if (fs.existsSync(path.join(root, 'project.md'))) {
    printJson({status: 'already_initialized', state_root: root, written: []});
    return 0;
  }
  const now = nowIso(args.now);
  const inferred = inferName(project);
  const name = args.name ?? inferred.name;
  const neighbors = discoverNeighbors(project);
  const written = [];
  const write = (relativePath, content) => {
    writeNew(path.join(root, relativePath), content);
    written.push(relativePath);
  };

  write('project.md', readText(path.join(TEMPLATES, 'project.md')).replace('<project-name>', name).replace('<ISO-8601 timestamp>', now).replace('timezone: UTC', `timezone: ${args.timezone ?? 'UTC'}`));

  const legacySeo = legacySeoState(project);
  const context = readText(path.join(TEMPLATES, 'context.md'))
    .replace('<ISO-8601 timestamp>', now)
    .replace('## Neighbor harness state\n\nTBD', `## Neighbor harness state\n\nDiscovered at initialization (${now}):\n\n${neighborSummary(neighbors)}`)
    .replace('## SEO properties and segments\n\nTBD — see `seo/config.json`.', `## SEO properties and segments\n\n${legacySeo.length ? `Existing seo-rankings state found: ${legacySeo.join(', ')}. Import it in place with the \`seo-rankings-md\` adapter instead of re-pulling history. Configuration: ` : 'TBD — '}see \`seo/config.json\`.`)
    .replace('## Product and funnel\n\nTBD', `## Product and funnel\n\nTBD — project name "${name}" was inferred from the ${args.name ? 'user' : inferred.basis}; confirm it.`);
  write('context.md', context);

  write('sources.json', readText(path.join(TEMPLATES, 'sources.json')));
  const metrics = readJson(path.join(TEMPLATES, 'metrics.json'));
  const library = readJson(path.join(TEMPLATES, 'metric-library.json'));
  for (const set of args.seed ?? []) {
    if (!library.sets[set]) throw new Error(`unknown seed set ${set}; known: seo, funnel`);
    metrics.metrics.push(...library.sets[set].map((metric) => ({...metric, created_at: now})));
    if (set === 'funnel') metrics.funnels.push(...library.sets.funnels);
  }
  writeNew(path.join(root, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  written.push('metrics.json');
  write('monitors.json', readText(path.join(TEMPLATES, 'monitors.json')));
  write('seo/config.json', readText(path.join(TEMPLATES, 'seo-config.json')));
  write('memory.md', readText(path.join(TEMPLATES, 'memory.md')).replace('<ISO-8601 timestamp>', now));

  printJson({
    status: 'initialized',
    state_root: root,
    project_name: name,
    project_name_basis: args.name ? 'user' : inferred.basis,
    written,
    seeded_metrics: metrics.metrics.map((metric) => `${metric.id} (${metric.status})`),
    neighbors: Object.fromEntries(Object.entries(neighbors).map(([key, value]) => [key, value.present])),
    next_steps: [
      'Register each available source with record.mjs source (never assume a source exists).',
      'Confirm or define metrics in metrics.json; proposed metrics cannot support evidence.',
      'Run discover.mjs --import-changes to register Signal7 publications as changes.',
      ...(legacySeo.length ? [`Import existing seo-rankings history (${legacySeo.join(', ')}) with ingest.mjs --adapter seo-rankings-md.`] : []),
    ],
    legacy_seo_state: legacySeo,
  });
  return 0;
}

runCli(main);
