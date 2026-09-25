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

### Expected-CTR curve, click-gain ranking, and false discoveries

- **Fitted curve.** Each audit fits expected CTR by rounded position (1–20) from the property's own query×page rows. It uses impression-weighted CTR per bucket, requires ≥ 500 impressions and ≥ 5 rows, and is forced non-increasing by pool-adjacent-violators. Thin buckets fall back to `expected_ctr_curve`, the heuristic. The report states `fitted`, `mixed`, or `heuristic`.
- **CTR opportunities** must be below half the expected CTR *and* significantly below it: a one-sided binomial test, over-dispersion adjusted, with Benjamini–Hochberg FDR q = 0.1 across all candidates. They are ranked by `estimated_click_gain_28d` = impressions × (expected − actual CTR), per 28 days.
- **Content decay** candidates must pass the same FDR control on a per-day click rate test. They are ranked by `estimated_click_loss_28d`.
- **Positions 4–15** carry `upside_if_top3_28d`, a hypothetical: clicks at about position 3 on the curve. It is shown separately and never mixed into the ranking.
- **Cannibalization** is ranked by `contested_impressions`, the impressions held by the non-leading URLs. There is no click estimate.
- **Winners and decliners** list only click changes that survive FDR control across every compared row. The report states how many were tested and how many were significant.

Estimates are for prioritizing review, not forecasts.

`segments` generalizes the seo-rankings markets table: `[{"key": "country", "value": "DEU", "label": "Germany", "url_prefix": "/de/", "tier": "1"}]`. Ingest a per-segment pull with `--set country=DEU`, and pass `--segment-key country` to keep cannibalization per segment.

## Technical findings (crawl)

`server_error, client_error, redirect_chain (> 1 hop), missing_title, missing_meta_description, canonical_mismatch, noindex_in_sitemap, non_200_in_sitemap, orphan_page (0 inlinks), structured_data_errors, duplicate_title, duplicate_meta_description`. Owner: Hyper7. Verification: a later crawl.

## Core Web Vitals

p75 thresholds: LCP 2.5 s / 4 s, INP 200 ms / 500 ms, CLS 0.1 / 0.25 (good / poor). A regression is a class that got worse, or p75 worsened by ≥ 20% between snapshots. Field data lags by up to 28 days.

## Indexation

Verdicts: `indexed, crawled_not_indexed, discovered_not_indexed, excluded_noindex, canonical_mismatch, not_found, redirect, blocked_robots, server_error, soft_404, unknown, other`. Google-selected versus user-declared canonical mismatches are reported separately. URLs whose status the source cannot establish are listed under `cannot_prove`. Absence from the rows proves nothing.
