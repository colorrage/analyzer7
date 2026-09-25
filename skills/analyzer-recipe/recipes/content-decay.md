---
name: content-decay
description: Find pages whose organic clicks are decaying, with position and impression context, and flag them for Marketer7 review.
---

# Content decay

1. Ingest the GSC `date,page` pull covering the last 56 days (or two equal calendar-aligned windows).
2. Run `seo.mjs audit` and read `content_decay` and `page_movement.declining`.
3. For each declining page, check the registered changes on that page (`changes/index.md`) and position movement (a ranking loss, not the content, may explain it).
4. With the user's agreement, record the findings as SEO-OPP (`seo.mjs audit --record`).
5. Hand-off: Marketer7 decides whether to refresh; Signal7 executes; Analyzer7 measures the refresh as a change.
