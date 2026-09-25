// Adapters normalize provider exports into observation snapshots.
//
// An adapter never fetches: fetching stays with the provider's own tool (GSC
// MCP, GA4 export, Stripe CSV, a ranking provider API, a crawler). Analyzer7
// receives what that tool returned and normalizes it, so the core is never
// coupled to a provider SDK and unit tests never need live APIs.

import path from 'node:path';
import {UsageError, isoDate, parseCsv, parseFrontmatter, readText, sha256} from './core.mjs';
import {redact} from './redact.mjs';

export const ADAPTERS = {
  gsc: {kind: 'gsc_rows', version: 1, description: 'Google Search Console search analytics rows (MCP JSON, API JSON, or UI/CSV export)'},
  'seo-rankings-md': {kind: 'gsc_rows', version: 1, description: 'Legacy seo-rankings skill baseline/snapshot markdown tables'},
  rankings: {kind: 'rankings', version: 1, description: 'Rank-tracker observations (keyword × location × device × engine)'},
  timeseries: {kind: 'timeseries', version: 1, description: 'Daily metric series (GA4, DB, Stripe, CRM, email exports)'},
  crawl: {kind: 'crawl', version: 1, description: 'Crawler page rows (status, redirects, canonical, titles, robots, sitemap, inlinks)'},
  cwv: {kind: 'cwv', version: 1, description: 'Core Web Vitals p75 rows (CrUX / PageSpeed)'},
  indexation: {kind: 'indexation', version: 1, description: 'Index coverage / URL inspection rows'},
};

function number(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/[\s,]/g, '');
  if (text === '' || text === '-' || /^n\/?a$/i.test(text)) return null;
  const parsed = Number(text.replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

// CTR arrives as a fraction from the API (0.011) and as a percent string from
// the UI export ("1.1%"). Stored as a fraction; analysis recomputes CTR from
// clicks/impressions anyway.
function ctrFraction(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.trim().endsWith('%')) return number(value) / 100;
  const parsed = number(value);
  if (parsed === null) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function pick(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== '') return row[name];
  }
  return undefined;
}

function loadInput(inputPath) {
  const text = readText(inputPath);
  const extension = path.extname(inputPath).toLowerCase();
  if (extension === '.json') {
    const parsed = JSON.parse(text);
    // Accept the common response envelopes: [..], {rows}, {data}, {data: {rows}}, {results}.
    const candidates = [parsed, parsed?.rows, parsed?.data, parsed?.data?.rows, parsed?.results, parsed?.data?.results];
    const records = candidates.find((candidate) => Array.isArray(candidate));
    if (!records) throw new UsageError(`${path.basename(inputPath)}: no row array found (expected an array, or rows/data/results holding one)`);
    return {text, records, meta: Array.isArray(parsed) ? {} : parsed};
  }
  if (extension === '.csv') return {text, records: parseCsv(text), meta: {}};
  return {text, records: null, meta: {}};
}

const GSC_DIMENSION_ALIASES = {
  date: ['date', 'day'],
  query: ['query', 'queries', 'top_queries', 'keyword'],
  page: ['page', 'pages', 'top_pages', 'url', 'landing_page'],
  country: ['country', 'countries'],
  device: ['device', 'devices'],
  segment: ['segment', 'market'],
};

function normalizeGsc(records, {dimensions: declared}) {
  const rows = [];
  for (const record of records) {
    const row = {};
    if (Array.isArray(record.keys)) {
      if (!declared?.length) throw new UsageError('GSC rows with `keys` need --dimensions matching the query (e.g. date,page)');
      declared.forEach((dimension, index) => {
        row[dimension] = record.keys[index];
      });
    } else {
      const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, '_'), value]));
      for (const [dimension, aliases] of Object.entries(GSC_DIMENSION_ALIASES)) {
        const value = pick(lower, aliases);
        if (value !== undefined) row[dimension] = String(value);
      }
      Object.assign(record, lower);
    }
    if (row.date) row.date = isoDate(row.date);
    // A missing or invalid cell stays null (unknown), never 0: aggregation
    // skips and counts it, and data quality reports it.
    row.clicks = number(record.clicks);
    row.impressions = number(record.impressions);
    row.ctr = ctrFraction(record.ctr);
    row.position = number(record.position);
    rows.push(row);
  }
  const dimensions = declared?.length ? declared : Object.keys(GSC_DIMENSION_ALIASES).filter((dimension) => rows.some((row) => row[dimension] !== undefined));
  return {rows, dimensions};
}

