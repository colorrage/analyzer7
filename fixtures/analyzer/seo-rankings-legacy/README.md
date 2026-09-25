# seo-rankings legacy fixture

Two files in the exact formats the CMR `seo-rankings` skill writes (`templates/snapshot.md` and its baseline format), with invented markets and values. Analyzer7 imports them in place through the `seo-rankings-md` adapter; the files are never rewritten.

- The baseline uses `### DEU`-style market headings and frontmatter `range_start`/`range_end`.
- The snapshot uses `### Germany (de)`-style headings and the blockquote "Date range" line.

The two files label markets differently (DEU vs de), as real seo-rankings output does. Analyzer7 keeps each label as the `segment` value unless the operator maps it explicitly at ingest (`--segment-map de=DEU,pl=POL`). The adapter never guesses a mapping.
