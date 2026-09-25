---
name: conversion-funnel
description: Measure a configured funnel (for example visitor → signup → activation → return → paid → retained) stage by stage from canonical sources.
---

# Conversion funnel

1. Confirm the funnel in `metrics.json` `funnels`, and that every stage metric is `active` with a canonical source. The stage definitions are project-specific; nothing is assumed.
2. Ingest aggregated daily counts for each stage from its canonical source.
3. Run `analyze.mjs funnel --funnel <id> --start --end` for two equal periods.
4. Report stage values, step conversion rates, the stages excluded as unconfirmed, and steps whose stages come from different systems (their rates mix sources).
5. For a stage that moved, use the `analyzer-evidence` skill to compare periods with the registered changes before suggesting any cause.
