---
name: analyzer-change
description: Maintains the Analyzer7 change registry — what changed, when, where, and from which system — by importing Signal7 publications (and opt-in Hyper7 work) idempotently and recording manual, deployment, pricing, campaign, and tracking changes as append-only CH-NNN records, so that later observations can be correlated with changes without claiming causation. Use when the user says something shipped, was published, deployed, or changed tracking, or asks what changed during a period. Keywords: analyzer, change, CH-, release log, deployment, publication, signal7, hyper7, tracking change, timeline.
user-invocable: false
---

# analyzer-change

Without a change registry, analytics cannot be interpreted. Changes inside a measurement window are the most common reason an attribution fails.

## Read first

`../analyzer/reference/data-model.md` (change record) and `../analyzer/reference/cross-harness.md`.

## Import

`node "<skill-base-dir>/../analyzer/scripts/discover.mjs" --import-changes [--include signal7,hyper7] [--dry-run]`

- Signal7 publications import by default, with the publish-ledger timestamp, the publication URL as the page scope, and the mission, experiment, and asset links. Re-running is idempotent.
- Hyper7 import is opt-in. Hyper records no deploy time, so the records are `confirmed: false` with a proxy timestamp. Ask the user for the real deploy time and pages, then supersede.

## Import a project change log

`record.mjs import-changes --file <release-log.md|changes.csv> [--table "<heading>"] [--date-means applied|deployed] [--default-type <type>] [--dry-run]`

- Columns are matched by name (Date / Deploy date / Applied / URL(s) / Change type / Task / Notes). A lone `Date` column must be declared: `deployed` if it is the go-live date, `applied` if the changes went live later (then they import as **pending**).
- Pages come from the URL column only (backticked paths or URLs). Rows with no paths ("56 items") or with wildcards are unknown scope.
- Re-importing is idempotent. Run `--dry-run` first and show the rows to the user. On a recurring refresh, pass `--since <day after the last import>` so older rows (possibly registered by hand) are not imported again.

## Mark changes deployed

When pending changes go live (a sync, a release): `record.mjs deploy --changes CH-005,CH-006 --deployed-at <ISO with timezone> [--deployment <id>]`. Always measure from the deploy time, never the apply time.

## Record manually

`record.mjs change --title "<what>" --origin manual|deployment|marketer7|external --type <type> --timestamp <ISO with timezone>|unknown [--basis deploy_log|commit|manual] [--applied-at <ISO>] [--deploy-status pending] [--pages /a,/b] [--experiment EX-NNN] [--mission M<N>] [--deployment <id>] [--details "title rewritten|FAQ added"]`

- Always record tracking changes (`--type tracking_change`). They break comparability wherever they land.
- An unknown timestamp is allowed and recorded as `unknown`: an unplaced change weakens every overlapping analysis, and saying so is better than guessing.
- Correct a record with a new one: `--supersedes CH-NNN`. Never edit the original.

## What changed in a period

Read `.analyzer/changes/index.md` (date-first lines), then open only the records in the period of interest.
