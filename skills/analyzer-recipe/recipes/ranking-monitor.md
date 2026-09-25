---
name: ranking-monitor
description: Track keyword rankings between rank-tracker snapshots and alert on losses, URL switches, and stale data.
---

# Ranking monitor

1. Confirm that a `ranking` source is registered, and check its health; a stale source is reported as stale and not compared. Without a rank tracker the project may opt into the Search Console proxy: pull GSC `date,query` and run `seo.mjs rank-proxy --into <ranking source>`. It is labeled as an average-position proxy.
2. Ingest the newest rank-tracker export (`--retrieved-at` set to when it was pulled).
3. Run `seo.mjs rankings --source <id>`; review movement, `url_changed` (possible cannibalization), and SERP-feature changes.
4. With the user's agreement, run it with `--record` to open ranking-loss anomalies (loss ≥ 10 positions, or no longer ranking).
5. Cross-check the GSC `avg_position` for the same queries; never conflate the two measures.
