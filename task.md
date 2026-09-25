# IMPLEMENT ANALYZER7 — EVIDENCE, ANALYTICS, OBSERVABILITY & SEO HARNESS

You are implementing a new harness called **Analyzer7**.

Analyzer7 belongs to an existing family of lightweight AI harnesses already implemented locally.

Before designing or writing anything, inspect the existing harnesses and reuse their real conventions, architecture, state model, command patterns, skills, rules, recipes, naming conventions and filesystem philosophy.

Do NOT invent an unrelated framework.

---

# 0. FIRST: INSPECT THE EXISTING ECOSYSTEM

Start by inspecting:

```text
~/hyper/
```

Find the existing projects/harnesses, especially:

```text
Hyper7
Marketer7
Signal7
Scout7
```

The exact directories/names may differ.

Discover them rather than assuming paths.

Inspect at minimum:

- README files
- AGENTS.md
- commands
- skills
- rules
- recipes
- state directories
- memory
- mission/loop structures
- examples
- tests
- cross-harness contracts
- installation/bootstrap mechanisms

Also inspect the SEO rankings skill:

```text
/Users/adrianfilip/Work/cmr/.agents/skills/seo-rankings
```

Read its documentation, scripts, contracts, expected inputs/outputs and existing implementation.

Analyzer7 should understand and reuse this capability where appropriate for SEO ranking analysis.

Do NOT blindly copy the skill.

Determine:

1. what is reusable;
2. what belongs specifically to the CMR project;
3. what should become an Analyzer7 adapter/capability;
4. what should remain external and simply be invoked;
5. whether a generic contract already exists.

Before implementation, produce a short internal architecture note documenting what patterns you found in the existing harnesses and what Analyzer7 will reuse.

Then implement.

---

# 1. GRAND PICTURE

The ecosystem should conceptually look like this:

```text
                     Business7
                 (future CEO layer)
                       │
          ┌────────────┼─────────────┐
          │            │             │
          ▼            ▼             ▼
       Hyper7       Marketer7      future Sales7
       BUILD         GROWTH
                       │
                ┌──────┴──────┐
                ▼             ▼
             Scout7        Signal7
            RESEARCH       EXECUTION
                           / CONTENT
                │             │
                └──────┬──────┘
                       │
                       ▼
                   REAL WORLD
                       │
                       ▼
                  Analyzer7
          EVIDENCE / OBSERVABILITY
                       │
                ┌──────┴──────┐
                ▼             ▼
            Marketer7      Business7
```

These boundaries matter.

## Hyper7

Answers:

> What needs to be built or changed technically?

Engineering/build harness.

Analyzer7 may identify a technical problem but should normally hand implementation to Hyper7.

Example:

```text
Analyzer7:
"These pages have broken canonical tags."

Hyper7:
implements the fix.
```

---

## Marketer7

Answers:

> What growth hypothesis should we test next?

Owns:

- growth strategy;
- hypotheses;
- experiments;
- prioritization;
- PMF learning;
- channel strategy;
- experiment decisions.

Analyzer7 MUST NOT become Marketer7.

Analyzer7 provides evidence to Marketer7.

---

## Scout7

Answers:

> What can we discover externally?

Research / discovery / intelligence.

Examples:

- competitors;
- markets;
- SERPs;
- communities;
- customer language;
- external research.

Analyzer7 may consume Scout7 findings but should not duplicate Scout7's research responsibilities.

---

## Signal7

Answers:

> What marketing/content asset should be created/published?

Owns:

- content;
- publishing;
- distribution execution;
- content maintenance;
- campaign assets.

Analyzer7 measures the effects of Signal7 activity.

---

# 2. ANALYZER7 CORE QUESTION

Analyzer7 answers:

> **What actually happened, and how strong is the evidence?**

This distinction is fundamental.

Analyzer7 is NOT primarily:

```text
strategy
content generation
software implementation
campaign execution
sales
generic research
```

Analyzer7 is:

```text
measurement
analytics
observation
diagnosis
evidence
attribution support
monitoring
anomaly detection
SEO measurement
experiment analysis
business/product telemetry interpretation
```

---

# 3. CORE PRINCIPLE

Analyzer7 should separate three concepts that are often incorrectly mixed:

```text
DATA QUALITY
EVIDENCE STRENGTH
CAUSAL CONFIDENCE
```

