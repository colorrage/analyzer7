---
name: seo-weekly
description: Weekly SEO pass — refresh GSC and rankings, run the monitors, compare the last 7 days with the prior 7, and surface only meaningful movement.
---

# SEO weekly

1. Probe state; refresh the GSC `date` and `date,page` pulls and the rank-tracker export; ingest them.
2. Run `analyze.mjs monitor` (SEO monitors: organic clicks and impressions, weekday-aligned 7-day windows); record alerts with the user's agreement.
3. Run `seo.mjs rankings --record` for losses of 10+ positions and URL switches. Stale rankings are reported as stale, not compared.
4. Run `seo.mjs compare` for the last 7 days vs the prior 7 at `--dimensions page`.
5. Import new Signal7 publications (`discover.mjs --import-changes`) and list SEO changes shipped this week.
6. Summarize in five lines or fewer: movement worth attention, alerts, stale sources, and the next analytical action.
