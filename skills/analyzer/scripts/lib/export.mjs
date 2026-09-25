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

// Outgoing contract: `analyzer-opportunity/v1` — an SEO opportunity handed to
// Marketer7 as a backlog candidate. Marketer7 decides whether it becomes an
// experiment; Analyzer7 never writes `.marketer/`. Flat frontmatter only.
export const OPPORTUNITY_CONTRACT = 'analyzer-opportunity/v1';

export function writeOpportunityExport(project, opportunityId, {now}) {
  const root = stateRoot(project);
  const record = findRecord(root, 'opportunity', opportunityId);
  if (!record) throw new UsageError(`${opportunityId} not found`);
  const data = record.data;
  const artifact = relative(project, record.path);
  const gain = data.estimated_click_gain_28d ?? data.estimated_click_loss_28d ?? null;
  const reference = `analyzer7:${data.id}`;
  const idea = `${data.type.replace(/_/g, ' ')}: ${data.query ? `"${data.query}" on ` : ''}${data.page ?? 'site-wide'}`.replace(/\|/g, '/');
  const why = gain !== null ? `~${gain} clicks / 28 days estimated (${data.estimated_click_gain_28d !== undefined && data.estimated_click_gain_28d !== null ? 'CTR gap' : 'lost clicks'}); an estimate, not a forecast` : data.upside_if_top3_28d ? `hypothetical ~${data.upside_if_top3_28d} clicks / 28 days at about position 3` : data.contested_impressions ? `${data.contested_impressions} impressions contested between URLs` : 'see the canonical artifact';
  const frontmatter = {
    schema_version: 1,
    contract: OPPORTUNITY_CONTRACT,
    provider: 'analyzer7',
    opportunity_id: data.id,
    reference,
    type: data.type,
    query: data.query ?? 'none',
    page: data.page ?? 'none',
    estimated_clicks_28d: gain ?? 'unknown',
    suggested_owner: data.suggested_owner ?? 'marketer7',
    detected_at: data.detected_at,
    period_start: data.period_start ?? 'unknown',
    period_end: data.period_end ?? 'unknown',
    external_artifact: artifact,
    exported_at: now,
  };
  const body = [
    `# Analyzer7 opportunity — ${data.id}`,
    '',
    '## Evidence',
    '',
    `${data.title}. Canonical record: \`${artifact}\` (evidence tables, rule, provenance).`,
    '',
    '## Suggested Marketer7 backlog row',
    '',
    '| ID | Idea | Why it may matter | Evidence | Status |',
    '| --- | --- | --- | --- | --- |',
    `| B-<next> | ${idea} | ${why.replace(/\|/g, '/')} | ${reference} (${artifact}) | open |`,
    '',
    '## Boundary',
    '',
    'Analyzer7 flags and measures. Marketer7 decides whether to test this (and defines any experiment); Signal7 executes content or meta changes and Hyper7 technical ones; Analyzer7 measures the result. This file is a hand-off, not an instruction to change the site.',
    '',
  ].join('\n');
  const target = uniquePath(path.join(root, 'exports', 'opportunities', `${data.id}-analyzer-opportunity.md`));
  writeNew(target, renderDocument(frontmatter, body));
  return {path: target, relative: relative(project, target), contract: OPPORTUNITY_CONTRACT};
}
