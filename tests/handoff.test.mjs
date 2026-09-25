// Hand-offs to Marketer7: analyzer-opportunity/v1 exports and consumption
// tracking, including a round trip through Marketer7's own helper.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {MARKETER_REPO, T, copyFixture, evaluateEx014, neighborHashes, readFrontmatter, run, setupEcosystem, validateState} from './helpers.mjs';

const NOW = '2026-09-25T12:00:00Z';

function withOpportunities() {
  const project = setupEcosystem(copyFixture());
  const input = (name) => path.join(project, 'inputs', name);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-daily-site-2026-08-01_2026-09-25.csv'), '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-query-page-before-2026-08-01_2026-08-28.json'), '--dimensions', 'query,page', '--start', '2026-08-01', '--end', '2026-08-28', '--now', NOW]);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', input('gsc-query-page-after-2026-08-29_2026-09-25.json'), '--dimensions', 'query,page', '--start', '2026-08-29', '--end', '2026-09-25', '--now', NOW]);
  run('seo.mjs', ['audit', '--project', project, '--record', '--now', NOW]);
  return project;
}

test('opportunities export as analyzer-opportunity/v1 and are marked handed off', () => {
  const project = withOpportunities();
  const neighbors = neighborHashes(project);
  const result = run('exports.mjs', ['opportunities', '--project', project, '--top', '2', '--now', NOW]);
  assert.equal(result.count, 2);
  const exported = readFrontmatter(path.join(project, result.results[0].export));
  assert.equal(exported.contract, 'analyzer-opportunity/v1');
  assert.equal(exported.provider, 'analyzer7');
  assert.match(exported.reference, /^analyzer7:SEO-OPP-\d{3}$/);
  const body = fs.readFileSync(path.join(project, result.results[0].export), 'utf8');
  assert.match(body, /\| B-<next> \| .* \| analyzer7:SEO-OPP-\d{3} \(/);
  const probe = run('state.mjs', ['--project', project, '--now', NOW]);
  assert.ok(probe.seo.opportunities_awaiting_review >= 0);
  const record = fs.readFileSync(path.join(project, '.analyzer', 'seo', 'opportunities', fs.readdirSync(path.join(project, '.analyzer', 'seo', 'opportunities')).find((name) => name.startsWith(result.results[0].id))), 'utf8');
  assert.match(record, /^status: handed_off$/m);
  assert.deepEqual(neighborHashes(project), neighbors, 'exporting never writes .marketer/');
  assert.ok(validateState(project).ok, validateState(project).output);
});

test('exports list tracks what Marketer7 consumed; Marketer7\'s helper agrees', async () => {
  const project = withOpportunities();
  evaluateEx014(project);
  const exported = run('exports.mjs', ['opportunities', '--project', project, '--top', '1', '--now', NOW]).results[0];
  const pending = run('exports.mjs', ['list', '--project', project, '--now', NOW]);
  assert.equal(pending.pending, 2, 'one evidence reference and one opportunity');

  // Marketer7 consumes both, the way its skills do.
  const evidenceExport = pending.exports.find((entry) => entry.contract === 'external-evidence-reference/v1');
  fs.copyFileSync(path.join(project, evidenceExport.export), path.join(project, '.marketer', 'experiments', 'EX-014-seo-title-intent', 'contracts', 'external-evidence-reference.md'));
  fs.writeFileSync(path.join(project, '.marketer', 'backlog.md'), `---\nschema_version: 1\nupdated_at: ${NOW}\n---\n\n# Marketer7 backlog\n\n| ID | Idea | Why it may matter | Evidence | Status |\n| --- | --- | --- | --- | --- |\n| B-001 | idea | why | analyzer7:${exported.id} | open |\n`);
  const after = run('exports.mjs', ['list', '--project', project, '--now', NOW]);
  assert.equal(after.pending, 0);

  const helper = path.join(MARKETER_REPO, 'scripts', 'list-analyzer-exports.mjs');
  if (fs.existsSync(helper)) {
    const {listAnalyzerExports} = await import(helper);
    const view = listAnalyzerExports(project);
    assert.equal(view.pending, 0);
    assert.ok(view.items.every((item) => item.status === 'consumed'));
    const {validateMarketerState} = await import(path.join(MARKETER_REPO, 'scripts', 'validate-marketer-state.mjs'));
    assert.deepEqual(validateMarketerState(path.join(project, '.marketer')).errors, [], 'Marketer7 accepts the consumed reference');
  }
});

test('a manually evidenced opportunity can be recorded and exported', () => {
  const project = setupEcosystem(copyFixture());
  const made = run('record.mjs', ['opportunity', '--project', project, '--title', 'ecmr visibility loss (ES)', '--type', 'visibility_loss', '--query', 'ecmr', '--market', 'esp', '--evidence', 'Impressions 142.9/day → 5.1/day, position ~20 → 23 (GSC query×page×country).', '--now', NOW]);
  assert.equal(made.status, 'recorded');
  assert.equal(run('record.mjs', ['opportunity', '--project', project, '--title', 'again', '--type', 'visibility_loss', '--query', 'ecmr', '--market', 'esp', '--evidence', 'x', '--now', NOW]).status, 'already_recorded');
  const exported = run('exports.mjs', ['opportunities', '--project', project, '--ids', made.id, '--now', NOW]);
  assert.equal(readFrontmatter(path.join(project, exported.results[0].export)).type, 'visibility_loss');
  assert.ok(validateState(project).ok, validateState(project).output);
});
