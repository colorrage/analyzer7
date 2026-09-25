// Change-log import, applied vs deployed dates, and marking changes deployed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {days, run, tempDir, validateState, writeCsv} from './helpers.mjs';

const NOW = '2026-10-01T08:00:00Z';

// Modeled on a real SEO release log: summary rows without paths, a wildcard,
// and edits applied locally that only went live in a later sync.
const RELEASE_LOG = `# SEO Release Log

Intro text with a table that is not the change table:

| Confident attribution | Effectively unmeasurable |
|---|---|
| RO 4.9% | SL 94.1% |

## Change table

| Date | URL(s) | Post ID | Change type | Target query | Old title/meta | New title/meta | Task | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-07-01 | 56 items (26 pages + 30 posts) | — | content + metadata | — | — | — | T110–T124 | Backfilled summary row. |
| 2026-07-13 | 18 posts, \`digital-transport-ecmr-v4-*\` | — | new content | — | — | — | T67 | Newly created posts. |
| 2026-08-06 | \`/pl/a/\` | 9090 | metadata | \`cmr\` | \`Old \\| Brand\` | \`New title\` | T130 | Freeze exception. |
| 2026-08-07 | \`/pl/b/\` | 7259 | content | — | — | — | T131 | In-body link to \`/pl/c/\` only. |

## Notes

More prose.
`;

function project() {
  const directory = tempDir();
  run('init.mjs', ['--project', directory, '--seed', 'seo', '--now', NOW]);
  fs.writeFileSync(path.join(directory, 'release-log.md'), RELEASE_LOG);
  return directory;
}

test('a lone Date column is ambiguous and must be declared', () => {
  const directory = project();
  const failed = run('record.mjs', ['import-changes', '--project', directory, '--file', path.join(directory, 'release-log.md'), '--table', 'Change table', '--now', NOW], {expectFail: true});
  assert.match(failed.stderr, /ambiguous: pass --date-means deployed .* or --date-means applied/);
});

