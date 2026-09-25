---
schema_version: 1
project_name: <project-name>
created_at: <ISO-8601 timestamp>
state_root: .analyzer
timezone: UTC
authority: read_only
---

# Analyzer7 project

## Business context

What the product is, who it serves, and which outcomes matter. Mark anything inferred as `inferred` until a human confirms it.

## Measurement constraints

Known tracking gaps, consent/ad-blocking effects, data retention limits, restated data, and properties that must not be mixed.

## Authority

Analyzer7 reads sources, analyzes, and writes only inside `.analyzer/`. It does not modify production, publish, change marketing, or change the product. Findings that need action are handed to Marketer7 (decision), Signal7 (content), or Hyper7 (technical).
