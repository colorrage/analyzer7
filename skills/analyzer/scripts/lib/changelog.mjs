// Import change records from a project's own change log: a CSV file or a
// markdown table (release logs, deploy logs, SEO change tables). Columns are
// matched by name; nothing is guessed silently:
//   - a lone "Date" column is ambiguous (applied or deployed?) and must be
//     declared with --date-means applied|deployed;
//   - a cell without a recognizable path ("56 items") is an unknown scope;
//   - re-importing the same file is idempotent (origin_ref per row).

import path from 'node:path';
import {UsageError, isoDate, normalizePage, parseCsv, readText, sha256} from './core.mjs';

const COLUMNS = {
  deployed: ['deployed_at', 'deploy date', 'deploy_date', 'deployed', 'live date', 'live_at', 'released', 'release date'],
  applied: ['applied_at', 'applied', 'apply date', 'applied date'],
  date: ['date', 'timestamp', 'when'],
  pages: ['url(s)', 'urls', 'url', 'pages', 'page', 'path', 'paths'],
  type: ['change type', 'change_type', 'type', 'kind'],
  title: ['title', 'change', 'summary', 'description'],
  task: ['task', 'ticket', 'id', 'issue'],
  notes: ['notes', 'note', 'comment'],
};

function column(headers, names) {
  const lowered = headers.map((header) => header.toLowerCase().trim());
  for (const name of names) {
    const index = lowered.indexOf(name);
    if (index !== -1) return headers[index];
  }
  return null;
}

// Markdown table rows under an optional heading (the first table otherwise).
function markdownRows(text, heading) {
  const lines = text.split('\n');
  let start = 0;
  if (heading) {
    const index = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.toLowerCase().includes(heading.toLowerCase()));
    if (index === -1) throw new UsageError(`no heading containing "${heading}"`);
    start = index + 1;
  }
  const rows = [];
  let headers = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) {
      if (headers) break;
      if (heading && /^#{1,6}\s/.test(line)) break;
      continue;
    }
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (!headers) {
      headers = cells;
      continue;
    }
    rows.push(Object.fromEntries(headers.map((header, position) => [header, cells[position] ?? ''])));
  }
  if (!headers) throw new UsageError('no markdown table found');
  return {headers, rows};
}

function pagesIn(cell) {
  const found = new Set();
  for (const match of String(cell ?? '').matchAll(/`([^`]+)`|(https?:\/\/[^\s|,)]+)|(?:^|\s)(\/[A-Za-z0-9._~%\-/]+)/g)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!value.startsWith('/') && !/^https?:\/\//.test(value)) continue;
    if (/\*/.test(value)) continue; // wildcards are not a page list
    found.add(normalizePage(value));
  }
  return [...found];
}

export function changeTypeFrom(text, fallback) {
  const value = String(text ?? '').toLowerCase();
  if (/track|analytics|ga4|gtm|pixel|consent/.test(value)) return 'tracking_change';
  if (/redirect|canonical|hreflang|schema|robots|sitemap|noindex|index/.test(value)) return 'technical_seo_fix';
  if (/pric|billing|checkout|plan/.test(value)) return 'pricing_change';
  if (/new content|new post|new page|launch/.test(value)) return 'content_publish';
  if (/meta|title|content|copy|link/.test(value)) return 'seo_content_update';
  if (/deploy|release/.test(value)) return 'deployment';
  return fallback;
}

// Returns change field objects ready for registerChange.
export function parseChangeLog(filePath, {table = null, dateMeans = null, defaultType = 'other', origin = 'manual', deployStatus = null, project}) {
  const text = readText(filePath);
  const {headers, rows} = path.extname(filePath).toLowerCase() === '.csv'
    ? (() => {
      const parsed = parseCsv(text);
      return {headers: parsed.length ? Object.keys(parsed[0]) : [], rows: parsed};
    })()
    : markdownRows(text, table);
  const map = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [key, column(headers, names)]));
  if (!map.deployed && !map.applied && !map.date) throw new UsageError(`no date column found (looked for ${[...COLUMNS.deployed, ...COLUMNS.applied, ...COLUMNS.date].join(', ')})`);
  if (map.date && !map.deployed && !map.applied && !dateMeans) throw new UsageError(`column "${map.date}" is ambiguous: pass --date-means deployed (it is the go-live date) or --date-means applied (changes were applied but went live later)`);
  const relativeFile = path.relative(project, filePath).split(path.sep).join('/');
  return rows.filter((row) => Object.values(row).some((value) => String(value).trim())).map((row, index) => {
    const dateCell = map.date ? row[map.date] : null;
    const deployedRaw = map.deployed ? row[map.deployed] : dateMeans === 'deployed' ? dateCell : null;
    const appliedRaw = map.applied ? row[map.applied] : dateMeans === 'applied' ? dateCell : null;
    const deployed = isoDate(deployedRaw) ? String(deployedRaw).trim().match(/^\S+/)[0] : null;
    const applied = isoDate(appliedRaw) ? String(appliedRaw).trim().match(/^\S+/)[0] : null;
    const pages = pagesIn(map.pages ? row[map.pages] : '');
    const typeText = map.type ? row[map.type] : '';
    const task = map.task ? String(row[map.task] ?? '').trim() : '';
    const titleCell = map.title ? String(row[map.title] ?? '').trim() : '';
    const title = (titleCell || `${task ? `${task}: ` : ''}${typeText || 'change'} ${pages.length ? pages.slice(0, 3).join(', ') + (pages.length > 3 ? ` (+${pages.length - 3})` : '') : String(map.pages ? row[map.pages] : '').replace(/`/g, '').slice(0, 60)}`).replace(/\*\*/g, '').slice(0, 140);
    const status = deployed ? 'deployed' : deployStatus ?? (applied ? 'pending' : 'unknown');
    return {
      title,
      origin,
      origin_ref: `import:${relativeFile}#${index + 1}:${sha256(JSON.stringify(row)).slice(0, 12)}`,
      type: changeTypeFrom(`${typeText} ${titleCell}`, defaultType),
      timestamp: status === 'deployed' ? deployed ?? undefined : undefined,
      timestamp_basis: deployed ? 'deploy_log' : 'unknown',
      deploy_status: status === 'deployed' && !deployed ? 'unknown' : status,
      applied_at: applied,
      pages,
      source_path: relativeFile,
      details: [
        `Imported from ${relativeFile}, row ${index + 1}${task ? ` (${task})` : ''}`,
        ...(typeText ? [`change type: ${String(typeText).replace(/\*\*/g, '')}`] : []),
        ...(pages.length ? [] : ['no page paths in the row: scope unknown (treated as site-wide)']),
        ...(map.notes && row[map.notes] ? [`notes: ${String(row[map.notes]).replace(/\*\*/g, '').slice(0, 300)}`] : []),
      ],
    };
  });
}
