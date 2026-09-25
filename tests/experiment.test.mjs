// Experiment evaluation, the §46 success scenario, and confounded experiments.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {MARKETER_REPO, T, copyFixture, evaluateEx014, hashTree, neighborHashes, readFrontmatter, run, setupEcosystem, validateState} from './helpers.mjs';

const EXPORT_FIELDS = ['schema_version', 'contract', 'experiment_id', 'provider', 'external_evidence_id', 'external_artifact', 'observed_at', 'referenced_at'];

test('success scenario: Marketer7 EX-014 + Signal7 publication → baseline → EV with all required fields → Marketer7 can consume it', async () => {
  const project = setupEcosystem(copyFixture());
  const neighbors = neighborHashes(project);

  // Analyzer7 discovers the mission, experiment, and publication without re-entry.
  const discovered = run('discover.mjs', ['--project', project]);
  const experiment = discovered.neighbors.marketer7.experiments.find((entry) => entry.id === 'EX-014');
  assert.equal(experiment.mission_id, 'M1');
  assert.equal(experiment.definition_matches_review, true);
  const publication = discovered.neighbors.signal7.publications.find((entry) => entry.ref === 'signal7:S3/A1');
  assert.equal(publication.experiment_id, 'EX-014');
  assert.equal(publication.publication_url, 'https://www.example.test/calculator-impozit-micro/');

  const plan = run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-014', '--record-baseline', '--now', T.planning]);
  assert.deepEqual(plan.scope_pages, ['/calculator-impozit-micro'], 'scope comes from the linked Signal7 publication');
  assert.deepEqual(plan.before, {start: '2026-08-01', end: '2026-08-28'});
  assert.deepEqual(plan.window, {start: '2026-08-29', end: '2026-09-25'});

  const open = run('experiment.mjs', ['evaluate', '--project', project, '--experiment', 'EX-014', '--now', T.midWindow]);
  assert.equal(open.status, 'window_open', 'no evidence before the window closes');

  const result = evaluateEx014Continue(project);
  const analysis = result.analysis;
  // Exact values by construction of the fixture: 92/8400 and 208/8680.
  assert.equal(analysis.comparison.before.value, 1.0952);
  assert.equal(analysis.comparison.after.value, 2.3963);
  assert.equal(analysis.comparison.delta_abs, 1.3011);
  assert.equal(analysis.comparison.delta_pct, 118.79);
  assert.equal(analysis.comparison.before.sample, 8400);
  assert.equal(analysis.comparison.after.sample, 8680);
  assert.equal(result.threshold.result, 'success_threshold_met');
  assert.equal(result.decision_owner, 'marketer7');
  assert.equal(analysis.data_quality.level, 'high');
  assert.equal(analysis.evidence_strength.level, 'high');
  assert.equal(analysis.causal_confidence.level, 'medium', 'a before/after design caps causal confidence at medium');
  assert.ok(analysis.confounders.some((entry) => entry.code === 'position_shift'), 'the ranking improvement is surfaced as a confounder');
  assert.deepEqual(analysis.changes.linked, ['CH-002']);

  const evidencePath = path.join(project, result.evidence.path);
  const evidence = readFrontmatter(evidencePath);
  for (const [key, expected] of Object.entries({id: 'EV-001', metric: 'organic_ctr', source_ids: '[gsc]', before_value: '1.0952', after_value: '2.3963', data_quality: 'high', evidence_strength: 'high', causal_confidence: 'medium', threshold_result: 'success_threshold_met', mission_id: 'M1', experiment_id: 'EX-014', change_ids: '[CH-002]', asset_ids: '[signal7:S3/A1]', baseline_ids: '[BL-001]', evidence_grade: 'A'})) {
    assert.equal(evidence[key], expected, `EV-001 ${key}`);
  }
  assert.equal(evidence.experiment_fingerprint, experiment.fingerprint);
  const body = fs.readFileSync(evidencePath, 'utf8');
  for (const section of ['## Observation', '## Measurement', '## Experiment threshold check', '## Data quality: HIGH', '## Evidence strength: HIGH', '## Causal confidence: MEDIUM', '## Confounders', '## Possible explanations', '## Uncertainty', '## Interpretation', '## Provenance']) {
    assert.ok(body.includes(section), `EV-001 should contain ${section}`);
  }
  assert.match(body, /organic_ctr increased \(1\.095% → 2\.396%\) after CH-002\. The timing is consistent with the hypothesis/);
  assert.doesNotMatch(body, /\bwin\b|\bloss\b/i, 'Analyzer7 never writes a verdict');
  assert.match(body, /rows sha256 `[0-9a-f]{64}`/);

  // The export uses Marketer7's contract and passes Marketer7's own checks.
  const exportPath = path.join(project, result.export);
  const reference = readFrontmatter(exportPath);
  for (const field of EXPORT_FIELDS) assert.ok(reference[field], `export ${field}`);
  assert.equal(reference.contract, 'external-evidence-reference/v1');
  assert.equal(reference.external_evidence_id, 'EV-001');
  assert.ok(fs.existsSync(path.join(project, reference.external_artifact)));

  if (fs.existsSync(path.join(MARKETER_REPO, 'scripts', 'validate-marketer-state.mjs'))) {
    const {validateMarketerState} = await import(path.join(MARKETER_REPO, 'scripts', 'validate-marketer-state.mjs'));
    const marketerCopy = path.join(project, 'marketer-consumer-copy');
    fs.cpSync(path.join(project, '.marketer'), marketerCopy, {recursive: true});
    fs.copyFileSync(exportPath, path.join(marketerCopy, 'experiments', 'EX-014-seo-title-intent', 'contracts', 'external-evidence-reference.md'));
    const marketer = validateMarketerState(marketerCopy);
    assert.deepEqual(marketer.errors, [], 'Marketer7 accepts the Analyzer7 reference');
  }

  // Analyzer7 never wrote a neighbor root, and its own state validates.
  assert.deepEqual(neighborHashes(project), neighbors);
  assert.ok(validateState(project).ok, validateState(project).output);
});

