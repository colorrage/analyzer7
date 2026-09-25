// Report writer for AUDIT / MONITOR / MAINTAIN runs. Reports separate what
// was observed from what it might mean; the deterministic sections are filled
// by scripts, and the `Interpretation` section is left for the analyst with
// the rule that it may not claim more than the recorded causal confidence.

import path from 'node:path';
import {isoDate, relative, renderDocument, slugify, stateRoot, uniquePath, writeNew} from './core.mjs';

export const INTERPRETATION_PLACEHOLDER = 'TBD by the analyst. Keep observation, interpretation, and uncertainty separate; do not claim causation beyond the causal confidence recorded in the cited evidence.';

export function table(headers, rows) {
  if (rows.length === 0) return ['_None._'];
  const escape = (value) => String(value ?? '').replace(/\|/g, '\\|');
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`)];
}

export function writeReport(project, {mode, scope, now, title, sections, sources = [], artifacts = [], extra = {}}) {
  const root = stateRoot(project);
  const date = isoDate(now);
  const target = uniquePath(path.join(root, 'reports', `${date}-${mode}-${slugify(scope, 32)}.md`));
  const body = [`# ${title}`, ''];
  for (const section of sections) {
    body.push(`## ${section.title}`, '');
    body.push(...(section.lines.length ? section.lines : ['_None._']), '');
  }
  if (!sections.some((section) => section.title === 'Interpretation')) body.push('## Interpretation', '', INTERPRETATION_PLACEHOLDER, '');
  const data = {schema_version: 1, mode, scope, generated_at: now, sources, artifacts, ...extra};
  writeNew(target, renderDocument(data, body.join('\n')));
  return {path: target, relative: relative(project, target)};
}
