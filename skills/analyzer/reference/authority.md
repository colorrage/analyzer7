# Authority and security

## Authority (default and only mode)

| Action | Allowed |
| --- | --- |
| Read sources, exports, neighbor harness state | yes |
| Analyze | yes |
| Write local analysis state (`.analyzer/`) | yes |
| Modify production, deploy, change code | **no** — hand technical findings to Hyper7 |
| Publish, edit content, titles, or meta | **no** — Signal7 executes after a Marketer7 decision |
| Change marketing, experiments, thresholds, routes | **no** — Marketer7 owns them |
| Change the product | **no** |
| Write `.marketer/`, `.signal/`, `.hyper/`, `.scout/` | **no** |
| Call an external API | only through tools the user has authorized, or the optional read-only connectors (`connect.mjs`: `webmasters.readonly`, `analytics.readonly`, public HTTP GET), run explicitly. All other scripts make no network calls |

MAINTAIN refreshes Analyzer7's own records only. "Automatic" never means changing something outside `.analyzer/`.

## Security

- Never persist secrets or credentials into state, reports, evidence, markdown, git, or logs. The source registry stores the auth **method** and env-var or tool **names** only, and `record.mjs source` refuses values that look like secrets.
- Every Analyzer7 write passes through redaction (API keys, OAuth/bearer tokens, JWTs, private keys, credentialed URLs, `password=`/`token=` pairs, and email addresses as unnecessary PII). `validate-state.mjs` fails on anything that survives.
- Keep PII out of observations: export aggregates (counts per day/segment), not user-level rows. If a tool returns user-level data, aggregate before ingesting.
- Use the project's existing credential conventions (environment variables, the MCP server's own auth). Analyzer7 adds none.
