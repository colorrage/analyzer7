---
name: analyzer-monitor
description: Runs Analyzer7 MONITOR mode — evaluates monitor rules over the latest data and opens anomaly records only when relative and absolute thresholds, minimum sample, direction, and a significance guard all agree, plus tracking-break detection (vanished or zeroed data). Use when the user asks to watch metrics, check for alerts, detect anomalies, or "did anything break". Keywords: analyzer, monitor, anomaly, alert, threshold, tracking break, regression, drop.
user-invocable: false
---

# analyzer-monitor

MONITOR detects meaningful deviations without alert spam.

## Read first

`../analyzer/reference/evidence-model.md` (data-quality checks) and `../analyzer/reference/sources-and-metrics.md`.

## Monitor rules (`.analyzer/monitors.json`)

```json
{"id": "MON-organic-clicks", "metric": "organic_clicks", "source": "gsc", "scope": {},
 "window_days": 7, "relative_threshold_pct": 25, "absolute_threshold": 30, "min_sample": 200,
 "min_significance": 2, "direction": "decrease", "severity": "high", "enabled": true}
```

- Windows end at the source's `data_through` and compare with the immediately preceding window. Use multiples of 7 days so the weekday mix matches; other lengths are flagged.
- An alert needs **all** guards: relative change, absolute change, minimum sample, direction, and |statistic| ≥ `min_significance`. A reading that fails a guard is reported as `quiet`, with the failed guards named.
- Significance must be computable: with no variance estimate (for example a mean metric over windows shorter than 7 days) the guard fails. Monitor with ≥ 7-day windows over daily rows.
- Minimum sample: for counts, the previous (reference) window must reach `min_sample`, so a collapse from a reliable baseline still alerts while a spike from a tiny baseline does not. For ratios and means, both windows must reach it.
- Tracking break: data that vanishes or drops to zero after real volume alerts on its own (severity high), because it invalidates every other reading.
- An unavailable source produces `insufficient_data`, never an alert about the metric.

Propose rules to the user (one per decisive metric, thresholds matched to its volatility) and write them to `monitors.json` only after agreement.

## Steps

1. Probe state. Refresh stale sources first when the user can.
2. Run `node "<skill-base-dir>/../analyzer/scripts/analyze.mjs" monitor` (dry run), and show alerts, quiet readings, and insufficient data.
3. With the user's agreement, record: `analyze.mjs monitor --record`. An anomaly already open for the same monitor is not duplicated.
4. For SEO-specific monitors (ranking loss > 10 positions, CWV regressions), run `seo.mjs rankings --record` and the CWV part of `seo.mjs audit --record`.
5. Resolve or dismiss anomalies with a reason: `record.mjs status --id AN-NNN --status resolved|dismissed --note "<why>"`.

Registered changes in the window are listed as **candidate explanations, not conclusions**.
