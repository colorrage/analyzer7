# Reporting

Every report and evidence record distinguishes:

| Section | Content |
| --- | --- |
| Observation | What the data shows, with values, periods, and sources. No verbs of causation. |
| Interpretation | What it might mean, bounded by the recorded causal confidence. |
| Evidence | The three axes (data quality, evidence strength, causal confidence) and their reasons. |
| Uncertainty | Design limits, seasonality, discrepancies, missing data. |
| Possible explanations | The linked change, confounders, and "unregistered changes, algorithm updates, or seasonality". |

Wording rules:

- Prefer "Y increased after X. The timing is consistent with the hypothesis, but concurrent changes A and B reduce causal confidence." over "We changed X and therefore Y increased."
- Say `INSUFFICIENT DATA` rather than inventing a conclusion. Missing values are `unknown`.
- Every number cites its source, property, period, retrieval time, and snapshot file (the Provenance section). Never fabricate or estimate source data.
- A heuristic (the expected-CTR curve, a title-based change classification) is labeled as one.
- Findings that need action name the owner (Marketer7 decides, Signal7 or Hyper7 executes). They are never phrased as instructions to change production.

Reports go to `.analyzer/reports/<date>-<mode>-<scope>.md` with frontmatter `mode (audit | monitor | maintain), scope, generated_at, sources, artifacts`. Scripts fill the deterministic sections. The `Interpretation` section is written by the analyst within these rules.