// Legacy seo-rankings markdown: frontmatter/blockquote date range, then one
// `### <MARKET>` section per market followed by a Query|Page|Impressions|
// Position|CTR|Clicks table.
function normalizeSeoRankingsMarkdown(text, segmentMap = {}) {
  const {data} = parseFrontmatter(text);
  const warnings = ['imported from seo-rankings markdown; tables are top-N query×page rows, not headline totals'];
  let start = isoDate(data?.range_start);
  let end = isoDate(data?.range_end);
  if (!start || !end) {
    const range = text.match(/Date range:\*{0,2}\s*(\d{4}-\d{2}-\d{2})\s*(?:→|->|to)\s*(\d{4}-\d{2}-\d{2})/);
    if (range) [start, end] = [range[1], range[2]];
  }
  const rows = [];
  let segment = null;
  let headers = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      const label = heading[1].trim();
      const code = label.match(/^([A-Z]{2,3})\b/) ?? label.match(/\(([a-z]{2})\)/);
      const raw = code ? code[1] : label;
      segment = segmentMap[raw] ?? segmentMap[raw.toLowerCase()] ?? raw;
      headers = null;
      continue;
    }
    if (!line.startsWith('|')) {
      if (line.trim() === '') headers = headers && null;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const lowered = cells.map((cell) => cell.toLowerCase());
    if (lowered.includes('query') && lowered.includes('impressions')) {
      headers = lowered;
      continue;
    }
    if (!headers || !segment) continue;
    const cell = (name) => cells[headers.indexOf(name)];
    const query = cell('query');
    if (!query || query.startsWith('{') || query === '...') continue;
    rows.push({
      segment,
      query: query.replace(/^`|`$/g, ''),
      page: (cell('page') ?? '').replace(/^`|`$/g, '') || null,
      clicks: number(cell('clicks')) ?? 0,
      impressions: number(cell('impressions')) ?? 0,
      ctr: ctrFraction(cell('ctr')),
      position: number(cell('position') ?? cell('pos')),
    });
  }
  if (!start || !end) throw new UsageError('seo-rankings markdown needs range_start/range_end frontmatter or a "Date range:" line');
  return {rows, dimensions: ['segment', 'query', 'page'], period: {start, end}, warnings};
}

function positionOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (text === '' || text === '-' || text.startsWith('>') || text.includes('not') || text === 'n/a' || text === 'null') return null;
  return number(text);
}

function listField(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(/[|;]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeRankings(records, {provider, observedAt}) {
  const rows = records.map((record) => {
    const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, '_'), value]));
    const keyword = pick(lower, ['keyword', 'query', 'term']);
    if (!keyword) throw new UsageError('ranking row without keyword/query');
    const observed = pick(lower, ['observed_at', 'date', 'checked_at', 'timestamp']) ?? observedAt;
    if (!observed) throw new UsageError(`ranking row "${keyword}" has no observed_at; pass --observed-at`);
    return {
      keyword: String(keyword),
      location: String(pick(lower, ['location', 'country', 'market', 'geo']) ?? 'unspecified'),
      device: String(pick(lower, ['device']) ?? 'desktop').toLowerCase(),
      engine: String(pick(lower, ['engine', 'search_engine']) ?? 'google').toLowerCase(),
      position: positionOrNull(pick(lower, ['position', 'rank', 'current_position'])),
      url: pick(lower, ['url', 'landing_page', 'ranking_url', 'page']) ?? null,
      serp_features: listField(pick(lower, ['serp_features', 'features'])),
      observed_at: String(observed),
      provider: String(pick(lower, ['provider']) ?? provider ?? 'unknown'),
    };
  });
  const dates = rows.map((row) => isoDate(row.observed_at)).filter(Boolean).sort();
  return {rows, dimensions: ['keyword', 'location', 'device', 'engine', 'observed_at'], period: dates.length ? {start: dates[0], end: dates.at(-1)} : null};
}

