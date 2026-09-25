# Future updates

Deferred deliberately. Each item says why.

## Live source clients

Status: deferred. Analyzer7 v1 normalizes exports produced by the provider's own tool (GSC MCP server, GA4/Stripe exports, SQL, rank-tracker CSV) instead of embedding API clients. That keeps credentials out of Analyzer7 and the core free of SDKs, and it keeps the tests deterministic. A later adapter may call an API directly, but only through an authorized, credential-free-in-state mechanism, with the same snapshot contract.

## Controlled designs

Status: partial. The rubric accepts `controlled` and `randomized_controlled` designs, but v1 has no split-traffic or holdout readers (for example A/B assignment exports). Until then most SEO and content changes are before/after comparisons, capped at medium causal confidence.

## Seasonality modelling

Status: deferred. v1 controls weekday mix (weekday-aligned windows) and flags uncontrolled seasonality in every record. Year-over-year baselines and demand-adjusted comparisons need a year of history per property, which a new installation does not have.

## Hyper7 deploy timestamps

Status: blocked on Hyper7. Hyper tasks record `created`, not a deploy time, so imports are unconfirmed proxies. A Hyper7-side optional `deployed_at` (or a deploy log) would make them confirmed automatically.

## Marketer7 import helper

Status: deferred. Marketer7 copies the exported `external-evidence-reference/v1` into its experiment `contracts/`. A Marketer7-side helper that lists pending Analyzer7 exports would remove the manual copy. It belongs in Marketer7, not here, because Analyzer7 never writes `.marketer/`.

## Business7 summaries

Status: future. Business7 does not exist yet. The probe JSON and the monthly-business-review recipe are the intended inputs.

## UI

Status: out of scope, consistent with the family. The file-based harness comes first.
