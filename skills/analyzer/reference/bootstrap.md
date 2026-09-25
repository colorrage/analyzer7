# Bootstrap, resume, and ID allocation

## State root

All live state is project-local in `.analyzer/`, next to the neighbor roots it reads (`.marketer/`, `.signal/`, `.hyper/`, `.scout/`). Never store live state in the Analyzer7 repository or a skill folder. Scripts resolve the project as: explicit `--project` → nearest ancestor containing `.analyzer/` → git top-level → current directory.

## Bootstrap

Run `node "<skill-base-dir>/scripts/init.mjs" --project <dir> [--seed seo,funnel] [--timezone <IANA>]` only when the user starts Analyzer7 work in that project.

- It is create-only. If `.analyzer/project.md` exists it reports `already_initialized` and writes nothing.
- It writes `project.md`, `context.md`, `sources.json`, `metrics.json`, `monitors.json`, `seo/config.json`, and `memory.md`. Record folders are created lazily by the first record.
- It reads neighbor roots to describe them in `context.md`. It never writes them.
- `--seed seo` adds the four Search Console metrics as `active`: their definitions are fixed by the GSC model. `--seed funnel` adds generic funnel stages as `proposed`, with no canonical source. A proposed metric cannot support evidence until a human confirms its definition (`record.mjs metric-status --status active --reason ...`).
- No source is registered by bootstrap. Register each one only after confirming it is actually available.

## Resume

Every session starts with the probe:

    node "<skill-base-dir>/scripts/state.mjs" [--format text]

Route from its JSON: source health (computed, never stored), active experiments and their next step, recent evidence (last five index lines), open anomalies, opportunities awaiting review, next IDs, neighbor presence, and `next_action`. Read `context.md` for the big picture and `memory.md` for lessons. Open individual records only when the next step needs them (hot → warm → cold, as in Hyper7).

## IDs

| Prefix | Record | Folder |
| --- | --- | --- |
| `EV-NNN` | evidence | `evidence/` |
| `CH-NNN` | change | `changes/` |
| `BL-NNN` | baseline | `baselines/` |
| `AN-NNN` | anomaly | `anomalies/` |
| `SEO-OPP-NNN` | SEO opportunity | `seo/opportunities/` |

The next ID is computed from disk: the highest number in file names or index lines, plus one. There is no stored counter to drift, and because index lines are append-only, an ID is never reissued. IDs are unique within one state root. Across harnesses, qualify them (`analyzer7:EV-042`, `signal7:S21/A1`, `hyper7:T12`, `scout7:R3`). Experiments (`EX-NNN`) and missions (`M<N>`) are Marketer7 IDs that Analyzer7 references and never allocates.