function normalizeTimeseries(records, {metric, segment}) {
  if (records.length === 0) return {rows: [], dimensions: ['date', 'metric']};
  const headers = Object.keys(records[0]).map((key) => key.toLowerCase());
  const rows = [];
  for (const record of records) {
    const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, '_'), value]));
    const date = isoDate(pick(lower, ['date', 'day']));
    if (!date) throw new UsageError('timeseries rows need a date column');
    const rowSegment = pick(lower, ['segment']) ?? segment ?? undefined;
    if (headers.includes('metric') && headers.includes('value')) {
      rows.push({date, metric: String(lower.metric), value: number(lower.value), ...(rowSegment ? {segment: String(rowSegment)} : {})});
    } else if (headers.includes('value')) {
      if (!metric) throw new UsageError('single-value timeseries needs --metric <series name>');
      rows.push({date, metric, value: number(lower.value), ...(rowSegment ? {segment: String(rowSegment)} : {})});
    } else {
      for (const [key, value] of Object.entries(lower)) {
        if (['date', 'day', 'segment'].includes(key)) continue;
        rows.push({date, metric: key, value: number(value), ...(rowSegment ? {segment: String(rowSegment)} : {})});
      }
    }
  }
  return {rows, dimensions: rows.some((row) => row.segment) ? ['date', 'metric', 'segment'] : ['date', 'metric']};
}

function bool(value) {
  if (value === undefined || value === null || value === '') return null;
  return /^(true|yes|1|y)$/i.test(String(value).trim());
}

function normalizeCrawl(records) {
  const rows = records.map((record) => {
    const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, '_'), value]));
    const url = pick(lower, ['url', 'address']);
    if (!url) throw new UsageError('crawl row without url');
    return {
      url: String(url),
      status: number(pick(lower, ['status', 'status_code', 'http_status'])),
      redirect_to: pick(lower, ['redirect_to', 'redirect_url', 'location']) ?? null,
      redirect_hops: number(pick(lower, ['redirect_hops', 'redirect_chain_length', 'hops'])) ?? 0,
      canonical: pick(lower, ['canonical', 'canonical_url', 'canonical_link_element_1']) ?? null,
      title: pick(lower, ['title', 'title_1']) ?? null,
      meta_description: pick(lower, ['meta_description', 'description', 'meta_description_1']) ?? null,
      robots: pick(lower, ['robots', 'meta_robots', 'meta_robots_1']) ?? null,
      in_sitemap: bool(pick(lower, ['in_sitemap', 'sitemap'])),
      inlinks: number(pick(lower, ['inlinks', 'internal_inlinks', 'unique_inlinks'])),
      structured_data_errors: number(pick(lower, ['structured_data_errors', 'schema_errors'])),
    };
  });
  return {rows, dimensions: ['url']};
}

function normalizeCwv(records) {
  const rows = records.map((record) => {
    const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, '_'), value]));
    const target = pick(lower, ['url', 'origin', 'page']);
    if (!target) throw new UsageError('cwv row without url/origin');
    return {
      url: String(target),
      form_factor: String(pick(lower, ['form_factor', 'device']) ?? 'phone').toLowerCase(),
      lcp_p75_ms: number(pick(lower, ['lcp_p75_ms', 'lcp_ms', 'lcp'])),
      inp_p75_ms: number(pick(lower, ['inp_p75_ms', 'inp_ms', 'inp'])),
      cls_p75: number(pick(lower, ['cls_p75', 'cls'])),
      date: isoDate(pick(lower, ['date', 'observed_at', 'collection_period_end'])) ?? undefined,
    };
  });
  return {rows, dimensions: rows.some((row) => row.date) ? ['url', 'form_factor', 'date'] : ['url', 'form_factor']};
}

const INDEX_VERDICTS = [
  [/submitted and indexed|^indexed|indexed, not submitted|url is on google|^pass$/i, 'indexed'],
  [/crawled.*not indexed/i, 'crawled_not_indexed'],
  [/discovered.*not indexed/i, 'discovered_not_indexed'],
  [/noindex/i, 'excluded_noindex'],
  [/canonical/i, 'canonical_mismatch'],
  [/not found|404/i, 'not_found'],
  [/redirect/i, 'redirect'],
  [/robots/i, 'blocked_robots'],
  [/server error|5xx/i, 'server_error'],
  [/soft 404/i, 'soft_404'],
  [/^(unknown|neutral|)$/i, 'unknown'],
];

function indexVerdict(value) {
  const text = String(value ?? '').trim();
  for (const [pattern, verdict] of INDEX_VERDICTS) if (pattern.test(text)) return verdict;
  return 'other';
}