Example:

```text
Observation:

Signup conversion increased:
3.1% → 4.4%

Data quality:
HIGH

Evidence strength:
MEDIUM

Causal confidence:
LOW

Reason:
Two campaigns launched during the same period.
```

Never translate correlation automatically into causation.

Analyzer7 should explicitly surface:

```text
confounders
missing data
tracking changes
sample size issues
seasonality
simultaneous experiments
measurement uncertainty
```

---

# 4. ANALYZER7 SHOULD BE LIGHTWEIGHT

Follow the philosophy of the existing harness family.

If Hyper7 and the other harnesses are filesystem/markdown-first, Analyzer7 should follow that pattern.

Prefer:

```text
files
markdown
JSON/YAML where machine-readable state is justified
small scripts
skills
recipes
adapters
existing CLIs/APIs
```

Avoid creating unnecessarily:

```text
database
server
daemon
web application
queue system
custom analytics platform
large dependency tree
```

Analyzer7 is an AI harness, not a replacement for GA4, GSC, Stripe, PostHog, databases, etc.

It should orchestrate and interpret existing sources.

---

# 5. PERSISTENT ANALYZER STATE

Analyzer7 must survive across sessions.

Running something equivalent to:

```text
/analyzer
```

or the command convention already established by the harness family should NOT start from zero.

It should reconstruct current analytical context from persisted state.

Use the existing harness conventions wherever possible.

Conceptually Analyzer7 needs persistent information similar to:

```text
.analyzer/
    context/
    sources/
    metrics/
    baselines/
    changes/
    evidence/
    experiments/
    audits/
    monitors/
    seo/
    reports/
    memory/
    state.md
```

THIS IS CONCEPTUAL.

Do not force this exact tree if the existing harness family has a better convention.

Reuse existing patterns.

---

# 6. SOURCE REGISTRY

Analyzer7 needs a registry of available data sources.

Examples:

```text
Google Analytics 4
Google Search Console
Stripe
application database
CRM
email platform
social platforms
server logs
Cloudflare
Core Web Vitals / CrUX
PageSpeed
ranking providers
custom analytics
Signal7 publishing ledger
Marketer7 experiment registry
Hyper7 change history
```

A source definition should make it possible to know:

```text
source ID
source type
project/property
authentication mechanism
available metrics
data freshness
canonical metrics
limitations
last successful fetch
health
```

Never assume a source exists.

Discover/configure adapters.

---

# 7. METRIC DICTIONARY

Implement a canonical metric dictionary.

This is important because otherwise agents will silently redefine metrics.

Example:

```text
METRIC: activated_user

Definition:
User who submitted >= 1 qualifying real question.

Source:
application database

Canonical source:
DB

Fallback:
GA4 event `question_submitted`

Known limitations:
GA4 may be blocked by browser/privacy settings.
```

Another example:

```text
METRIC: signup_conversion

Formula:
qualified_visitors → completed_registration

Numerator:
completed registrations

Denominator:
qualified landing page visitors

Canonical sources:
DB + GA4

Window:
specified per analysis
```

Metrics should have stable definitions.

Analyzer7 should warn when two systems disagree.

---

# 8. CANONICAL SOURCE RULES

Different sources may report different numbers.

Example:

```text
Stripe subscriptions = 31
GA4 purchase events = 28
DB active subscriptions = 30
```

Analyzer7 must not silently choose whichever value looks convenient.

Allow canonical source definitions such as:

```text
Revenue → Stripe
Active subscription → application DB / Stripe depending definition
Organic impressions → GSC
Sessions → GA4
Product activation → application DB
Rankings → configured ranking source
```

Surface discrepancies.

---

# 9. EVIDENCE LEDGER

Evidence should be first-class.

Use stable IDs, following existing harness conventions if available.

Conceptually:

```text
EV-001
EV-002
EV-003
```

Evidence record example:

```text
EV-042

Observation:
Organic clicks increased after SEO title changes.

Period before:
2026-08-01 → 2026-08-28

Period after:
2026-08-29 → 2026-09-25

Metric:
organic_clicks

Before:
412

After:
537

Delta:
+30.3%

Data source:
Google Search Console

Data quality:
HIGH

Evidence strength:
MEDIUM

Causal confidence:
MEDIUM

Related change:
CH-018

Related experiment:
EX-014

Confounders:
- search demand increased ~8%
- two additional pages were indexed

Artifacts:
...
```

