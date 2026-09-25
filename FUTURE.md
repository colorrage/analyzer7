# Future updates

Deferred deliberately. Each item says why.

## More connectors

Status: partial. Optional read-only connectors ship for Search Console (search analytics and URL inspection), GA4, crawl, and PageSpeed. Stripe, CRM, email, and database connectors are not built; use exports with `ingest.mjs`.

## Randomized designs

Status: partial. Difference-in-differences against untouched control pages and year-over-year seasonal checks are shipped. Randomized or holdout readers (for example A/B assignment exports) are not, so `randomized_controlled` is accepted as a declared design but not verified.

## Hyper7 deploy timestamps

Status: supported on the Analyzer7 side. Analyzer7 reads an optional `deployed_at` from Hyper7 task and loop frontmatter, and `deployed_at`/`live_at` from Signal7 ledger rows. Hyper7 and Signal7 do not write those fields yet; until they do, use `record.mjs import-changes` or `record.mjs deploy`.

## Marketer7 import automation

Status: partial. `analyzer-opportunity/v1` exports, `exports.mjs list`, and Marketer7's read-only `scripts/list-analyzer-exports.mjs` ship. The copy into `contracts/` and the backlog entry stay deliberate Marketer7 actions; automating them would be a Marketer7 decision.

## Business7 summaries

Status: future. Business7 does not exist yet. The probe JSON and the monthly-business-review recipe are the intended inputs.

## UI

Status: out of scope, consistent with the family. The file-based harness comes first.
