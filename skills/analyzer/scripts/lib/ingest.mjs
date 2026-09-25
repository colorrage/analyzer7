// The single ingest path: an export file → an immutable, hashed, redacted
// observation snapshot, plus the source's freshness. Used by ingest.mjs and
// by every connector, so provenance is identical however data arrives.

import fs from 'node:fs';
import path from 'node:path';
import {UsageError, isoDate, nowIso, relative, slugify, uniquePath, writeGzipJson} from './core.mjs';
import {ADAPTERS, normalizeInput} from './adapters.mjs';
import {redact} from './redact.mjs';
import {getSource, observationDir, updateSource} from './state.mjs';

export function recordFailure(root, sourceId, message, now) {
  const clean = redact(String(message)).text;
  updateSource(root, sourceId, {last_attempt_at: now, last_error_at: now, last_error: clean});
  return {status: 'recorded_failure', source_id: sourceId, health: 'unavailable', error: clean};
}

// args: {input, adapter, dimensions, start, end, metric, provider, observedAt,
//        retrievedAt, property, set, segmentMap}
export function ingestFile(root, project, sourceId, args, now) {
  const source = getSource(root, sourceId);
  if (!source) throw new UsageError(`source ${sourceId} is not registered; register it with record.mjs source first (Analyzer7 never assumes a source exists)`);
  if (!args.input) throw new UsageError('an input file is required');
  const inputPath = path.resolve(args.input);
  const retrievedAt = args.retrievedAt ?? now;
  if (!fs.existsSync(inputPath)) throw new UsageError(`input not found: ${inputPath}`);
  const adapter = args.adapter ?? source.adapter;
  if (!ADAPTERS[adapter]) throw new UsageError(`unknown adapter ${adapter}`);
  if (source.adapter && ADAPTERS[source.adapter] && ADAPTERS[source.adapter].kind !== ADAPTERS[adapter].kind) {
    throw new UsageError(`adapter ${adapter} produces ${ADAPTERS[adapter].kind}, but source ${source.id} is registered for ${ADAPTERS[source.adapter].kind}`);
  }
  const set = args.set ?? {};
  // Explicit label mapping for legacy files that name the same market
  // differently ("DEU" vs "Germany (de)"); the adapter never guesses.
  const segmentMap = args.segmentMap ?? {};
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
    retrievedAt,
  });
  snapshot.input.file = inputPath.startsWith(project) ? relative(project, inputPath) : snapshot.input.file;
  // Freshness comes from dates actually present in the rows (never from an
  // asserted --end), and future-dated rows are flagged rather than trusted.
  const today = isoDate(now);
  const rowDates = snapshot.rows.map((row) => isoDate(row.date ?? row.observed_at)).filter(Boolean).sort();
  if (rowDates.length && rowDates.at(-1) > today) snapshot.warnings.push(`rows are dated up to ${rowDates.at(-1)}, after the ingest date ${today}; freshness is capped at ${today}`);
  if (snapshot.rows.length === 0) snapshot.warnings.push('the export contains no rows; source freshness is not advanced');
  const stamp = snapshot.period?.end ?? isoDate(now);
  const target = uniquePath(path.join(observationDir(root, source.id), `${stamp}-${adapter}-${slugify(path.basename(inputPath, path.extname(inputPath)), 40)}.json.gz`));
  writeGzipJson(target, snapshot);
  // Undated aggregate pulls (query×page for a period) cover their declared
  // period; undated state snapshots (crawl, indexation) are current as of retrieval.
  let through = null;
  if (snapshot.rows.length) through = rowDates.length ? rowDates.at(-1) : snapshot.period?.end ?? isoDate(snapshot.retrieved_at);
  if (through && through > today) through = today;
  const dataThrough = [source.data_through, through].filter(Boolean).sort().at(-1) ?? null;
  updateSource(root, source.id, {last_attempt_at: now, last_success_at: now, data_through: dataThrough});
  return {
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
  };
}