Evidence should be append-oriented.

Do not destroy historical evidence when updating state.

---

# 10. CHANGE REGISTRY

Analyzer7 needs to know **what changed and when**.

Otherwise analytics cannot be interpreted correctly.

Conceptually:

```text
CH-001
CH-002
...
```

Changes may originate from:

```text
Hyper7
Signal7
Marketer7
manual human action
deployment
pricing change
SEO change
tracking change
product release
campaign
```

Example:

```text
CH-018

timestamp:
2026-09-01T12:43:00+03:00

origin:
Signal7

type:
seo_content_update

pages:
- /calculator-impozit-micro

experiment:
EX-014

changes:
- title rewritten
- meta description rewritten
- FAQ section added
```

Analyzer7 should correlate changes with subsequent observations WITHOUT automatically claiming causation.

---

# 11. EXPERIMENT INTEGRATION

Marketer7 should be able to create something like:

```text
EX-014
```

with:

```text
hypothesis
primary metric
secondary metrics
success threshold
failure threshold
measurement window
audience
channel
```

Analyzer7 then evaluates the experiment.

Example:

```text
EX-014 ANALYSIS

Hypothesis:
Improved search-intent alignment increases CTR.

Primary metric:
GSC CTR

Baseline:
1.1%

Observed:
2.4%

Threshold:
>= 1.8%

Result:
threshold exceeded

Data quality:
HIGH

Evidence strength:
MEDIUM

Causal confidence:
MEDIUM

Confounders:
ranking improved 8.7 → 7.9 during same period.
```

Analyzer7 reports evidence.

Marketer7 decides:

```text
continue
stop
iterate
scale
new hypothesis
```

Analyzer7 should NOT make the growth decision.

---

# 12. THREE PRIMARY OPERATING MODES

Analyzer7 should support the conceptual modes:

```text
AUDIT
MONITOR
MAINTAIN
```

Adapt naming to existing harness conventions if needed.

## AUDIT

Deep baseline analysis.

Examples:

```text
/analyzer audit
/analyzer audit seo
/analyzer audit growth
/analyzer audit revenue
```

Possible output:

```text
current baseline
tracking health
major problems
data gaps
anomalies
opportunities
evidence confidence
```

---

## MONITOR

Observe metrics over time.

Examples:

```text
traffic
rankings
conversions
activation
retention
revenue
errors
CWV
indexation
```

Detect meaningful changes.

Avoid noisy alerts.

---

## MAINTAIN

Periodic analytical maintenance.

Examples:

```text
refresh baselines
check tracking integrity
review anomalies
check SEO health
update ranking snapshots
evaluate completed experiments
identify stale measurements
verify source health
```

MAINTAIN does not mean automatically modifying production.

---

# 13. SEO IS A FIRST-CLASS ANALYZER7 SUBSYSTEM

DO NOT create SEO7.

SEO belongs primarily inside Analyzer7 for measurement and diagnosis.

Conceptually:

```text
Analyzer7
└── SEO
    ├── Search Console
    ├── rankings
    ├── queries
    ├── landing pages
    ├── CTR
    ├── impressions
    ├── clicks
    ├── indexation
    ├── crawl health
    ├── Core Web Vitals
    ├── technical SEO diagnostics
    ├── content performance
    ├── keyword/page mapping
    ├── cannibalization
    ├── opportunity detection
    └── change impact analysis
```

---

# 14. SEO RANKINGS SKILL

Inspect:

```text
/Users/adrianfilip/Work/cmr/.agents/skills/seo-rankings
```

Determine how rankings are currently fetched, stored and interpreted.

Reuse its proven mechanisms where appropriate.

Analyzer7 should support concepts such as:

```text
keyword
location
device
search engine
current position
previous position
delta
landing page
SERP features
measurement timestamp
```

Do not hardcode CMR-specific assumptions into Analyzer7.

If the existing skill is project-specific, build a generic Analyzer7 interface around the useful behavior.

For example conceptually:

```text
ranking provider
       ↓
ranking adapter
       ↓
normalized ranking observation
       ↓
Analyzer7 SEO evidence
```

---

# 15. SEO ANALYSIS CAPABILITIES

