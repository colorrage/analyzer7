#!/usr/bin/env node
// Optional read-only connectors: fetch from a provider and ingest in one step.
// Nothing here runs unless invoked; projects without these providers simply
// never call it and keep using exports + ingest.mjs.
//
//   gsc         --source <id> --start <date> --end <date> --dimensions date[,page|query,page,country]
//               [--filter country=deu] [--data-state final|all]
//   gsc-latest  --source <id>                       print the latest final GSC date
//   inspect     --source <indexation id> --urls a,b | --top-pages N --pages-source <gsc id> --since <date>
//   ga4         --source <id> --start --end --dimensions date[,sessionDefaultChannelGroup,...] --metrics sessions,keyEvents
//   crawl       --source <crawl id> --urls a,b | --top-pages N --pages-source <gsc id> --since <date> [--sitemap <url>]
//   psi         --source <performance id> --urls a,b | --top-pages N --pages-source <gsc id> --since <date>
//
// Common: [--project <dir>] [--now <ISO>]. A failure is recorded on the source
// (health: unavailable) and exits non-zero; nothing is estimated.

import {UsageError, isoDate, nowIso, parseArgs, printJson, requireInitialized, resolveProject} from './lib/core.mjs';
import {crawl, ga4Report, gscInspect, gscLatestFinalDate, gscSearchAnalytics, pagespeed, toCsv, writeExport} from './lib/connectors.mjs';
import {ingestFile, recordFailure} from './lib/ingest.mjs';
import {getSource, selectRows} from './lib/state.mjs';

const COMMON = ['project', 'now', 'source'];

function context(argv, spec) {
  const args = parseArgs(argv, spec);
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  if (!args.source) throw new UsageError('--source is required');
  const source = getSource(root, args.source);
  if (!source) throw new UsageError(`source ${args.source} is not registered (Analyzer7 never assumes a source exists)`);
  return {args, project, root, source, now: nowIso(args.now)};
}

// URLs to fetch: explicit, or the top N pages by clicks since a date from the
// latest ingested GSC page-level data.
function targetUrls(root, args) {
  if (args.urls) return args.urls;
  if (!args.topPages || !args.pagesSource || !args.since) throw new UsageError('pass --urls, or --top-pages N --pages-source <gsc id> --since <date>');
  const source = getSource(root, args.pagesSource);
  if (!source?.data_through) throw new UsageError(`${args.pagesSource} has no ingested data to rank pages from`);
  const {rows} = selectRows(root, {sourceId: args.pagesSource, kind: 'gsc_rows', period: {start: args.since, end: isoDate(source.data_through)}, require: ['page'], exclude: ['query']});
  const clicks = new Map();
  for (const row of rows) clicks.set(row.page, (clicks.get(row.page) ?? 0) + (Number(row.clicks) || 0));
  return [...clicks.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(args.topPages)).map(([page]) => page);
}

const COMMANDS = {
  async gsc(argv) {
    const {args, project, root, source, now} = context(argv, {options: [...COMMON, 'start', 'end', 'data-state'], lists: ['dimensions', 'filter']});
    if (!args.start || !args.end || !args.dimensions) throw new UsageError('gsc needs --start, --end, --dimensions');
    const filters = Object.fromEntries((args.filter ?? []).map((pair) => pair.split('=').map((part) => part.trim())));
    const response = await gscSearchAnalytics(source, {start: args.start, end: args.end, dimensions: args.dimensions, dataState: args.dataState ?? 'final', filters});
    const file = writeExport(`gsc-${args.dimensions.join('-')}-${args.start}_${args.end}.json`, response);
    const undated = !args.dimensions.includes('date');
    return ingestFile(root, project, source.id, {input: file, dimensions: args.dimensions, set: filters, ...(undated ? {start: args.start, end: args.end} : {})}, now);
  },

  async 'gsc-latest'(argv) {
    const {source} = context(argv, {options: COMMON});
    return {source_id: source.id, latest_final_date: await gscLatestFinalDate(source)};
  },

  async inspect(argv) {
    const {args, project, root, source, now} = context(argv, {options: [...COMMON, 'top-pages', 'pages-source', 'since'], lists: ['urls']});
    const rows = await gscInspect(source, targetUrls(root, args));
    const file = writeExport('indexation.csv', toCsv(rows, ['url', 'coverage_state', 'google_canonical', 'user_canonical', 'last_crawl']));
    return ingestFile(root, project, source.id, {input: file}, now);
  },

  async ga4(argv) {
    const {args, project, root, source, now} = context(argv, {options: [...COMMON, 'start', 'end'], lists: ['dimensions', 'metrics']});
    if (!args.start || !args.end || !args.dimensions || !args.metrics) throw new UsageError('ga4 needs --start, --end, --dimensions (including date), --metrics');
    const rows = await ga4Report(source, {start: args.start, end: args.end, dimensions: args.dimensions, metrics: args.metrics});
    const file = writeExport(`ga4-${args.start}_${args.end}.csv`, toCsv(rows, args.dimensions.concat(args.metrics)));
    return ingestFile(root, project, source.id, {input: file}, now);
  },

  async crawl(argv) {
    const {args, project, root, source, now} = context(argv, {options: [...COMMON, 'top-pages', 'pages-source', 'since', 'sitemap'], lists: ['urls']});
    const rows = await crawl(targetUrls(root, args), {sitemap: args.sitemap ?? null});
    const file = writeExport('crawl.csv', toCsv(rows, ['url', 'status', 'redirect_to', 'redirect_hops', 'canonical', 'title', 'meta_description', 'robots', 'in_sitemap', 'inlinks']));
    return ingestFile(root, project, source.id, {input: file}, now);
  },

  async psi(argv) {
    const {args, project, root, source, now} = context(argv, {options: [...COMMON, 'top-pages', 'pages-source', 'since'], lists: ['urls']});
    const {rows, failures} = await pagespeed(source, targetUrls(root, args));
    if (!rows.length) throw new Error(`PageSpeed returned no data (${failures.join('; ')})`);
    const file = writeExport('cwv.csv', toCsv(rows, ['url', 'form_factor', 'lcp_p75_ms', 'inp_p75_ms', 'cls_p75', 'date']));
    return {...ingestFile(root, project, source.id, {input: file}, now), partial_failures: failures};
  },
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) throw new UsageError(`connect.mjs <${Object.keys(COMMANDS).join('|')}> --source <id> [options]`);
  try {
    printJson(await COMMANDS[command](rest));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // Record the failure on the source so health shows it; never fall back to stale data silently.
    const args = parseArgs(rest, {options: ['project', 'now', 'source', 'start', 'end', 'data-state', 'top-pages', 'pages-source', 'since', 'sitemap'], lists: ['dimensions', 'filter', 'metrics', 'urls']});
    const project = resolveProject(args.project);
    const root = requireInitialized(project);
    if (args.source && getSource(root, args.source) && command !== 'gsc-latest') printJson(recordFailure(root, args.source, `${command}: ${error.message}`, nowIso(args.now)));
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`analyzer7 ${error instanceof UsageError ? 'usage error' : 'error'}: ${error.message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
