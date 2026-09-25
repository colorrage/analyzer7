#!/usr/bin/env node
// Hand-offs to Marketer7.
//
//   opportunities --ids SEO-OPP-001,... | --top N [--type ctr_opportunity,...]
//        Write analyzer-opportunity/v1 exports and mark the opportunities
//        handed_off (status history appended).
//   list  Every export with its consumption state, read from .marketer/:
//        an evidence reference is consumed once Marketer7 holds a contract
//        with the same external_evidence_id; an opportunity once
//        .marketer/backlog.md mentions analyzer7:SEO-OPP-NNN.
//
// Common: [--project <dir>] [--now <ISO>]. Analyzer7 never writes .marketer/.

import fs from 'node:fs';
import path from 'node:path';
import {UsageError, listDir, listRecords, nowIso, parseArgs, parseFrontmatter, printJson, readText, requireInitialized, resolveProject, runCli} from './lib/core.mjs';
import {writeOpportunityExport} from './lib/export.mjs';
import {updateStatus} from './lib/records.mjs';

function walk(directory) {
  return listDir(directory).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
}

function opportunities(argv) {
  const args = parseArgs(argv, {options: ['project', 'now', 'top'], lists: ['ids', 'type']});
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  const now = nowIso(args.now);
  const open = listRecords(root, 'opportunity').filter((record) => record.data.status === 'awaiting_review');
  let chosen;
  if (args.ids) chosen = args.ids;
  else if (args.top) {
    const value = (record) => Number(record.data.estimated_click_gain_28d ?? record.data.estimated_click_loss_28d ?? record.data.upside_if_top3_28d ?? 0);
    chosen = open.filter((record) => !args.type || args.type.includes(record.data.type)).sort((a, b) => value(b) - value(a)).slice(0, Number(args.top)).map((record) => record.data.id);
  } else throw new UsageError('pass --ids SEO-OPP-NNN,... or --top N');
  const results = chosen.map((id) => {
    const exported = writeOpportunityExport(project, id, {now});
    const status = updateStatus(root, id, 'handed_off', `exported as ${exported.relative} (analyzer-opportunity/v1)`, now);
    return {id, export: exported.relative, status: status.status};
  });
  printJson({status: 'exported', count: results.length, results});
}

function list(argv) {
  const args = parseArgs(argv, {options: ['project', 'now']});
  const project = resolveProject(args.project);
  const root = requireInitialized(project);
  const marketer = path.join(project, '.marketer');
  const marketerFiles = fs.existsSync(marketer) ? walk(marketer).filter((file) => file.endsWith('.md')) : [];
  const consumedEvidence = new Set();
  for (const file of marketerFiles.filter((name) => name.includes(`${path.sep}contracts${path.sep}`))) {
    const document = parseFrontmatter(readText(file));
    if (document.data?.contract === 'external-evidence-reference/v1' && document.data.provider === 'analyzer7') consumedEvidence.add(`${document.data.experiment_id}|${document.data.external_evidence_id}`);
  }
  const backlog = fs.existsSync(path.join(marketer, 'backlog.md')) ? readText(path.join(marketer, 'backlog.md')) : '';
  const exports = walk(path.join(root, 'exports')).filter((file) => file.endsWith('.md')).map((file) => {
    const document = parseFrontmatter(readText(file));
    const data = document.data ?? {};
    const relativePath = path.relative(project, file).split(path.sep).join('/');
    if (data.contract === 'external-evidence-reference/v1') return {export: relativePath, contract: data.contract, experiment_id: data.experiment_id, evidence_id: data.external_evidence_id, consumed: consumedEvidence.has(`${data.experiment_id}|${data.external_evidence_id}`)};
    if (data.contract === 'analyzer-opportunity/v1') return {export: relativePath, contract: data.contract, opportunity_id: data.opportunity_id, consumed: backlog.includes(`analyzer7:${data.opportunity_id}`)};
    return {export: relativePath, contract: data.contract ?? 'unknown', consumed: null};
  });
  printJson({marketer_present: fs.existsSync(marketer), pending: exports.filter((entry) => entry.consumed === false).length, exports});
}

function main(argv) {
  const [command, ...rest] = argv;
  const commands = {opportunities, list};
  if (!commands[command]) throw new UsageError('exports.mjs <opportunities|list> [options]');
  commands[command](rest);
  return 0;
}

runCli(main);