Analyzer7 should eventually be capable of identifying cases such as:

### CTR opportunity

```text
query:
calculator impozit micro 2026

impressions:
8,400

position:
8.7

CTR:
1.1%

Observation:
high impressions relative to CTR
```

Analyzer7 may flag:

```text
SEO-OPP-###
```

but should NOT automatically rewrite the title.

The flow is:

```text
Analyzer7
    ↓ evidence/opportunity

Marketer7
    ↓ experiment decision

Signal7
    ↓ content/meta changes

or

Hyper7
    ↓ technical changes

Analyzer7
    ↓ measurement
```

---

# 16. CANNIBALIZATION

Detect cases where multiple URLs compete for the same query/topic.

Example:

```text
query:
impozit micro 2026

URL A:
position 8

URL B:
position 11

URL C:
position 17
```

Flag as possible cannibalization.

Do not automatically conclude that consolidation is correct.

Provide evidence.

---

# 17. INDEXATION

Support observations around:

```text
indexed
not indexed
excluded
discovered
crawled
canonical mismatch
robots issues
sitemap issues
```

When the relevant source/API cannot prove something, explicitly say so.

---

# 18. TECHNICAL SEO

Analyzer7 should be capable of detecting or recording:

```text
canonical problems
redirect chains
404/5xx
robots
sitemap issues
structured data issues
duplicate titles
missing titles
duplicate metadata
internal linking problems
orphan pages
CWV regressions
slow pages
mobile problems
```

But ownership is:

```text
Analyzer7 → diagnose
Hyper7 → fix
Analyzer7 → verify
```

---

# 19. CONTENT SEO

Analyzer7 can identify:

```text
declining pages
rising pages
queries with high impressions / low CTR
pages ranking 4–15
content decay
query/page mismatch
keyword opportunities
cannibalization
lost rankings
new rankings
```

But:

```text
Analyzer7 DOES NOT become content writer.

Signal7 owns content execution.
```

---

# 20. SEO CHANGE IMPACT

This is an important capability.

Analyzer7 should be able to connect:

```text
Signal7 publish event
or
Hyper7 deployment

        ↓

change registry

        ↓

GSC / ranking / GA4 observations

        ↓

evidence
```

Example:

```text
CH-018

Title changed:
01 Sep

GSC:
CTR 1.1 → 2.4%

Ranking:
8.7 → 7.9

Organic clicks:
+30%

Analyzer7:

Evidence strength: MEDIUM
Causal confidence: MEDIUM
```

---

# 21. BASELINES

Before measuring changes, establish baseline.

Baseline records should contain:

```text
metric
value
period
source
segment
confidence/data quality
timestamp
```

Example:

```text
BL-014

metric:
7_day_activation

period:
2026-08

value:
12.4%

source:
DB

sample:
137 users

data quality:
HIGH
```

---

# 22. ANOMALY DETECTION

Analyzer7 should detect meaningful deviations.

Examples:

```text
signup conversion -38%
organic clicks -27%
Stripe revenue mismatch
GSC impressions suddenly zero
GA4 events disappeared
ranking loss > 10 positions
CWV regression
```

Do NOT create arbitrary alert spam.

Use:

```text
absolute threshold
relative threshold
minimum sample
comparison period
seasonality/context where available
```

---

# 23. DATA QUALITY

Implement explicit data-quality checks.

Examples:

```text
missing dates
duplicate rows
tracking gaps
sudden zero values
timezone mismatch
property mismatch
sample too small
incomplete period
API errors
stale cache
schema changes
```

Analyzer7 must be comfortable saying:

```text
INSUFFICIENT DATA
```

instead of inventing a conclusion.

---

# 24. CROSS-HARNESS CONTRACT

Inspect whether Hyper7 / Marketer7 / Signal7 / Scout7 already define event or artifact contracts.

Reuse them if possible.

Analyzer7 should understand identifiers such as:

```text
mission_id
experiment_id
change_id
evidence_id
asset_id
publication_id
deployment_id
```

Prefer traceability:

```text
Mission
  ↓
Experiment
  ↓
Asset/change
  ↓
Real-world event
  ↓
Observation
  ↓
Evidence
  ↓
Decision
```

Example:

```text
M1
↓
EX-014
↓
ASSET-033
↓
CH-018
↓
EV-042
↓
DEC-009
```

