# Evidence model

Analyzer7 answers: **what actually happened, and how strong is the evidence?** Three axes are recorded separately and never merged:

| Axis | Question | Values |
| --- | --- | --- |
| Data quality | Can these numbers be trusted? | `high`, `medium`, `low`, `insufficient` |
| Evidence strength | Is the observed change real, and not noise or an artifact? | `high`, `medium`, `low`, `insufficient` |
| Causal confidence | Did the linked change cause it? | `high`, `medium`, `low`, `none` |

Each axis caps the next: weak data cannot yield strong evidence, and weak evidence cannot support causal confidence. The scripts compute the ceiling for each axis and record every reason. An analyst may **lower** a level, with a written reason, but never raise it.

A fourth field, `evidence_grade` (A–E), comes from the metric dictionary. It is Marketer7's directness grade (A observed behavior … D engagement/impressions, E model assumption), carried so Marketer7 can cite the evidence without translation.

## Data quality

The level is the worst severity among the detected issues: any `blocking` issue → `insufficient`, any `major` → `low`, any `minor` → `medium`, none → `high`.

| Check | Severity |
| --- | --- |
| source unavailable / unconfigured / disabled; no rows; no snapshot covering the period; period more than 50% after the data ends; more than 50% of days missing; metric only `proposed` | blocking |
| source stale; 10–50% of days missing; duplicate row keys; negative/non-numeric values; sudden run of zero days (possible tracking break); sample below the metric minimum; tracking change inside the period; before/after snapshots with a different property, adapter version, or dimensions; cross-source discrepancy beyond tolerance; property-level GSC totals derived from query/page rows; measurement window not yet closed; recorded baseline restated by more than 10% | major |
| up to 10% of days missing; source-reported warnings; source vs analysis timezone mismatch; non-canonical source used; query rows omitting anonymized queries; baseline restated by 1–10% | minor |

When the level is `insufficient`, no delta is reported and the conclusion is **INSUFFICIENT DATA**. Observed values stay visible and missing values stay `unknown`, never `0`.

## Evidence strength

1. Significance of the shift, in order of preference. Welch t over daily values (at least 7 days per period). Otherwise a pooled two-proportion z for rate metrics, or a Poisson per-day rate z for counts. Both fallbacks are divided by √overdispersion (default 2), because web counts are over-dispersed. |statistic| ≥ 3 → high, ≥ 2 → medium, otherwise low. With no variance estimate the shift cannot be separated from noise: an effect of at least 20% earns medium, anything smaller low.
2. Caps: data quality medium → at most medium; low → at most low; the shortest window under 14 days → medium, under 7 → low; persistence not checkable (needs at least 14 dated days after) → medium; halves of the after period disagree in direction → low; no change at all → low.
3. `insufficient` when data quality is insufficient, a period has no value, or the sample is below the metric minimum.

## Causal confidence

1. `none` when no registered change or experiment is linked (the record is an observation, not an attribution), evidence is insufficient, the linked change has unknown timing, it happened after the window, or it predates both compared periods.
2. Design ceiling: `randomized_controlled` → high, `controlled` → medium, `before_after` → medium, `observational` → low.
3. Evidence caps: low evidence → at most low; medium evidence → at most medium.
4. Confounders lower the level: each **major** confounder by one step, and three or more **minor** confounders together by one step. `info` entries are listed but never lower it. The floor is `low` while a linked change with consistent timing exists.

| Confounder | Severity |
| --- | --- |
| another registered change on the same pages inside the baseline or window | major |
| a tracking change inside the compared periods | major |
| average position shift ≥ 2 (CTR-type metrics) / impressions shift ≥ 50% | major |
| the linked change sits more than 25% into the baseline period | major |
| a change with unknown scope (no pages) in the periods; a change with unknown timing and overlapping scope; unconfirmed timing of the linked change | minor |
| position shift 0.5–2; demand (impressions) shift 10–50%; periods whose weekday mix differs; the linked change mid-window; external context recorded (for example a Scout7 batch) | minor |
| the linked change in the last ≤ 5% of the baseline or the first ≤ 5% of the window | info |

Correlation is never reported as causation. With linked changes and caveats, the interpretation reads: "Y increased after X. The timing is consistent with the hypothesis, but concurrent factors A, B reduce causal confidence." Without a linked change it reads: "… this is an observation, not an attribution."

## Experiments

Analyzer7 compares the observed primary value with Marketer7's locked thresholds. It reports `success_threshold_met`, `failure_threshold_met`, `between_thresholds`, `insufficient_data`, or `thresholds_unparseable`. It never writes `win`, `loss`, or a route decision. The measured Marketer7 definition fingerprint is recorded in every experiment evidence record.
