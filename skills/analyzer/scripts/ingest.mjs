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

import fs from 'node:fs';
import path from 'node:path';
import {UsageError, isoDate, nowIso, parseArgs, printJson, relative, requireInitialized, resolveProject, runCli, slugify, uniquePath, writeJson} from './lib/core.mjs';
import {ADAPTERS, normalizeInput} from './lib/adapters.mjs';
import {redact} from './lib/redact.mjs';
import {getSource, observationDir, updateSource} from './lib/state.mjs';

function main(argv) {
  const args = parseArgs(argv, {options: ['project', 'source', 'input', 'adapter', 'start', 'end', 'metric', 'provider', 'observed-at', 'retrieved-at', 'now', 'fail', 'property'], lists: ['dimensions', 'set', 'segment-map']});
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  if (!args.source) throw new UsageError('--source is required');
  const source = getSource(root, args.source);
  if (!source) throw new UsageError(`source ${args.source} is not registered; register it with record.mjs source first (Analyzer7 never assumes a source exists)`);
  const now = nowIso(args.now);

  if (args.fail !== undefined) {
    const message = redact(args.fail).text;
    updateSource(root, source.id, {last_attempt_at: now, last_error_at: now, last_error: message});
    printJson({status: 'recorded_failure', source_id: source.id, health: 'unavailable', error: message});
    return 0;
  }
  if (!args.input) throw new UsageError('--input is required (or --fail to record a failed fetch)');
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) throw new UsageError(`input not found: ${inputPath}`);
  const adapter = args.adapter ?? source.adapter;
  if (!ADAPTERS[adapter]) throw new UsageError(`unknown adapter ${adapter}`);
  if (source.adapter && ADAPTERS[source.adapter] && ADAPTERS[source.adapter].kind !== ADAPTERS[adapter].kind) {
    throw new UsageError(`adapter ${adapter} produces ${ADAPTERS[adapter].kind}, but source ${source.id} is registered for ${ADAPTERS[source.adapter].kind}`);
  }
  const set = Object.fromEntries((args.set ?? []).map((pair) => {
    const [key, ...rest] = pair.split('=');
    if (!key || rest.length === 0) throw new UsageError(`--set expects key=value, got ${pair}`);
    return [key.trim(), rest.join('=').trim()];
  }));
  // Explicit label mapping for legacy files that name the same market
  // differently ("DEU" vs "Germany (de)"); the adapter never guesses.
  const segmentMap = Object.fromEntries((args.segmentMap ?? []).map((pair) => pair.split('=').map((part) => part.trim())));
  const snapshot = normalizeInput({
    adapter,
    inputPath,
    sourceId: source.id,
    property: args.property ?? source.property ?? null,
    dimensions: args.dimensions,
    start: args.start,
    end: args.end,
    metric: args.metric,
    segment: undefined,
    provider: args.provider ?? source.provider,
    observedAt: args.observedAt,
    set,
    segmentMap,
    retrievedAt: args.retrievedAt ? nowIso(args.retrievedAt) : now,
  });
  snapshot.input.file = inputPath.startsWith(project) ? relative(project, inputPath) : snapshot.input.file;
  // Freshness comes from dates actually present in the rows (never from an
  // asserted --end), and future-dated rows are flagged rather than trusted.
  const today = isoDate(now);
  const rowDates = snapshot.rows.map((row) => isoDate(row.date ?? row.observed_at)).filter(Boolean).sort();
  if (rowDates.length && rowDates.at(-1) > today) snapshot.warnings.push(`rows are dated up to ${rowDates.at(-1)}, after the ingest date ${today}; freshness is capped at ${today}`);
  if (snapshot.rows.length === 0) snapshot.warnings.push('the export contains no rows; source freshness is not advanced');
  const stamp = snapshot.period?.end ?? isoDate(now);
  const target = uniquePath(path.join(observationDir(root, source.id), `${stamp}-${adapter}-${slugify(path.basename(inputPath, path.extname(inputPath)), 40)}.json`));
  writeJson(target, snapshot);
  // Undated aggregate pulls (query×page for a period) cover their declared
  // period; undated state snapshots (crawl, indexation) are current as of retrieval.
  let through = null;
  if (snapshot.rows.length) through = rowDates.length ? rowDates.at(-1) : snapshot.period?.end ?? isoDate(snapshot.retrieved_at);
  if (through && through > today) through = today;
  const dataThrough = [source.data_through, through].filter(Boolean).sort().at(-1) ?? null;
  updateSource(root, source.id, {last_attempt_at: now, last_success_at: now, data_through: dataThrough});
  printJson({
    status: 'ingested',
    source_id: source.id,
    adapter,
    kind: snapshot.kind,
    observation: relative(project, target),
    period: snapshot.period,
    dimensions: snapshot.dimensions,
    row_count: snapshot.row_count,
    headline_safe: snapshot.headline_safe,
    headline_note: snapshot.headline_note,
    rows_sha256: snapshot.rows_sha256,
    data_through: dataThrough,
    warnings: snapshot.warnings,
  });
  return 0;
}

runCli(main);
