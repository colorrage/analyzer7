// Legacy compatibility with Hyper7-family projects, security/redaction,
// append-only integrity, and the package/installer contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {MARKETER_REPO, REPO, SIGNAL_REPO, T, copyFixture, evaluateEx014, neighborHashes, rewriteSnapshotText, run, setupEcosystem, tempDir, validateState, writeCsv} from './helpers.mjs';
import {findSecrets, redact} from '../skills/analyzer/scripts/lib/redact.mjs';
import {readSignal} from '../skills/analyzer/scripts/lib/neighbors.mjs';

test('legacy: no command writes a neighbor harness root, and Marketer7 state stays valid', async () => {
  const project = copyFixture();
  const neighbors = neighborHashes(project);
  setupEcosystem(project);
  run('discover.mjs', ['--project', project, '--import-changes', '--include', 'signal7,hyper7', '--now', T.planning]);
  evaluateEx014(project);
  run('analyze.mjs', ['audit', '--project', project, '--scope', 'growth', '--report', '--record-baselines', '--now', T.evaluate]);
  run('analyze.mjs', ['maintain', '--project', project, '--report', '--now', T.evaluate]);
  run('analyze.mjs', ['monitor', '--project', project, '--record', '--now', T.evaluate]);
  run('seo.mjs', ['audit', '--project', project, '--record', '--report', '--now', T.evaluate]);
  run('state.mjs', ['--project', project, '--now', T.evaluate]);
  assert.deepEqual(neighborHashes(project), neighbors, '.marketer, .signal, .hyper, and .scout are byte-for-byte unchanged');
  assert.ok(validateState(project).ok, validateState(project).output);
  if (fs.existsSync(path.join(MARKETER_REPO, 'scripts', 'validate-marketer-state.mjs'))) {
    const {validateMarketerState} = await import(path.join(MARKETER_REPO, 'scripts', 'validate-marketer-state.mjs'));
    assert.deepEqual(validateMarketerState(path.join(project, '.marketer')).errors, []);
  }
});

test('legacy: a Hyper7-only project works, and Hyper imports are opt-in and unconfirmed', () => {
  const project = tempDir();
  fs.mkdirSync(path.join(project, '.hyper'), {recursive: true});
  fs.cpSync(path.join(REPO, 'fixtures', 'analyzer', 'ecosystem', '.hyper'), path.join(project, '.hyper'), {recursive: true});
  const neighbors = neighborHashes(project);
  run('init.mjs', ['--project', project, '--now', T.planning]);
  const probe = run('state.mjs', ['--project', project, '--now', T.planning]);
  assert.deepEqual(probe.neighbors, {marketer7: false, signal7: false, hyper7: true, scout7: false});
  assert.deepEqual(probe.experiments, []);
  const defaultImport = run('discover.mjs', ['--project', project, '--import-changes', '--now', T.planning]);
  assert.deepEqual(defaultImport.imported, [], 'Hyper7 work is not imported unless requested');
  const hyperImport = run('discover.mjs', ['--project', project, '--import-changes', '--include', 'hyper7', '--now', T.planning]);
  assert.deepEqual(hyperImport.imported.map((entry) => [entry.origin_ref, entry.type, entry.confirmed]), [['hyper7:T7', 'technical_seo_fix', false]], 'only finished feature/quick tasks; research tasks and active loops are not changes');
  const change = fs.readFileSync(path.join(project, '.analyzer', 'changes', fs.readdirSync(path.join(project, '.analyzer', 'changes')).find((name) => name.startsWith('CH-001'))), 'utf8');
  assert.match(change, /^timestamp_basis: task_created$/m);
  assert.match(change, /Hyper7 records no deploy time/);
  const rerun = run('discover.mjs', ['--project', project, '--import-changes', '--include', 'hyper7', '--now', T.planning]);
  assert.equal(rerun.imported.length, 0, 'imports are idempotent');
  assert.equal(rerun.skipped[0].reason, 'already registered as CH-001');
  assert.deepEqual(neighborHashes(project), neighbors);
  assert.equal(run('state.mjs', ['--project', project, '--now', T.planning]).changes.unconfirmed[0], 'CH-001');
});

