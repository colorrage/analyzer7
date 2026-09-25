// Outgoing contract: `external-evidence-reference/v1`, the shape Marketer7
// already consumes (skills/marketer/templates/external-evidence-reference.md).
//
// Analyzer7 writes the reference only into `.analyzer/exports/`. Marketer7
// (or the operator) copies it into its experiment's `contracts/` folder; no
// Analyzer7 script writes `.marketer/`. Frontmatter stays flat `key: value`
// because Marketer7's parser rejects anything else. Extra fields are additive,
// which the contract rules require consumers to tolerate.

import path from 'node:path';
import {UsageError, findRecord, relative, renderDocument, stateRoot, uniquePath, writeNew} from './core.mjs';

export const EXTERNAL_REFERENCE_CONTRACT = 'external-evidence-reference/v1';

export function writeExternalReference(project, evidenceId, {now, experimentId = null}) {
  const root = stateRoot(project);
  const record = findRecord(root, 'evidence', evidenceId);
  if (!record) throw new UsageError(`${evidenceId} not found`);
  const evidence = record.data;
  const experiment = experimentId ?? evidence.experiment_id;
  if (experiment && !/^EX-\d{3,}$/.test(experiment)) throw new UsageError(`experiment id must be EX-NNN, got ${experiment}`);
  if (!experiment) throw new UsageError(`${evidenceId} is not linked to an experiment; pass --experiment to reference it from one`);
  const artifact = relative(project, record.path);
  const data = {
    schema_version: 1,
    contract: EXTERNAL_REFERENCE_CONTRACT,
    experiment_id: experiment,
    provider: 'analyzer7',
    external_evidence_id: evidence.id,
    external_artifact: artifact,
    observed_at: evidence.period_after_end ? `${evidence.period_after_end}T23:59:59Z` : 'unknown',
    referenced_at: now,
    metric: evidence.metric,
    primary_value: evidence.after_value ?? 'unknown',
    unit: evidence.unit ?? 'unknown',
    data_quality: evidence.data_quality,
    evidence_strength: evidence.evidence_strength,
    causal_confidence: evidence.causal_confidence,
    evidence_grade: evidence.evidence_grade ?? 'unknown',
    threshold_result: evidence.threshold_result ?? 'not_evaluated',
    measured_fingerprint: evidence.experiment_fingerprint ?? 'unknown',
    criteria_basis: evidence.criteria_basis ?? 'unknown',
  };
  const body = [
    `# External evidence reference — ${experiment}`,
    '',
    '## Provenance',
    '',
    '- Provider: analyzer7',
    `- Canonical artifact: ${artifact}`,
    `- External evidence ID: ${evidence.id}`,
    `- Sources: ${(evidence.source_ids ?? []).join(', ') || 'unknown'}; observation snapshots: ${(evidence.artifacts ?? []).join(', ') || 'none'}`,
    '- Access/read constraints: read-only; the canonical record stays in `.analyzer/`.',
    '',
    '## Referenced claim',
    '',
    `${evidence.metric} measured ${evidence.before_value ?? 'unknown'} (${evidence.period_before_start} → ${evidence.period_before_end}) and ${evidence.after_value ?? 'unknown'} (${evidence.period_after_start} → ${evidence.period_after_end}) from ${(evidence.source_ids ?? []).join(', ')}.`,
    '',
    `- Data quality: ${evidence.data_quality}; evidence strength: ${evidence.evidence_strength}; causal confidence: ${evidence.causal_confidence}.`,
    `- Marketer7 evidence grade for this metric: ${evidence.evidence_grade ?? 'unknown'}.`,
    `- Threshold comparison: ${evidence.threshold_result ?? 'not evaluated'} (criteria basis: ${evidence.criteria_basis ?? 'unknown'}; measured definition fingerprint ${evidence.experiment_fingerprint ?? 'unknown'}).`,
    `- Confounders recorded: ${evidence.confounder_count ?? 0} (see the canonical artifact).`,
    '',
    'This file does not copy the provider\'s measurement as locally observed Marketer7 evidence and does not establish causality. The experiment verdict and the next decision remain with Marketer7.',
    '',
    '## Import decision',
    '',
    'Verdict: needs_input',
    '',
    'Reason: Verify the contract version, provenance, relevance, and data-quality statement before citing the reference from `evidence.md`.',
    '',
  ].join('\n');
  const target = uniquePath(path.join(root, 'exports', experiment, `${evidence.id}-external-evidence-reference.md`));
  writeNew(target, renderDocument(data, body));
  return {path: target, relative: relative(project, target), contract: EXTERNAL_REFERENCE_CONTRACT};
}