function normalizeIndexation(records) {
  const rows = records.map((record) => {
    const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, '_'), value]));
    const url = pick(lower, ['url', 'page']);
    if (!url) throw new UsageError('indexation row without url');
    const raw = pick(lower, ['verdict', 'coverage_state', 'status', 'coverage', 'reason']) ?? '';
    return {
      url: String(url),
      verdict: indexVerdict(raw),
      coverage_state: String(raw),
      google_canonical: pick(lower, ['google_canonical', 'google-selected_canonical']) ?? null,
      user_canonical: pick(lower, ['user_canonical', 'user-declared_canonical']) ?? null,
      last_crawl: pick(lower, ['last_crawl', 'last_crawl_time', 'last_crawled']) ?? null,
      in_sitemap: bool(pick(lower, ['in_sitemap', 'sitemap'])),
    };
  });
  return {rows, dimensions: ['url']};
}

// Build a snapshot object from an input file.
export function normalizeInput({adapter, inputPath, sourceId, property, dimensions, start, end, metric, segment, provider, observedAt, set = {}, segmentMap = {}, retrievedAt}) {
  const definition = ADAPTERS[adapter];
  if (!definition) throw new UsageError(`unknown adapter ${adapter}; known: ${Object.keys(ADAPTERS).join(', ')}`);
  const {text, records} = loadInput(inputPath);
  let normalized;
  if (adapter === 'seo-rankings-md') {
    normalized = normalizeSeoRankingsMarkdown(text, segmentMap);
  } else {
    if (!records) throw new UsageError(`adapter ${adapter} reads .json or .csv input, got ${path.basename(inputPath)}`);
    normalized = {
      gsc: () => normalizeGsc(records, {dimensions}),
      rankings: () => normalizeRankings(records, {provider, observedAt}),
      timeseries: () => normalizeTimeseries(records, {metric, segment}),
      crawl: () => normalizeCrawl(records),
      cwv: () => normalizeCwv(records),
      indexation: () => normalizeIndexation(records),
    }[adapter]();
  }
  for (const row of normalized.rows) Object.assign(row, set);
  const dims = [...new Set([...(normalized.dimensions ?? []), ...Object.keys(set)])];
  const dates = normalized.rows.map((row) => isoDate(row.date)).filter(Boolean).sort();
  const period = normalized.period ?? (start && end ? {start, end} : dates.length ? {start: dates[0], end: dates.at(-1)} : null);
  if (!period && ['gsc_rows', 'timeseries'].includes(definition.kind)) throw new UsageError('cannot infer the period: rows have no dates, pass --start and --end');
  if (start && end && dates.length && (dates[0] < start || dates.at(-1) > end)) throw new UsageError(`rows span ${dates[0]}..${dates.at(-1)}, outside --start/--end ${start}..${end}`);
  const warnings = [...(normalized.warnings ?? [])];
  // Headline safety is contextual (a page-scoped measurement may sum page
  // rows), so it is recorded as a note, not a data warning; measurement code
  // raises it as an issue only when a property-level total is requested.
  const headlineSafe = definition.kind === 'gsc_rows' ? !dims.includes('query') && !dims.includes('page') : null;
  const headlineNote = definition.kind === 'gsc_rows' && !headlineSafe
    ? (dims.includes('page') ? 'page-dimension rows count a search once per URL shown; do not sum them for property totals' : 'query rows omit anonymized queries; sums undercount totals')
    : null;
  // Redact before hashing so the stored rows and their hash agree; the count
  // is kept as a warning because redacted cells change what was observed.
  const redacted = redact(JSON.stringify(normalized.rows));
  const rows = JSON.parse(redacted.text);
  if (redacted.count > 0) warnings.push(`${redacted.count} value(s) redacted as secrets or personal data before storage`);
  const rowsJson = JSON.stringify(rows);
  return {
    schema_version: 1,
    kind: definition.kind,
    source_id: sourceId,
    adapter,
    adapter_version: definition.version,
    property: property ?? null,
    retrieved_at: retrievedAt,
    period,
    dimensions: dims,
    filters: set,
    headline_safe: headlineSafe,
    headline_note: headlineNote,
    input: {file: path.basename(inputPath), sha256: sha256(text)},
    row_count: rows.length,
    rows_sha256: sha256(rowsJson),
    warnings,
    rows,
  };
}
