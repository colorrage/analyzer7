---
name: experiment-analysis
description: Measure a Marketer7 experiment end to end — link its changes, plan and baseline before the window, evaluate after it closes, and export evidence back to Marketer7.
---

# Experiment analysis

1. `discover.mjs` — confirm the experiment's Marketer7 status, window, primary metric, and fingerprint.
2. `discover.mjs --import-changes` — register the Signal7 publication(s) linked to the experiment. Register any other change on the same pages through the `analyzer-change` skill.
3. Confirm that the primary metric maps to a dictionary metric (the `analyzer-source` skill).
4. Before or at window start: `experiment.mjs plan --experiment EX-NNN --record-baseline`.
5. After the window closes and the source covers it (the probe says when): ingest the data, then `experiment.mjs evaluate --experiment EX-NNN --record`.
6. Report the threshold comparison with data quality, evidence strength, causal confidence, and confounders. Give the export path for Marketer7. Marketer7 decides the verdict and the next step.