// Continuation used by the success scenario (the plan was already recorded).
function evaluateEx014Continue(project) {
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', path.join(project, 'inputs', 'gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', T.ingest]);
  return run('experiment.mjs', ['evaluate', '--project', project, '--experiment', 'EX-014', '--record', '--now', T.evaluate]);
}

test('experiment: re-evaluation supersedes instead of rewriting evidence', () => {
  const project = setupEcosystem(copyFixture());
  const first = evaluateEx014(project);
  const firstPath = path.join(project, first.evidence.path);
  const firstContent = fs.readFileSync(firstPath, 'utf8');
  const second = run('experiment.mjs', ['evaluate', '--project', project, '--experiment', 'EX-014', '--record', '--now', '2026-10-02T09:00:00Z']);
  assert.equal(second.evidence.id, 'EV-002');
  assert.equal(second.evidence.supersedes, 'EV-001');
  assert.equal(fs.readFileSync(firstPath, 'utf8'), firstContent, 'EV-001 is untouched');
  assert.equal(readFrontmatter(path.join(project, second.evidence.path)).supersedes, 'EV-001');
  const index = fs.readFileSync(path.join(project, '.analyzer', 'evidence', 'index.md'), 'utf8');
  assert.match(index, /\[EV-001\]/);
  assert.match(index, /\[EV-002\]/);
  assert.ok(validateState(project).ok);
});

