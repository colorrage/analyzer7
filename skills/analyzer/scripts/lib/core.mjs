// Analyzer7 core helpers: state-root resolution, flat frontmatter, ID
// allocation, indexes, CSV, dates, hashing, and argument parsing.
//
// Dependency-free by design (Node >= 18 built-ins only). Frontmatter is flat
// `key: value` so that sibling harness parsers (Marketer7 is strict) can read
// every file Analyzer7 hands them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import zlib from 'node:zlib';
import {redact} from './redact.mjs';

export const STATE_DIR = '.analyzer';
export const SCHEMA_VERSION = 1;

// ---------- errors and arguments ----------

export class UsageError extends Error {}

export function parseArgs(argv, {flags = [], options = [], lists = []} = {}) {
  const result = {_: []};
  const flagSet = new Set(flags);
  const optionSet = new Set([...options, ...lists]);
  const listSet = new Set(lists);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      result._.push(argument);
      continue;
    }
    const [rawName, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);
    if (flagSet.has(rawName)) {
      result[camel(rawName)] = true;
      continue;
    }
    if (!optionSet.has(rawName)) throw new UsageError(`unknown option --${rawName}`);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) throw new UsageError(`--${rawName} requires a value`);
    if (listSet.has(rawName)) {
      const key = camel(rawName);
      result[key] = [...(result[key] ?? []), ...value.split(',').map((item) => item.trim()).filter(Boolean)];
    } else {
      result[camel(rawName)] = value;
    }
  }
  return result;
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function runCli(main) {
  try {
    const exitCode = main(process.argv.slice(2));
    if (typeof exitCode === 'number') process.exitCode = exitCode;
  } catch (error) {
    const prefix = error instanceof UsageError ? 'usage error' : 'error';
    process.stderr.write(`analyzer7 ${prefix}: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

// Scope filters shared by CLIs: --page (list), --query, --country, --device, --segment.
export function scopeFromArgs(args) {
  const scope = {};
  if (args.page) scope.page = args.page.length === 1 ? args.page[0] : args.page;
  for (const key of ['query', 'country', 'device', 'segment']) if (args[key]) scope[key] = args[key];
  return scope;
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------- state root ----------

// Resolution: explicit --project > nearest ancestor containing .analyzer/ >
// git top-level > cwd. The project root is where neighbor harness roots
// (.marketer/, .signal/, .hyper/, .scout/) are also looked up.
export function resolveProject(explicit) {
  if (explicit) {
    const absolute = path.resolve(explicit);
    if (!fs.existsSync(absolute)) throw new UsageError(`--project path does not exist: ${absolute}`);
    return absolute.endsWith(`${path.sep}${STATE_DIR}`) ? path.dirname(absolute) : absolute;
  }
  let current = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(current, STATE_DIR))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'});
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  return process.cwd();
}

export function stateRoot(project) {
  return path.join(project, STATE_DIR);
}

export function requireInitialized(project) {
  const root = stateRoot(project);
  if (!fs.existsSync(path.join(root, 'project.md'))) {
    throw new UsageError(`Analyzer7 is not initialized in ${project}; run init.mjs first`);
  }
  return root;
}

// ---------- files ----------

export function readText(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

export function readJson(filePath, fallback = undefined) {
  if (!fs.existsSync(filePath)) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`missing JSON file: ${filePath}`);
  }
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    throw new UsageError(`invalid JSON in ${filePath}: ${error.message}`);
  }
}

export function listDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, {withFileTypes: true});
  } catch {
    return [];
  }
}

// Every Analyzer7 write passes through redaction so secrets and unnecessary
// PII never reach state, reports, or evidence.
export function writeRedacted(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const {text} = redact(content);
  fs.writeFileSync(filePath, text);
  return filePath;
}

// Create-only write. Refuses to overwrite: history is append-only.
export function writeNew(filePath, content) {
  if (fs.existsSync(filePath)) throw new Error(`refusing to overwrite existing file ${filePath}`);
  return writeRedacted(filePath, content);
}

export function writeJson(filePath, value) {
  return writeRedacted(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// Observation snapshots are stored gzip-compressed (`.json.gz`, compact JSON).
// Readers accept both forms, so references written before compaction keep
// resolving: `x.json` falls back to `x.json.gz`.
export function writeGzipJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const {text} = redact(JSON.stringify(value));
  fs.writeFileSync(filePath, zlib.gzipSync(text, {level: 9}));
  return filePath;
}

export function readMaybeGzipJson(filePath) {
  const buffer = fs.readFileSync(filePath);
  const text = filePath.endsWith('.gz') ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function resolveObservationPath(filePath) {
  if (fs.existsSync(filePath)) return filePath;
  if (!filePath.endsWith('.gz') && fs.existsSync(`${filePath}.gz`)) return `${filePath}.gz`;
  return null;
}

export function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const extension = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - extension.length);
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}${extension}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export function relative(project, absolutePath) {
  return path.relative(project, absolutePath).split(path.sep).join('/');
}

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function slugify(text, maxLength = 48) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'record';
}

// ---------- frontmatter ----------

export function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value === '' || value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '[]') return [];
  if (value === '{}') return {};
  if (value.startsWith('[') && value.endsWith(']')) return parseList(value.slice(1, -1));
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return stripQuotes(value);
}

// Inline list items, splitting on commas outside double quotes. Items are
// strings unless they are plain numbers (the writer quotes anything else).
function parseList(inner) {
  const items = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === '\\' && quoted && inner[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
      current += character;
    } else if (character === ',' && !quoted) {
      items.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== '').map((item) => (/^-?\d+(?:\.\d+)?$/.test(item) ? Number(item) : stripQuotes(item)));
}

function stripQuotes(value) {
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

// Returns {data, body, error}. Nested YAML (indented lines) is tolerated and
// skipped, so Signal7 task files with `tracking:` maps remain readable; their
// nested keys are exposed through `nested` for the few readers that need them.
export function parseFrontmatter(text) {
  const source = text.replace(/\r\n/g, '\n');
  if (!source.startsWith('---\n')) return {data: null, body: source, error: 'missing opening frontmatter delimiter'};
  const closing = source.indexOf('\n---', 3);
  if (closing === -1) return {data: null, body: source, error: 'missing closing frontmatter delimiter'};
  const header = source.slice(4, closing).split('\n');
  const afterClosing = source.indexOf('\n', closing + 1);
  const body = afterClosing === -1 ? '' : source.slice(afterClosing + 1);
  const data = {};
  const nested = {};
  let parent = null;
  for (const [index, line] of header.entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s+/.test(line)) {
      if (!parent) continue;
      const nestedMatch = line.match(/^\s+(?:-\s+)?([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/);
      if (nestedMatch) {
        nested[parent] ??= {};
        nested[parent][nestedMatch[1]] ??= parseScalar(nestedMatch[2]);
      }
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s(.*))?$/);
    if (!match) return {data: null, body: source, error: `unsupported frontmatter line ${index + 1}: ${line}`};
    if (Object.hasOwn(data, match[1])) return {data: null, body: source, error: `duplicate frontmatter key ${match[1]}`};
    const raw = match[2] ?? '';
    data[match[1]] = parseScalar(raw);
    parent = raw.trim() === '' ? match[1] : null;
  }
  return {data, body, nested, error: null};
}

export function readDocument(filePath) {
  const parsed = parseFrontmatter(readText(filePath));
  return {...parsed, path: filePath};
}

function serializeScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => serializeListItem(item)).join(', ')}]`;
  if (typeof value === 'object') throw new Error('frontmatter values must be scalars or lists; nested objects belong in JSON registries');
  const text = String(value);
  if (text === '' || /^[\s[{>|*&!%@`'"]/.test(text) || /:\s|\s#|[\n\r]/.test(text) || /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(text) || text.endsWith(':')) {
    return `"${text.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
  }
  return text;
}

function serializeListItem(item) {
  if (typeof item === 'number') return String(item);
  if (item !== null && typeof item === 'object') throw new Error('frontmatter lists hold scalars only');
  const text = String(item);
  // Quote anything that would not read back as the same string.
  return /[,\]\["]|^\s|\s$|^-?\d+(?:\.\d+)?$/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

export function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${serializeScalar(value)}`);
  }
  lines.push('---', '', '');
  return lines.join('\n');
}

export function renderDocument(data, body) {
  return `${serializeFrontmatter(data)}${body.replace(/^\n+/, '')}${body.endsWith('\n') ? '' : '\n'}`;
}

// Update frontmatter fields of an existing document in place, preserving the
// body. Used only for living-state records (anomalies, opportunities, plans).
export function updateDocument(filePath, changes, appendBody = '') {
  const document = readDocument(filePath);
  if (document.error) throw new Error(`${filePath}: ${document.error}`);
  const data = {...document.data, ...changes};
  const body = appendBody ? `${document.body.replace(/\n+$/, '')}\n${appendBody}` : document.body;
  writeRedacted(filePath, renderDocument(data, body));
  return data;
}

// ---------- IDs and indexes ----------

export const RECORD_KINDS = {
  evidence: {prefix: 'EV', dir: 'evidence', label: 'Evidence'},
  change: {prefix: 'CH', dir: 'changes', label: 'Changes'},
  baseline: {prefix: 'BL', dir: 'baselines', label: 'Baselines'},
  anomaly: {prefix: 'AN', dir: 'anomalies', label: 'Anomalies'},
  opportunity: {prefix: 'SEO-OPP', dir: 'seo/opportunities', label: 'SEO opportunities'},
};

export function recordDir(root, kind) {
  return path.join(root, RECORD_KINDS[kind].dir);
}

function idNumber(prefix, text) {
  const match = new RegExp(`^${prefix}-(\\d+)(?:-|\\.md$|$)`).exec(text);
  return match ? Number(match[1]) : null;
}

// Next ID = max(ID found in file names or index lines) + 1. Nothing is stored,
// so the allocator cannot drift and archived/removed IDs are never reissued as
// long as the index line remains (indexes are append-only).
export function nextId(root, kind) {
  const {prefix} = RECORD_KINDS[kind];
  const dir = recordDir(root, kind);
  let max = 0;
  for (const entry of listDir(dir)) {
    const number = idNumber(prefix, entry.name);
    if (number !== null) max = Math.max(max, number);
  }
  const indexPath = path.join(dir, 'index.md');
  if (fs.existsSync(indexPath)) {
    for (const match of readText(indexPath).matchAll(new RegExp(`\\[(${prefix}-(\\d+))\\]`, 'g'))) {
      max = Math.max(max, Number(match[2]));
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export function listRecords(root, kind) {
  const {prefix} = RECORD_KINDS[kind];
  const dir = recordDir(root, kind);
  const records = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || idNumber(prefix, entry.name) === null) continue;
    const document = readDocument(path.join(dir, entry.name));
    records.push({file: entry.name, path: document.path, data: document.data ?? {}, body: document.body, error: document.error});
  }
  return records.sort((left, right) => idNumber(prefix, left.file) - idNumber(prefix, right.file));
}

export function appendIndex(root, kind, id, file, summary) {
  const {label} = RECORD_KINDS[kind];
  const indexPath = path.join(recordDir(root, kind), 'index.md');
  if (!fs.existsSync(indexPath)) {
    writeRedacted(indexPath, `# ${label} index\n\nAppend-only. One line per record; the record file is canonical.\n\n`);
  }
  const line = `- [${id}](${file}) — ${summary.replace(/\n/g, ' ')}\n`;
  fs.appendFileSync(indexPath, redact(line).text);
}

export function readIndex(root, kind) {
  const indexPath = path.join(recordDir(root, kind), 'index.md');
  if (!fs.existsSync(indexPath)) return [];
  const lines = [];
  for (const line of readText(indexPath).split('\n')) {
    const match = line.match(/^- \[([A-Z-]+-\d+)\]\(([^)]+)\) — (.*)$/);
    if (match) lines.push({id: match[1], file: match[2], summary: match[3]});
  }
  return lines;
}

// Allocate an ID, write the record create-only, and append its index line.
// `body` may be a function of the allocated id.
export function createRecord(root, kind, {title, data, body, summary}) {
  const id = nextId(root, kind);
  const file = `${id}-${slugify(title)}.md`;
  const filePath = path.join(recordDir(root, kind), file);
  const content = typeof body === 'function' ? body(id) : body;
  writeNew(filePath, renderDocument({schema_version: SCHEMA_VERSION, id, ...data}, content));
  appendIndex(root, kind, id, file, typeof summary === 'function' ? summary(id) : summary ?? title);
  return {id, file, path: filePath};
}

export function findRecord(root, kind, id) {
  return listRecords(root, kind).find((record) => record.data.id === id) ?? null;
}

// ---------- CSV ----------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/\r\n/g, '\n');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const headers = nonEmpty[0].map((header) => header.trim().toLowerCase().replace(/\s+/g, '_'));
  return nonEmpty.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? '').trim()])));
}