test('legacy: Signal7 tasks without origin metadata import; unknown contract versions are ignored with a warning', () => {
  const project = copyFixture();
  const resultPath = path.join(project, '.signal', 'tasks', 'S3-seo-title-rewrite', 'execution-result.md');
  fs.writeFileSync(resultPath, fs.readFileSync(resultPath, 'utf8').replace('signal7-execution-result/v1', 'signal7-execution-result/v2'));
  fs.writeFileSync(path.join(project, '.signal', 'tasks', 'S1-legacy-linkedin', 'A2-broken.md'), 'no frontmatter at all');
  const signal = readSignal(project);
  assert.ok(signal.warnings.some((warning) => /unsupported contract signal7-execution-result\/v2/.test(warning)));
  assert.ok(signal.warnings.some((warning) => /A2-broken\.md: missing opening frontmatter/.test(warning)));
  const legacy = signal.publications.find((entry) => entry.ref === 'signal7:S1/A1');
  assert.equal(legacy.experiment_id, null);
  assert.equal(legacy.publication_url, null);
  const s3 = signal.publications.find((entry) => entry.ref === 'signal7:S3/A1');
  assert.equal(s3.publication_url, null, 'a rejected execution result contributes nothing');
  assert.equal(s3.experiment_id, 'EX-014', 'the publish ledger still carries the optional metadata');
  run('init.mjs', ['--project', project, '--now', T.planning]);
  const imported = run('discover.mjs', ['--project', project, '--import-changes', '--now', T.planning]);
  assert.equal(imported.imported.length, 2);
  assert.ok(imported.warnings.length >= 2);
});