Do not invent incompatible ID systems if equivalent IDs already exist.

---

# 25. SIGNAL7 INTEGRATION

Inspect Signal7.

If Signal7 already maintains:

```text
published URL
publish timestamp
content hash
mission
experiment
channel
tracking parameters
```

Analyzer7 should consume those records rather than requiring humans to duplicate them.

Desired flow:

```text
Signal7 publishes
      ↓
publication/change evidence
      ↓
Analyzer7 observes performance
```

---

# 26. HYPER7 INTEGRATION

Inspect Hyper7.

Analyzer7 should be able to understand important deployments/technical changes where available.

Example:

```text
deployment
schema change
tracking implementation
performance fix
SEO fix
landing page modification
```

Analyzer7 does NOT manage Hyper7 loops.

It consumes relevant change information.

---

# 27. MARKETER7 INTEGRATION

Inspect Marketer7's actual mission/experiment structure.

Analyzer7 should consume Marketer7 experiment definitions.

Avoid duplicate experiment definitions.

Ideally:

```text
Marketer7:
EX-014 definition

Analyzer7:
EX-014 measurement/evidence
```

Each system owns its part.

---

# 28. SCOUT7 INTEGRATION

Inspect Scout7.

Scout7 findings may provide external context such as:

```text
SERP changes
competitor activity
market change
new competitor
new search behavior
```

Analyzer7 may reference these as possible confounders/context.

Do not duplicate Scout7 research.

---

# 29. RESUME BEHAVIOR

Analyzer7 must know the analytical big picture after restart.

Example invocation:

```text
/analyzer
```

should conceptually produce something like:

```text
ANALYZER7 RESUME

Project:
Banu AI

Data health:
GA4      OK
GSC      OK
Stripe   OK
DB       OK
Rankings stale 3 days

Active experiments:
EX-014
EX-017

Recent evidence:
EV-041
EV-042

Anomalies:
1 unresolved

SEO:
3 opportunities awaiting review

Next analytical action:
Evaluate EX-014 after measurement window closes.
```

Do not force this exact output.

Follow existing harness UX.

---

# 30. CONTEXT COMPACTION

Do not load the entire history into every AI context.

Use:

```text
indexes
summaries
current state
latest evidence
active experiments
references
```

Then drill into historical/raw artifacts only when necessary.

Analyzer7 should scale to years of evidence without requiring all evidence in context.

---

# 31. PROVENANCE

Every meaningful analytical claim should be traceable where practical.

Example:

```text
claim:
Organic traffic increased 21%.

source:
GSC

property:
...

period:
...

retrieved:
...

artifact:
...
```

Never fabricate source data.

---

# 32. REPORTING

Reports should distinguish:

```text
OBSERVATION
INTERPRETATION
EVIDENCE
UNCERTAINTY
POSSIBLE EXPLANATIONS
```

Avoid:

```text
"We changed X and therefore Y increased."
```

unless evidence genuinely supports causation.

Prefer:

```text
"Y increased after X. The timing is consistent with the hypothesis,
but concurrent changes A and B reduce causal confidence."
```

---

# 33. AUTHORITY MODEL

Analyzer7 is primarily read-only.

Default authority:

```text
READ:
allowed

ANALYZE:
allowed

WRITE LOCAL ANALYSIS STATE:
allowed

MODIFY PRODUCTION:
not allowed

PUBLISH:
not allowed

CHANGE MARKETING:
not allowed

CHANGE PRODUCT:
not allowed
```

If the existing harness family has an authority model, reuse it.

---

# 34. SECURITY

Never persist secrets into:

```text
state
reports
evidence
markdown
git
logs
```

Use existing credential/environment conventions.

Redact:

```text
API keys
tokens
cookies
credentials
PII where unnecessary
```

---

# 35. ADAPTER ARCHITECTURE

Do not tightly couple Analyzer7 core to providers.

Prefer conceptual interfaces like:

```text
analytics source
search source
revenue source
product source
ranking source
performance source
```

Examples:

```text
GA4 adapter
GSC adapter
Stripe adapter
ranking adapter
DB adapter
```

Normalize observations before analysis where useful.

But do not over-engineer an abstract plugin framework unless existing harnesses already use one.

---

# 36. RECIPES

If recipes are an established pattern in Hyper7 family, Analyzer7 should include useful recipes such as:

