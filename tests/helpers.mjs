// Shared test helpers. Every test works on a throwaway copy of a fixture in
// the OS temp directory; nothing touches the repository fixtures or ~/.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = path.join(REPO, 'skills', 'analyzer', 'scripts');
export const FIXTURES = path.join(REPO, 'fixtures', 'analyzer');
export const MARKETER_REPO = path.resolve(REPO, '..', 'marketer7');
export const SIGNAL_REPO = path.resolve(REPO, '..', 'signal7', 'marketer7-integration');

export function tempDir(prefix = 'analyzer7-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyFixture(name = 'ecosystem') {
  const directory = tempDir();
  fs.cpSync(path.join(FIXTURES, name), directory, {recursive: true});
  return directory;
}

export function run(script, args, {expectFail = false, json = true} = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {encoding: 'utf8'});
  if (expectFail) {
    assert.notEqual(result.status, 0, `${script} ${args.join(' ')} should fail\n${result.stdout}`);
    return result;
  }
  assert.equal(result.status, 0, `${script} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return json ? JSON.parse(result.stdout) : result.stdout;
}

export function hashTree(directory) {
  const hash = crypto.createHash('sha256');
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        hash.update(path.relative(directory, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return hash.digest('hex');
}

export function neighborHashes(project) {
  return Object.fromEntries(['.marketer', '.signal', '.hyper', '.scout'].map((root) => [root, hashTree(path.join(project, root))]));
}

export const T = {
  planning: '2026-08-29T08:00:00Z',
  midWindow: '2026-09-20T08:00:00Z',
  ingest: '2026-09-28T09:00:00Z',
  evaluate: '2026-09-28T09:30:00Z',
};

// The standard project: Search Console registered and the daily page export
// ingested, Signal7 publications imported as changes.
export function setupEcosystem(project, {timezone = 'Europe/Bucharest', sourceTimezone = 'Europe/Bucharest'} = {}) {
  run('init.mjs', ['--project', project, '--seed', 'seo', '--timezone', timezone, '--now', T.planning]);
  run('record.mjs', ['source', '--project', project, '--id', 'gsc', '--type', 'search', '--provider', 'google_search_console', '--adapter', 'gsc', '--property', 'sc-domain:example.test', '--auth-method', 'mcp', '--auth-reference', 'Google Search Console MCP server', '--timezone', sourceTimezone, '--expected-lag-hours', '72', '--stale-after-hours', '96', '--now', T.planning]);
  run('discover.mjs', ['--project', project, '--import-changes', '--now', T.planning]);
  return project;
}

export function ingestDailyPages(project, now = T.ingest) {
  return run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', path.join(project, 'inputs', 'gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', now]);
}

export function evaluateEx014(project, {extraArgs = []} = {}) {
  run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-014', '--record-baseline', '--now', T.planning]);
  ingestDailyPages(project);
  return run('experiment.mjs', ['evaluate', '--project', project, '--experiment', 'EX-014', '--record', '--now', T.evaluate, ...extraArgs]);
}

export function readFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const header = text.slice(4, text.indexOf('\n---', 3));
  return Object.fromEntries(header.split('\n').filter((line) => /^[A-Za-z_]/.test(line)).map((line) => {
    const index = line.indexOf(':');
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
}

export function validateState(project) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, 'validate-state.mjs'), '--project', project], {encoding: 'utf8'});
  return {ok: result.status === 0, output: `${result.stdout}${result.stderr}`};
}

export function writeCsv(filePath, header, rows) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, [header, ...rows].join('\n'));
  return filePath;
}

export function days(start, count) {
  return Array.from({length: count}, (_, index) => new Date(Date.parse(`${start}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
}