test('experiment: a changed Marketer7 definition is surfaced, not silently accepted', () => {
  const project = setupEcosystem(copyFixture());
  run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-014', '--record-baseline', '--now', T.planning]);
  const experimentPath = path.join(project, '.marketer', 'experiments', 'EX-014-seo-title-intent', 'experiment.md');
  fs.writeFileSync(experimentPath, fs.readFileSync(experimentPath, 'utf8').replace('| Success threshold | >= 1.8 |', '| Success threshold | >= 2.5 |'));
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', path.join(project, 'inputs', 'gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', T.ingest]);
  const result = run('experiment.mjs', ['evaluate', '--project', project, '--experiment', 'EX-014', '--record', '--now', T.evaluate]);
  assert.ok(result.warnings.some((warning) => /definition changed since the plan/.test(warning)));
  assert.ok(result.warnings.some((warning) => /threshold result withheld \(criteria_changed\)/.test(warning)));
  assert.equal(result.threshold.result, 'criteria_changed', 'a retroactive threshold change never decides the result');
  assert.equal(result.threshold.observed, 2.3963, 'the measured value is still reported');
  const evidence = readFrontmatter(path.join(project, result.evidence.path));
  assert.equal(evidence.threshold_result, 'criteria_changed');
  assert.equal(evidence.criteria_basis, 'criteria_changed');
  assert.equal(readFrontmatter(path.join(project, result.export)).criteria_basis, 'criteria_changed');
  assert.ok(validateState(project).ok, validateState(project).output);
});

test('experiment: a threshold change governed by an approved Marketer7 override is honored', async () => {
  const {marketerFingerprint} = await import('../skills/analyzer/scripts/lib/neighbors.mjs');
  const project = setupEcosystem(copyFixture());
  run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-014', '--record-baseline', '--now', T.planning]);
  const directory = path.join(project, '.marketer', 'experiments', 'EX-014-seo-title-intent');
  const locked = readFrontmatter(path.join(directory, 'review.md')).criteria_fingerprint;
  const experimentPath = path.join(directory, 'experiment.md');
  fs.writeFileSync(experimentPath, fs.readFileSync(experimentPath, 'utf8').replace('| Success threshold | >= 1.8 |', '| Success threshold | >= 2.5 |'));
  const text = fs.readFileSync(experimentPath, 'utf8');
  const replacement = marketerFingerprint(text.slice(text.indexOf('\n---\n', 4) + 5));
  fs.mkdirSync(path.join(directory, 'criteria-overrides'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'criteria-overrides', 'CO-001.md'), `---\nschema_version: 1\nid: CO-001\nexperiment_id: EX-014\nstatus: approved\nprior_criteria_fingerprint: ${locked}\nreplacement_criteria_fingerprint: ${replacement}\ndecision_id: D-003\n---\n\n# Criteria override — CO-001\n`);
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', path.join(project, 'inputs', 'gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', T.ingest]);
  const result = run('experiment.mjs', ['evaluate', '--project', project, '--experiment', 'EX-014', '--now', T.evaluate]);
  assert.equal(result.threshold.criteria_basis, 'override CO-001');
  assert.equal(result.threshold.result, 'between_thresholds', 'the governed replacement threshold (>= 2.5) is applied');
});

test('experiment: Analyzer7 does not invent experiments or metric mappings', () => {
  const project = setupEcosystem(copyFixture());
  const missing = run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-099', '--now', T.planning], {expectFail: true});
  assert.match(missing.stderr, /does not create its own definitions/);
  const unmapped = run('experiment.mjs', ['plan', '--project', project, '--experiment', 'EX-014', '--metric', 'qualified_leads', '--now', T.planning], {expectFail: true});
  assert.match(unmapped.stderr, /Analyzer7 does not define metrics on the fly/);
});