```text
seo-audit
seo-weekly
experiment-analysis
growth-baseline
revenue-audit
tracking-audit
monthly-business-review
ranking-monitor
content-decay
conversion-funnel
```

A recipe should orchestrate existing capabilities, not contain hidden business logic.

---

# 37. INITIAL SEO RECIPE

A useful initial SEO audit should inspect available data and produce:

```text
SEO HEALTH

Data availability

GSC overview

Organic trend

Top queries

Top pages

Winning queries/pages

Declining queries/pages

Positions 4–15 opportunities

High-impression low-CTR opportunities

Cannibalization candidates

Indexation issues

CWV/performance issues

Ranking changes

Recent SEO-related changes

Potential confounders

Evidence-backed opportunities

Data gaps
```

Do not turn it into a generic 200-item SEO checklist.

Prioritize evidence.

---

# 38. INITIAL PRODUCT/GROWTH RECIPE

For a SaaS such as Banu AI, Analyzer7 should eventually support:

```text
visitor
→ signup
→ first question
→ activated
→ repeat usage
→ 7-day return
→ 30-day return
→ paid
→ retained paid user
```

Metrics should be configurable per project.

Analyzer7 must not hardcode Banu-specific business logic into the generic harness.

---

# 39. TESTING

Implement meaningful tests according to the conventions of the existing harnesses.

At minimum test scenarios equivalent to:

### Fresh project

No Analyzer7 state exists.

Expected:
safe initialization.

### Resume

Existing state/evidence.

Expected:
resume without restarting analysis.

### Missing source

GSC configured but unavailable.

Expected:
degraded analysis, no fabricated values.

### Stale source

Ranking data older than expected.

Expected:
explicit stale warning.

### Conflicting sources

GA4 says 100 conversions.
DB says 91.

Expected:
surface discrepancy.

### Experiment evaluation

Experiment with baseline + after data.

Expected:
correct metric calculations and evidence record.

### Confounded experiment

Multiple changes overlap.

Expected:
causal confidence reduced or uncertainty surfaced.

### SEO rankings

Use fixtures modeled after:

```text
/Users/adrianfilip/Work/cmr/.agents/skills/seo-rankings
```

without requiring live APIs in unit tests.

### Legacy compatibility

Existing Hyper7-family projects should not break.

---

# 40. DOCUMENTATION

Create documentation consistent with the other harnesses.

Explain:

```text
What Analyzer7 is
What Analyzer7 is NOT

Architecture

State model

Evidence model

Source model

Metric dictionary

SEO subsystem

Rankings integration

Cross-harness integration

AUDIT / MONITOR / MAINTAIN

Authority/security

Examples
```

Include realistic workflows.

---

# 41. DO NOT CREATE AN AGENT ZOO

Do not introduce:

```text
SEO7
Analytics7
Revenue7
Experiment7
Tracking7
Rank7
```

These are capabilities/subsystems of Analyzer7.

Create separate harnesses only if a future architectural need clearly justifies them.

---

# 42. DO NOT OVERBUILD V1

V1 should prove the architecture.

Prioritize:

```text
1. persistent Analyzer7 state
2. source registry
3. metric definitions
4. evidence ledger
5. change registry
6. experiment analysis
7. SEO subsystem
8. rankings integration
9. cross-harness references
10. useful AUDIT workflow
```

Adapters that require credentials can initially define contracts and fixtures if live integration would significantly increase scope.

Do not spend weeks implementing every possible API.

---

# 43. IMPLEMENTATION PHASES

Use roughly this sequence, adapting it after repository inspection.

## Phase 0 — Reconnaissance

Inspect:

```text
~/hyper/
```

and:

```text
/Users/adrianfilip/Work/cmr/.agents/skills/seo-rankings
```

Document existing patterns.

## Phase 1 — Analyzer7 Core

Implement:

```text
bootstrap
persistent state
context
source registry
metric dictionary
evidence ledger
change registry
resume
```

## Phase 2 — Analysis Model

Implement:

```text
baseline
observation
comparison
data quality
evidence strength
causal confidence
confounders
experiment evaluation
```

## Phase 3 — SEO

Implement:

```text
SEO state
GSC-compatible model
ranking model
seo-rankings integration
opportunities
ranking changes
CTR analysis
page/query analysis
```

