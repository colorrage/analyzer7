---
name: monthly-business-review
description: Monthly evidence review for Marketer7 and Business7 — calendar-month baselines, experiment outcomes, anomalies, SEO health, and data confidence in one report.
---

# Monthly business review

1. Use calendar-aligned windows: the closed month vs the previous month, normalized per day.
2. Run the `growth-baseline` recipe for the closed month (the audit with `--days` set to the month length).
3. Run `analyze.mjs maintain --report`.
4. Summarize the evidence recorded this month (from `evidence/index.md`): each EV with its three axes.
5. Summarize experiments evaluated or pending, open anomalies, and SEO opportunities awaiting review.
6. Write the report's Interpretation in observation/interpretation/uncertainty form. It is an evidence summary: decisions belong to Marketer7 (growth) and Business7 (business).