test('confounded experiment: overlapping changes reduce causal confidence and are listed', () => {
  const clean = evaluateEx014(setupEcosystem(copyFixture()));
  assert.equal(clean.analysis.causal_confidence.level, 'medium');

  const project = setupEcosystem(copyFixture());
  run('record.mjs', ['change', '--project', project, '--title', 'Calculator widget redesign', '--origin', 'hyper7', '--type', 'landing_page_change', '--timestamp', '2026-09-08T10:00:00+03:00', '--basis', 'deploy_log', '--pages', '/calculator-impozit-micro', '--deployment', 'deploy-2026-09-08', '--now', T.planning]);
  const confounded = evaluateEx014(project, {extraArgs: ['--context', 'scout7:R1']});
  const analysis = confounded.analysis;
  assert.equal(analysis.causal_confidence.level, 'low');
  assert.ok(analysis.causal_confidence.reasons.some((reason) => /major confounder\(s\): CH-003/.test(reason)));
  assert.deepEqual(analysis.changes.overlapping.includes('CH-003'), true);
  assert.ok(analysis.confounders.some((entry) => entry.code === 'external_context' && entry.ref === 'scout7:R1'));
  assert.equal(confounded.threshold.result, 'success_threshold_met', 'the threshold comparison itself is unchanged; only attribution weakens');
  const body = fs.readFileSync(path.join(project, confounded.evidence.path), 'utf8');
  assert.match(body, /concurrent factors \(CH-003\) reduce causal confidence/);
  assert.match(body, /^confounding_change_ids: \[.*CH-003.*\]$/m);
  assert.match(body, /^context_refs: \[scout7:R1\]$/m);
});

test('confounded: a tracking change inside the window lowers data quality and causal confidence', () => {
  const project = setupEcosystem(copyFixture());
  run('record.mjs', ['change', '--project', project, '--title', 'GSC property migrated to domain property', '--origin', 'manual', '--type', 'tracking_change', '--timestamp', '2026-09-10T00:00:00Z', '--now', T.planning]);
  const result = evaluateEx014(project);
  assert.equal(result.analysis.data_quality.level, 'low');
  assert.ok(result.analysis.data_quality.issues.some((entry) => entry.code === 'tracking_change_in_window'));
  assert.equal(result.analysis.evidence_strength.level, 'low');
  assert.equal(result.analysis.causal_confidence.level, 'low');
});

test('observation without a linked change is never an attribution', () => {
  const project = setupEcosystem(copyFixture());
  run('ingest.mjs', ['--project', project, '--source', 'gsc', '--input', path.join(project, 'inputs', 'gsc-daily-pages-2026-08-01_2026-09-25.csv'), '--now', T.ingest]);
  const result = run('analyze.mjs', ['compare', '--project', project, '--metric', 'organic_clicks', '--page', '/calculator-impozit-micro', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--now', T.evaluate]);
  assert.equal(result.analysis.comparison.before.value, 92);
  assert.equal(result.analysis.comparison.after.value, 208);
  assert.equal(result.analysis.causal_confidence.level, 'none');
  assert.match(result.interpretation, /this is an observation, not an attribution/);

  const linked = run('analyze.mjs', ['compare', '--project', project, '--metric', 'organic_clicks', '--page', '/calculator-impozit-micro', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--change', 'CH-002', '--record', '--title', 'Organic clicks after the title rewrite', '--now', T.evaluate]);
  assert.equal(linked.analysis.causal_confidence.level, 'medium');
  assert.equal(linked.evidence.id, 'EV-001');
  const before = hashTree(path.join(project, '.analyzer', 'evidence'));
  const superseding = run('analyze.mjs', ['compare', '--project', project, '--metric', 'organic_clicks', '--page', '/calculator-impozit-micro', '--before-start', '2026-08-01', '--before-end', '2026-08-28', '--after-start', '2026-08-29', '--after-end', '2026-09-25', '--change', 'CH-002', '--record', '--title', 'Organic clicks after the title rewrite (corrected)', '--supersedes', 'EV-001', '--now', T.evaluate]);
  assert.equal(superseding.evidence.id, 'EV-002');
  assert.notEqual(hashTree(path.join(project, '.analyzer', 'evidence')), before);
  assert.ok(validateState(project).ok);
});
