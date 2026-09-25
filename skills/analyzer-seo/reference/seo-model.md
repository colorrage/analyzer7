# SEO model

## Normalized rows

**GSC rows** (`gsc_rows`): `date?, query?, page?, country?, device?, segment?, clicks, impressions, ctr (fraction), position`. Analysis recomputes CTR as clicks ÷ impressions (a ratio of sums) and position as an impression-weighted mean.

**Ranking observation** (`rankings`): `keyword, location, device, engine, position (null = not ranking / beyond depth), url, serp_features[], observed_at, provider`. Changes are computed per `keyword × location × device × engine` between the two latest snapshots:

| Field | Meaning |
| --- | --- |
| `previous_position`, `current_position`, `delta` | positive delta = worse |
| `movement` | `big_win, improved, stable, slipping, dropped, new, lost, not_ranking, not_observed` |
| `url_changed` | the ranking URL switched (a cannibalization hint) |
| `serp_feature_changes` | features added or removed |
| `alert` | lost, or worsened by at least `ranking_loss_alert` positions (default 10) |

A keyword missing from the current snapshot is `not_observed` (a tracking gap), never `lost`.

## Movement classification (from the seo-rankings skill)

| Class | Rule |
| --- | --- |
| big_win | position improved ≥ 5, or clicks doubled (from ≥ 2) |
| dropped | position worsened ≥ 5, or clicks halved (from ≥ 2) |
| improved | position improved 1–4, or CTR +1 pp |
| slipping | position worsened 1–4 |
| stable | otherwise |

Clicks are compared per day when the period lengths differ.

## Thresholds (`.analyzer/seo/config.json`, defaults)

| Key | Default | Used by |
| --- | --- | --- |
| `quick_win_position_min` / `max` | 4 / 15 | positions 4–15 |
| `striking_distance_min` / `max` | 15 / 30 | page-two candidates |
| `min_impressions` | 100 | positions lists |
| `high_impressions` | 500 | CTR opportunities |
| `ctr_gap_ratio` | 0.5 | flag when CTR < ratio × heuristic expected CTR at that position |
| `cannibalization_min_share` / `_min_impressions` / `_max_position` | 0.1 / 50 / 20 | ≥ 2 URLs each holding ≥ 10% of a query's impressions **and** ranking within the top 20 on average |
| `max_recorded_per_type` | 10 | at most this many SEO-OPP records per type per audit (most material first); the report keeps the full lists |
| `ranking_loss_alert` | 10 | ranking anomaly |
| `decline_pct` / `min_clicks_for_decline` | 20 / 20 | content decay |

`expected_ctr_curve` is a heuristic flagging aid. Replace it with a curve fitted to the property's own data when available. It is never a forecast of clicks.

`segments` generalizes the seo-rankings markets table: `[{"key": "country", "value": "DEU", "label": "Germany", "url_prefix": "/de/", "tier": "1"}]`. Ingest a per-segment pull with `--set country=DEU`, and pass `--segment-key country` to keep cannibalization per segment.

## Technical findings (crawl)

`server_error, client_error, redirect_chain (> 1 hop), missing_title, missing_meta_description, canonical_mismatch, noindex_in_sitemap, non_200_in_sitemap, orphan_page (0 inlinks), structured_data_errors, duplicate_title, duplicate_meta_description`. Owner: Hyper7. Verification: a later crawl.

## Core Web Vitals

p75 thresholds: LCP 2.5 s / 4 s, INP 200 ms / 500 ms, CLS 0.1 / 0.25 (good / poor). A regression is a class that got worse, or p75 worsened by ≥ 20% between snapshots. Field data lags by up to 28 days.

## Indexation

Verdicts: `indexed, crawled_not_indexed, discovered_not_indexed, excluded_noindex, canonical_mismatch, not_found, redirect, blocked_robots, server_error, soft_404, unknown, other`. Google-selected versus user-declared canonical mismatches are reported separately. URLs whose status the source cannot establish are listed under `cannot_prove`. Absence from the rows proves nothing.
