// Static contract check for the Analyzer7 skill package (repo-local; mirrors
// Marketer7's validate-marketer-package.mjs). Run from the repository root:
//   node scripts/validate-analyzer-package.mjs

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
let checks = 0;

function expect(condition, message) {
  checks += 1;
  if (!condition) errors.push(message);
}

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath}: missing`);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function hasAll(text, terms, relativePath) {
  for (const term of terms) expect(text.includes(term), `${relativePath}: missing ${JSON.stringify(term)}`);
}

const skills = ['analyzer', 'analyzer-audit', 'analyzer-monitor', 'analyzer-maintain', 'analyzer-seo', 'analyzer-experiment', 'analyzer-evidence', 'analyzer-source', 'analyzer-change', 'analyzer-recipe'];
const discovered = fs.readdirSync(path.join(root, 'skills'), {withFileTypes: true}).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, 'skills', entry.name, 'SKILL.md'))).map((entry) => entry.name).sort();
expect(JSON.stringify(discovered) === JSON.stringify([...skills].sort()), `skills/: expected exactly ${skills.join(', ')}; found ${discovered.join(', ')}`);

for (const skill of skills) {
  const relativePath = `skills/${skill}/SKILL.md`;
  const content = read(relativePath);
  const frontmatter = content.match(/^---\n([\s\S]+?)\n---\n/);
  expect(Boolean(frontmatter), `${relativePath}: missing frontmatter`);
  if (!frontmatter) continue;
  const name = frontmatter[1].match(/^name: ([a-z0-9-]+)$/m)?.[1];
  const description = frontmatter[1].match(/^description: (.+)$/m)?.[1] ?? '';
  expect(name === skill, `${relativePath}: name must match the directory`);
  expect(description.length > 0 && description.length <= 1024, `${relativePath}: description must be 1–1024 characters`);
  expect(/Keywords:/.test(description), `${relativePath}: description needs a Keywords line`);
  expect(!/anthropic|claude/i.test(name ?? ''), `${relativePath}: name must not contain reserved words`);
  expect(content.split('\n').length < 500, `${relativePath}: keep SKILL.md under 500 lines`);
  expect(!/\/Users\/|~\/hyper|Work\/cmr/.test(content), `${relativePath}: shipped skills must not reference absolute or repo-local paths`);
  expect(!/cmr-management|Banu/i.test(content), `${relativePath}: shipped skills must not hardcode project-specific names`);
  for (const match of content.matchAll(/`((?:\.\.\/[a-z0-9-]+\/)?(?:reference|templates|recipes|scripts)\/[A-Za-z0-9._-]+)`/g)) {
    const target = path.join(root, 'skills', skill, match[1]);
    expect(fs.existsSync(target), `${relativePath}: referenced file ${match[1]} does not exist`);
  }
}

const references = ['bootstrap.md', 'data-model.md', 'evidence-model.md', 'sources-and-metrics.md', 'cross-harness.md', 'authority.md', 'reporting.md', 'memory.md'];
const router = read('skills/analyzer/SKILL.md');
for (const reference of references) {
  expect(read(`skills/analyzer/reference/${reference}`).trim().length > 0, `skills/analyzer/reference/${reference}: empty`);
  expect(router.includes(`reference/${reference}`), `skills/analyzer/SKILL.md: must point to reference/${reference}`);
}
hasAll(router, ['Read-only authority', 'Never fabricate data', 'Never redefine a metric silently', 'Never claim causation beyond the recorded causal confidence', 'Never make the growth decision', 'Never persist secrets', 'append-only', 'scripts/state.mjs', 'validate-state.mjs'], 'skills/analyzer/SKILL.md');
for (const skill of skills.filter((entry) => entry !== 'analyzer')) {
  expect(router.includes(`\`${skill}\``), `skills/analyzer/SKILL.md: routing table must name ${skill}`);
}

hasAll(read('skills/analyzer/reference/evidence-model.md'), ['Data quality', 'Evidence strength', 'Causal confidence', 'INSUFFICIENT DATA', 'never raise it', 'success_threshold_met', 'never writes `win`'], 'skills/analyzer/reference/evidence-model.md');
hasAll(read('skills/analyzer/reference/cross-harness.md'), ['external-evidence-reference/v1', 'signal7-execution-result/v1', 'origin_ref: signal7:S<N>/A<N>', 'unconfirmed', 'Scout7', 'Never:'], 'skills/analyzer/reference/cross-harness.md');
hasAll(read('skills/analyzer/reference/authority.md'), ['Modify production', 'Publish', 'never', 'redaction'], 'skills/analyzer/reference/authority.md');