test('legacy: the real Signal7 Marketer7 fixture is readable without modification', (t) => {
  const fixture = path.join(SIGNAL_REPO, 'evals', 'signal-fixtures', 'marketer7-execution-brief');
  if (!fs.existsSync(fixture)) {
    t.skip('Signal7 checkout not present next to Analyzer7');
    return;
  }
  const signal = readSignal(fixture);
  const publication = signal.publications.find((entry) => entry.ref === 'signal7:S21/A1');
  assert.equal(publication.experiment_id, 'EX-001');
  assert.equal(publication.mission_id, 'M1');
  assert.equal(publication.published_at, '2026-08-03T00:10:00');
  assert.deepEqual(publication.tracking, {utm_campaign: 'EX-001', utm_source: 'email'});
  assert.equal(publication.content_hash, 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('security: redaction removes secrets and PII but keeps metric names and slugs', () => {
  const secrets = [
    'sk_live_51Habcdefghijklmnop',
    'Authorization: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxx',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'https://api.example.test/v1?access_token=abc123def456',
    '"client_secret": "GOCSPX-abcdefghijklmnop"',
    'contact jane.doe@customer-mail.ro about it',
    'AKIAIOSFODNN7EXAMPLE',
  ];
  for (const secret of secrets) {
    const {text, count} = redact(secret);
    assert.ok(count > 0, `should redact: ${secret}`);
    assert.ok(findSecrets(text).length === 0, `nothing survives: ${text}`);
  }
  for (const safe of ['token_count', 'sk-2026-05-17-audit-report', 'a Basic understanding of search', 'env_vars: [GSC_TOKEN]', 'password: null', 'noreply@example.com']) {
    assert.equal(redact(safe).count, 0, `should keep: ${safe}`);
  }
});

test('security: credentials never reach state, and leaks are caught by validation', () => {
  const project = setupEcosystem(copyFixture());
  const refused = run('record.mjs', ['source', '--project', project, '--id', 'stripe', '--type', 'revenue', '--adapter', 'timeseries', '--auth-method', 'env', '--auth-reference', 'sk_live_51Habcdefghijklmnop', '--now', T.planning], {expectFail: true});
  assert.match(refused.stderr, /refusing to store what looks like a secret/);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--fail', 'request failed: Authorization: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxx', '--now', T.ingest]);
  const sources = fs.readFileSync(path.join(project, '.analyzer', 'sources.json'), 'utf8');
  assert.doesNotMatch(sources, /ya29/);
  assert.match(sources, /Bearer \[REDACTED\]/);

  const csv = writeCsv(path.join(project, 'inputs', 'queries-with-email.csv'), 'query,page,clicks,impressions,ctr,position', ['jane.doe@customer-mail.ro login,/login,3,40,0.075,2.1', 'calculator impozit,/calculator-impozit-micro,10,300,0.033,7.0']);
  const ingested = run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', csv, '--start', '2026-09-01', '--end', '2026-09-25', '--now', T.ingest]);
  assert.ok(ingested.warnings.some((warning) => /redacted/.test(warning)));
  assert.ok(validateState(project).ok, `redacted rows keep a consistent hash:\n${validateState(project).output}`);

  fs.mkdirSync(path.join(project, '.analyzer', 'reports'), {recursive: true});
  fs.writeFileSync(path.join(project, '.analyzer', 'reports', 'leak.md'), '---\nschema_version: 1\n---\n\napi_key: AIzaSyA1234567890abcdefghijklmnopqrstuv\n');
  const leaked = validateState(project);
  assert.equal(leaked.ok, false);
  assert.match(leaked.output, /reports\/leak\.md: possible secret/);
});

test('append-only integrity: tampered observations and deleted evidence fail validation', () => {
  const project = setupEcosystem(copyFixture());
  evaluateEx014(project);
  assert.ok(validateState(project).ok);
  const observationDir = path.join(project, '.analyzer', 'observations', 'gsc');
  const observation = path.join(observationDir, fs.readdirSync(observationDir)[0]);
  const original = fs.readFileSync(observation);
  rewriteSnapshotText(observation, (text) => text.replace('"clicks":3,', '"clicks":30,'));
  assert.match(validateState(project).output, /observation snapshots are immutable/);
  fs.writeFileSync(observation, original);
  const evidenceDir = path.join(project, '.analyzer', 'evidence');
  fs.rmSync(path.join(evidenceDir, fs.readdirSync(evidenceDir).find((name) => name.startsWith('EV-001'))));
  assert.match(validateState(project).output, /records are append-only and must not be deleted/);
  assert.equal(run('state.mjs', ['--project', project, '--now', T.evaluate]).next_ids.evidence, 'EV-002', 'a deleted ID is never reissued');
});

test('package: static contract check passes', () => {
  const result = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'validate-analyzer-package.mjs')], {encoding: 'utf8'});
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^PASS — Analyzer7 package static contract check/);
});

test('installer: links every skill, is idempotent, never replaces foreign entries, and uninstalls only its own links', () => {
  const installer = path.join(REPO, '.claude', 'skills', 'install-analyzer', 'scripts', 'install.sh');
  const target = path.join(tempDir(), 'agent skills');
  fs.mkdirSync(target, {recursive: true});
  fs.writeFileSync(path.join(target, 'analyzer'), 'unrelated skill');
  const invoke = (action) => spawnSync('bash', [installer, action], {encoding: 'utf8', env: {...process.env, ANALYZER_INSTALL_TARGETS: target}});
  const first = invoke('install');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /skip\s+analyzer \(exists and is not a symlink\)/);
  assert.equal(fs.readlinkSync(path.join(target, 'analyzer-seo')), path.join(REPO, 'skills', 'analyzer-seo'));
  assert.match(invoke('install').stdout, /ok\s+analyzer-seo \(already linked\)/);
  const uninstall = invoke('uninstall');
  assert.equal(uninstall.status, 0);
  assert.equal(fs.readFileSync(path.join(target, 'analyzer'), 'utf8'), 'unrelated skill');
  assert.equal(fs.existsSync(path.join(target, 'analyzer-seo')), false);
  const relative = spawnSync('bash', [installer, 'status'], {encoding: 'utf8', env: {...process.env, ANALYZER_INSTALL_TARGETS: 'relative/path'}});
  assert.notEqual(relative.status, 0);
});