// ---------- dates ----------

const DAY_MS = 86400000;

export function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function dateToMs(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date, days) {
  return new Date(dateToMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysInclusive(start, end) {
  return Math.round((dateToMs(end) - dateToMs(start)) / DAY_MS) + 1;
}

export function eachDate(start, end) {
  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '' || value === 'unknown') return null;
  const text = String(value).trim();
  const withZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.length === 10 ? `${text}T00:00:00` : text}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

export function hasTimezone(value) {
  return /[zZ]$|[+-]\d{2}:?\d{2}$/.test(String(value ?? '').trim());
}

export function nowIso(explicit) {
  if (explicit) {
    const ms = parseTimestamp(explicit);
    if (ms === null) throw new UsageError(`invalid --now timestamp: ${explicit}`);
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// "2026-08-29T00:00:00Z to 2026-09-25T23:59:59Z", "2026-08-29 → 2026-09-25",
// "2026-08-29..2026-09-25" → {start, end} as YYYY-MM-DD.
export function parsePeriod(text) {
  if (!text) return null;
  const dates = [...String(text).matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((match) => match[1]);
  if (dates.length < 2) return null;
  const [start, end] = [dates[0], dates[dates.length - 1]];
  return start <= end ? {start, end} : null;
}

// ---------- URLs ----------

export function normalizePage(value) {
  if (value === null || value === undefined || value === '') return null;
  let text = String(value).trim();
  try {
    if (/^https?:\/\//i.test(text)) text = new URL(text).pathname;
  } catch {
    // keep the raw text
  }
  text = text.split('#')[0].split('?')[0];
  if (!text.startsWith('/')) text = `/${text}`;
  if (text.length > 1) text = text.replace(/\/+$/, '');
  return decodeURI(text);
}

export function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------- temporary export files (connectors, derived snapshots) ----------

export function writeExport(name, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer7-connector-'));
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

export function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n');
}
