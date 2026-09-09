# BD-014 — The product name is a display string; identifiers are name-neutral

- **Status:** accepted
- **Date:** 2026-08-28

## Decision
"Agentic" appears only in display strings, docs and a single configuration constant. Package names, database names, env-var prefixes, directory names (`.agentic` default is configurable), Slack app names and Docker image names are derived from that constant or are neutral. Renaming is a documented, one-place change plus a docs search-and-replace.

## Rationale
The founder expects a possible rename; "agentic" is also a generic term with trademark risk.

## Consequences
- Round 2 must define the constant and the env prefix scheme.