test('import a markdown release log as applied-but-pending changes, idempotently', () => {
  const directory = project();
  const args = ['import-changes', '--project', directory, '--file', path.join(directory, 'release-log.md'), '--table', 'Change table', '--date-means', 'applied', '--default-type', 'seo_content_update', '--now', NOW];
  const imported = run('record.mjs', args);
  assert.equal(imported.rows, 4, 'only the change table, not the intro table');
  assert.deepEqual(imported.results.map((entry) => entry.deploy_status), ['pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(imported.results.map((entry) => entry.pages), [0, 0, 1, 1], 'summary rows and wildcards are unknown scope; pages come from the URL(s) column only, not from link targets in the notes');
  const again = run('record.mjs', args);
  assert.equal(again.registered, 0);
  assert.ok(again.results.every((entry) => entry.status === 'already_registered'));
  const probe = run('state.mjs', ['--project', directory, '--now', NOW]);
  assert.deepEqual(probe.changes.pending_deploy, ['CH-001', 'CH-002', 'CH-003', 'CH-004']);
  const text = fs.readFileSync(path.join(directory, '.analyzer', 'changes', fs.readdirSync(path.join(directory, '.analyzer', 'changes')).find((name) => name.startsWith('CH-003'))), 'utf8');
  assert.match(text, /^applied_at: 2026-08-06$/m);
  assert.match(text, /^timestamp: null$/m);
  assert.match(text, /PENDING — applied but not live/);
  assert.ok(validateState(directory).ok, validateState(directory).output);
});

test('pending changes are not confounders; deploying them makes them count from the live date', () => {
  const directory = project();
  run('record.mjs', ['source', '--project', directory, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--auth-method', 'mcp', '--stale-after-hours', '9999', '--now', NOW]);
  const rows = days('2026-08-01', 56).flatMap((date, index) => ['/pl/a', '/pl/z'].map((page) => `${date},https://www.example.test${page}/,${index < 28 ? 20 : 30},1000,0.02,6`));
  run('ingest.mjs', ['--project', directory, '--source', 'gsc', '--input', writeCsv(path.join(directory, 'pages.csv'), 'date,page,clicks,impressions,ctr,position', rows), '--now', NOW]);
  run('record.mjs', ['import-changes', '--project', directory, '--file', path.join(directory, 'release-log.md'), '--table', 'Change table', '--date-means', 'applied', '--default-type', 'seo_content_update', '--now', NOW]);
  const window = ['--metric', 'organic_clicks', '--page', '/pl/a', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--control', 'none', '--now', NOW];
  const pending = run('analyze.mjs', ['compare', '--project', directory, ...window]).analysis;
  assert.deepEqual(pending.changes.overlapping, [], 'a change that is not live cannot have caused anything');

  const deployed = run('record.mjs', ['deploy', '--project', directory, '--changes', 'CH-003,CH-004', '--deployed-at', '2026-08-29T10:00:00+03:00', '--deployment', 'local-to-live-sync', '--now', NOW]);
  assert.deepEqual(deployed.results.map((entry) => [entry.id, entry.current]), [['CH-003', 'CH-005'], ['CH-004', 'CH-006']]);
  const probe = run('state.mjs', ['--project', directory, '--now', NOW]);
  assert.deepEqual(probe.changes.pending_deploy, ['CH-001', 'CH-002']);
  const linked = run('analyze.mjs', ['compare', '--project', directory, ...window, '--change', 'CH-003']).analysis;
  assert.deepEqual(linked.changes.linked, ['CH-005'], 'the superseded id resolves to its deployed record');
  assert.equal(linked.linked_change_details[0].timestamp, '2026-08-29T10:00:00+03:00');
  assert.notEqual(linked.causal_confidence.level, 'none');
  const original = fs.readFileSync(path.join(directory, '.analyzer', 'changes', fs.readdirSync(path.join(directory, '.analyzer', 'changes')).find((name) => name.startsWith('CH-003'))), 'utf8');
  assert.match(original, /^deploy_status: pending$/m, 'the pending record stays as history');
  assert.ok(validateState(directory).ok, validateState(directory).output);
});

test('a CSV change log with separate applied and deployed columns', () => {
  const directory = project();
  const file = writeCsv(path.join(directory, 'deploys.csv'), 'applied_at,deployed_at,urls,type,task,notes', ['2026-08-06,2026-08-29,/pl/a/ /pl/b/,metadata,T130,sync', '2026-09-02,,/pt/x/,cta link,T146,still local']);
  const imported = run('record.mjs', ['import-changes', '--project', directory, '--file', file, '--now', NOW]);
  assert.deepEqual(imported.results.map((entry) => entry.deploy_status), ['deployed', 'pending']);
  const probe = run('state.mjs', ['--project', directory, '--now', NOW]);
  assert.deepEqual(probe.changes.pending_deploy, ['CH-002']);
});

test('Hyper7 tasks with an optional deployed_at import as confirmed changes', () => {
  const directory = project();
  fs.mkdirSync(path.join(directory, '.hyper', 'tasks', 'T9-fix-canonicals'), {recursive: true});
  fs.writeFileSync(path.join(directory, '.hyper', 'tasks', 'T9-fix-canonicals', 'task.md'), '---\nid: T9\ntitle: Fix canonical tags\nphase: done\nscope: quick\ncreated: 2026-09-01T08:00:00\ndeployed_at: 2026-09-03T15:00:00Z\n---\n\n# Fix canonical tags\n');
  const imported = run('discover.mjs', ['--project', directory, '--import-changes', '--include', 'hyper7', '--now', NOW]);
  assert.deepEqual(imported.imported.map((entry) => [entry.timestamp, entry.confirmed]), [['2026-09-03T15:00:00Z', true]]);
});

test('--since imports only new release-log rows', () => {
  const directory = project();
  const imported = run('record.mjs', ['import-changes', '--project', directory, '--file', path.join(directory, 'release-log.md'), '--table', 'Change table', '--date-means', 'applied', '--since', '2026-08-06', '--now', NOW]);
  assert.equal(imported.rows, 2, 'the two July rows are older than --since');
});