for (const template of ['project.md', 'context.md', 'memory.md']) {
  expect(/^---\n[\s\S]+?\n---\n/.test(read(`skills/analyzer/templates/${template}`)), `skills/analyzer/templates/${template}: missing YAML frontmatter`);
}
for (const template of ['sources.json', 'metrics.json', 'monitors.json', 'seo-config.json', 'metric-library.json']) {
  try {
    const parsed = JSON.parse(read(`skills/analyzer/templates/${template}`));
    expect(parsed.schema_version === 1, `skills/analyzer/templates/${template}: schema_version must be 1`);
  } catch (error) {
    expect(false, `skills/analyzer/templates/${template}: invalid JSON (${error.message})`);
  }
}
expect(read('skills/analyzer/templates/project.md').includes('authority: read_only'), 'skills/analyzer/templates/project.md: authority must default to read_only');

// Network access is confined to the optional connectors (connect.mjs +
// lib/connectors.mjs); everything else stays offline.
const NETWORK_ALLOWED = new Set(['connect.mjs', 'connectors.mjs']);
const scripts = ['init.mjs', 'state.mjs', 'ingest.mjs', 'record.mjs', 'discover.mjs', 'analyze.mjs', 'seo.mjs', 'experiment.mjs', 'validate-state.mjs', 'connect.mjs'];
for (const script of scripts) {
  const content = read(`skills/analyzer/scripts/${script}`);
  expect(!/from ['"](?!node:|\.\/|\.\.\/)/.test(content), `skills/analyzer/scripts/${script}: only node: built-ins and local modules are allowed`);
  if (!NETWORK_ALLOWED.has(script)) expect(!/\bfetch\(|https?\.request|node:https?['"]|node:net['"]/.test(content), `skills/analyzer/scripts/${script}: only the optional connectors may use the network`);
}
for (const entry of fs.readdirSync(path.join(root, 'skills', 'analyzer', 'scripts', 'lib'))) {
  const content = read(`skills/analyzer/scripts/lib/${entry}`);
  expect(!/from ['"](?!node:|\.\/|\.\.\/)/.test(content), `skills/analyzer/scripts/lib/${entry}: only node: built-ins and local modules are allowed`);
  if (!NETWORK_ALLOWED.has(entry)) expect(!/\bfetch\(|node:https?['"]|node:net['"]/.test(content), `skills/analyzer/scripts/lib/${entry}: only the optional connectors may use the network`);
}
const connectors = read('skills/analyzer/scripts/lib/connectors.mjs');
expect(/webmasters\.readonly/.test(connectors) && /analytics\.readonly/.test(connectors) && !/auth\/webmasters['"]|auth\/analytics['"]|auth\/analytics\.edit/.test(connectors), 'lib/connectors.mjs: Google scopes must be read-only');
// Neighbor roots are never written: proven behaviorally by tests/legacy.test.mjs
// (tree hashes of .marketer/.signal/.hyper/.scout before and after every command).

const recipes = ['seo-audit', 'seo-weekly', 'experiment-analysis', 'growth-baseline', 'revenue-audit', 'tracking-audit', 'monthly-business-review', 'ranking-monitor', 'content-decay', 'conversion-funnel'];
for (const recipe of recipes) {
  const content = read(`skills/analyzer-recipe/recipes/${recipe}.md`);
  expect(new RegExp(`^---\\nname: ${recipe}\\ndescription: .+\\n---\\n`).test(content), `skills/analyzer-recipe/recipes/${recipe}.md: frontmatter name must match the file`);
  expect(/^1\. /m.test(content), `skills/analyzer-recipe/recipes/${recipe}.md: needs numbered steps`);
}

const readme = read('README.md');
hasAll(readme, ['What Analyzer7 is', 'What Analyzer7 is not', 'AUDIT', 'MONITOR', 'MAINTAIN', 'external-evidence-reference/v1', 'node --test'], 'README.md');
for (const skill of skills) expect(readme.includes(`\`${skill}\``), `README.md: skills table must list ${skill}`);

if (errors.length > 0) {
  console.error(`FAIL — Analyzer7 package static contract check (${errors.length} issue${errors.length === 1 ? '' : 's'})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS — Analyzer7 package static contract check (${checks} checks)`);
}