## Phase 4 — Cross-Harness

Integrate cleanly with:

```text
Marketer7
Signal7
Hyper7
Scout7
```

without tight coupling.

## Phase 5 — Recipes & Tests

Add representative workflows, fixtures and regression tests.

---

# 44. IMPORTANT DESIGN QUESTION: BIG PICTURE CONTEXT

Analyzer7 should construct and maintain its own analytical big picture.

Do NOT require the human to manually recreate context every session.

On first initialization it may infer/configure:

```text
project
business/product
available sources
important metrics
existing experiments
existing changes
SEO properties
measurement constraints
```

from the repository and neighboring harness state.

Persist the useful canonical state.

On subsequent runs:

```text
/analyzer
```

should resume from persisted state.

The human provides corrections and goals.

The harness maintains operational analytical memory.

---

# 45. MACHINE STATE VS HUMAN STATE

Prefer human-readable canonical artifacts where practical.

However, if structured data materially improves reliability, use JSON/YAML alongside markdown.

Example:

```text
evidence index → structured
evidence explanation → markdown

metric registry → structured
analysis report → markdown
```

Follow patterns already present in the ecosystem.

Do not create duplicate sources of truth.

---

# 46. SUCCESS CRITERIA

Analyzer7 V1 is successful when the following scenario works:

Marketer7 defines:

```text
EX-014
```

Signal7 publishes an SEO change related to EX-014.

Analyzer7 can discover/reference:

```text
mission
experiment
publication/change
```

Analyzer7 reads available GSC/ranking data.

It establishes the relevant baseline.

After the measurement window it produces:

```text
EV-###
```

containing:

```text
what changed
what happened
metric before
metric after
source
data quality
evidence strength
causal confidence
confounders
references
```

Marketer7 can consume that evidence for the next decision.

At no point does Analyzer7:

```text
invent metrics
claim unjustified causality
publish content
modify production
silently redefine metrics
duplicate Marketer7 strategy
```

---

# 47. QUALITY BAR

Favor:

```text
simple
inspectable
traceable
deterministic where possible
human-readable
composable
evidence-driven
```

over:

```text
clever
agentic for its own sake
large
opaque
autonomous without evidence
```

The best Analyzer7 implementation should feel like it naturally belongs next to Hyper7, Marketer7, Signal7 and Scout7.

---

# 48. BEFORE WRITING CODE

Do these steps first:

1. Inspect `~/hyper/`.
2. Locate Hyper7, Marketer7, Signal7 and Scout7.
3. Inspect their architecture and contracts.
4. Inspect `/Users/adrianfilip/Work/cmr/.agents/skills/seo-rankings`.
5. Identify reusable conventions.
6. Identify cross-harness integration points.
7. Identify anything in this specification that conflicts with existing architecture.
8. Adjust the implementation design accordingly.
9. Write a concise implementation plan.
10. Then implement.

Do NOT stop after producing the plan unless there is a genuine blocker.

Proceed through implementation, tests and documentation.

---

# 49. AFTER IMPLEMENTATION

Run the relevant tests and inspect the resulting repository.

Then report:

```text
IMPLEMENTED
- ...

REUSED FROM EXISTING HARNESSES
- ...

ANALYZER7 ARCHITECTURE
- ...

SEO/RANKINGS
- ...

CROSS-HARNESS INTEGRATIONS
- ...

TESTS
- ...

NOT IMPLEMENTED / DEFERRED
- ...

RISKS / OPEN QUESTIONS
- ...
```

For every deferred item, explain why it was deferred.

Do not claim integrations work unless they were actually tested.

---

# FINAL PRINCIPLE

Analyzer7 exists to turn activity into evidence.

The ecosystem should close this loop:

```text
Scout7
   ↓
external intelligence

Marketer7
   ↓
hypothesis / experiment

Signal7 / Hyper7
   ↓
real-world change

Analyzer7
   ↓
measurement + evidence

Marketer7
   ↓
next decision

eventually:

Business7
   ↓
business-level decision
```

Analyzer7's fundamental responsibility is:

> **Observe reality, preserve evidence, quantify uncertainty, and make the result usable by the rest of the system.**

Build Analyzer7 accordingly. You can see in ../  Hyper7 Signal7 Scout7 Markerter7 for the starting structure and harnest structure