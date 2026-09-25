# Analyzer7 workflows

Transcripts are condensed and illustrative. Numbers come from the deterministic ecosystem fixture (`fixtures/analyzer/ecosystem`); record IDs depend on the order of runs.

These are agent-chat sessions. The agent runs the scripts; the user supplies decisions, exports, and corrections. The commands below are what the skills run, shown so the mechanics are inspectable. `S` stands for the installed `skills/analyzer/scripts` directory.

## 1. First run in a project

```text
You: /analyzer
Analyzer7: ANALYZER7 RESUME — Not initialized in this project. Neighbors: marketer7, signal7, hyper7, scout7.
           Initialize? This writes only .analyzer/.
You: yes, and seed the SEO metrics. We're in Europe/Bucharest.
```

```sh
node $S/init.mjs --seed seo --timezone Europe/Bucharest
```

Analyzer7 records the project name, where it came from (the README title), and what it found next door (`EX-014 measurement_pending`, 2 Signal7 publications) in `context.md`. No source is registered yet:

```text
Analyzer7: Which data sources can I read? I see nothing registered.
You: Search Console through the GSC MCP server (property sc-domain:example.test), and our Postgres for signups.
```

```sh
node $S/record.mjs source --id gsc --type search --adapter gsc --property sc-domain:example.test \
  --auth-method mcp --auth-reference "GSC MCP server" --timezone America/Los_Angeles \
  --expected-lag-hours 72 --stale-after-hours 96
node $S/record.mjs source --id db --type product --adapter timeseries --auth-method env --env-vars DATABASE_URL
node $S/discover.mjs --import-changes        # CH-001 (legacy LinkedIn post), CH-002 (EX-014 title rewrite)
```

## 2. The experiment loop (Marketer7 → Signal7 → Analyzer7 → Marketer7)

Marketer7 has locked `EX-014` (primary metric `organic_ctr`, success `>= 1.8`, failure `<= 1.2`, window 2026-08-29 → 09-25). Signal7 published the title rewrite on 2026-08-28.

```text
You: /analyzer measure EX-014
Analyzer7: EX-014 maps to organic_ctr v1. Linked change: CH-002 (signal7:S3/A1, /calculator-impozit-micro).
           I need daily page-level GSC data for 2026-08-01 → 2026-08-28 to record the baseline.
```

The agent pulls `enhanced_search_analytics` with dimensions `date,page` through the GSC MCP server, saves the response, and runs:

```sh
node $S/ingest.mjs --source gsc --input gsc-date-page.json --dimensions date,page
node $S/experiment.mjs plan --experiment EX-014 --record-baseline     # BL-001 = 1.0952%, quality high
```

A mid-window check refuses to produce evidence:

```text
Analyzer7: EX-014's window closes 2026-09-25; no evidence is produced before then.
```

After the window closes and GSC covers it:

```sh
node $S/ingest.mjs --source gsc --input gsc-date-page-latest.json --dimensions date,page
node $S/experiment.mjs evaluate --experiment EX-014 --record
```

```text
Analyzer7: EV-001 — organic_ctr 1.0952% → 2.3963% for /calculator-impozit-micro.
           Threshold: success >= 1.8 → success_threshold_met.
           Data quality HIGH · evidence strength HIGH · causal confidence MEDIUM
           (before/after design; average position also moved 8.77 → 7.88, so part of the CTR gain may come from ranking).
           Export for Marketer7: .analyzer/exports/EX-014/EV-001-external-evidence-reference.md
           The verdict and the next step are Marketer7's.
```

Marketer7 copies the export into `.marketer/experiments/EX-014-*/contracts/`, cites it from its evidence, and evaluates against its locked thresholds.

If Hyper7 had shipped a calculator widget redesign on the same page on 2026-09-08, the same evaluation would read `causal confidence LOW — 1 major confounder: CH-003`. The threshold comparison would not change; only the attribution weakens.

## 3. Weekly SEO pass

```text
You: /analyzer-recipe run seo-weekly
```

The recipe refreshes GSC (`date` and `date,page`) and the rank-tracker export, then runs the monitors, `seo.mjs rankings --record`, and a 7-vs-7-day page comparison. It ends with at most five lines:

```text
- impozit micro 2026 dropped 8 → 21 (RO/mobile) and the ranking URL switched to /impozit-micro-2026 → AN-001 (possible cannibalization).
- impozit micro pfa is no longer ranking (was 30) → AN-002.
- LCP on /calculator-impozit-micro regressed 2300 → 3100 ms (good → needs improvement) → AN-003, owner Hyper7.
- Rankings snapshot is 3 days old (SLA 48h): refreshed before comparing.
- Next: hand 2 cannibalization candidates (SEO-OPP-001/002) to Marketer7.
```

## 4. Conflicting sources

```text
You: GA4 says 100 signups for the first half of September but the dashboard says 91. Which is right?
```

```sh
node $S/analyze.mjs discrepancy --metric signups --start 2026-09-01 --end 2026-09-14 --record
```

```text
Analyzer7: signups is defined with the DB as canonical (completed_registration rows). DB 91, GA4 100 (+9.89%, tolerance 5%).
           The value is 91. The discrepancy is recorded as AN-004; likely causes are definitional
           (GA4 counts the sign_up event, including unverified accounts and duplicate submits).
           Any analysis of signups this period is marked data quality LOW until this is reconciled.
```

## 5. When data is missing

```text
You: /analyzer evaluate EX-014
Analyzer7: gsc is unavailable (last fetch failed: HTTP 403 — user lacks permission). EV-002 is recorded as
           INSUFFICIENT DATA: before/after unknown, threshold result insufficient_data, causal confidence none.
           No value was estimated. Re-authorize the GSC property and I will re-evaluate (the new record will supersede EV-002).
```
