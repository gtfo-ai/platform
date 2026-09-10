# Loki HTTP fixtures — where each one comes from

WP-11 was implemented **without access to a Loki instance**. Nothing here was recorded from a live
call, and pretending otherwise is exactly how a provider adapter passes its own tests and fails in
production. Every document is derived from Grafana's *published* documentation, and every recorded
interaction carries a `source` block naming the page, the date it was retrieved and how far the
interaction sits from it.

## The provenance lives on the interaction, not on the file

Each file here is one recorded **conversation** — `{"interactions": [...]}`, replayed by
`test/contract/support/integrations/http-replay.ts` — and a single conversation legitimately cites
several pages: in `query-range.json` the unfiltered `200` comes from the HTTP API reference and the
filtered one from the LogQL page, because the *query* is what that page documents. A file-level
block would have to pick one, so the block sits on the interaction, where the claim is true. Both
shapes are accepted and `test/contract/support/integrations/fixture-provenance.ts` says why, and why
partial coverage or an empty `interactions` list is a failure rather than a pass.

| `evidence` | what it means |
|---|---|
| `documented-adapted` | Grafana's own published example, with values replaced by obviously fake ones (BD-002) and members the adapter never reads removed. Nothing about the *shape* is ours. |
| `composed` | The shape is documented and so is the **query**; the pairing of the two is not, because no page shows the response to a filtered query. The `note` says what was assembled. |
| `inferred` | The documentation does **not** state this. Loki's HTTP API reference publishes **no status-code table at all**, so every non-200 here is inferred, and so is the response to a selector that matches nothing. The `note` says what was assumed and what the adapter does about it. |
| `documented`, `invented` | Available in the shared vocabulary; **no file here uses them.** Every published example carries `localhost:3100` and label sets from Grafana's own demo cluster, all of which had to be replaced, so nothing is transcribed unchanged. |

## The `source` blocks are checked, and here is exactly how far

`test/contract/integrations/fixture-provenance.contract.test.ts` runs the shared suite over **every**
provider directory under `test/fixtures/http/` — this one included. It asserts that every
interaction in every file has a `source`, that the label is one of the five kinds, that a claim
which is not `invented` cites an `https` URL that is **not** on a domain IANA reserves for
documentation and whose host is named in *this* file, that the `retrieved` date is a real day and
not in the future, and that anything other than plain `documented` carries a `note`.

The host allow-list is scraped from this file's prose, so it is only as narrow as the prose — hence
the reserved-domain deny-list, which is scraped from nothing. It still cannot check that
`grafana.com` says today what a fixture claims, that a body matches the example it cites, that a
label is honest, or that the right interaction carries the right citation. Those remain a
reviewer's job.

## Sources

All retrieved **2026-09-10**.

- `https://grafana.com/docs/loki/latest/reference/loki-http-api/` — the `/loki/api/v1` paths;
  `query_range` with `query`, `limit` ("defaults to 100"), `start` ("defaults to 1 hour ago"),
  `end`, `since`, `step`, `interval` and `direction` ("forward" or "backward", "defaults to
  backward"); the streams response envelope with `status`, `data.resultType`, `data.result[]`
  (`stream` plus `values` of `["<nanosecond epoch>", "<line>"]`) and the full `stats` block; the
  `labels`, `label/<name>/values` and `series` examples with their own defaults ("6 hours ago",
  `match[]` "at least one required"); the accepted timestamp formats; and "If your cluster has
  Grafana Loki Multi-Tenancy enabled, set the `X-Scope-OrgID` header to identify the tenant you
  want to query". **The page publishes no status-code table**, which is why every non-200 fixture
  here is `inferred` and why `http.ts` records its status mapping as a choice.
- `https://grafana.com/docs/loki/latest/query/log_queries/` — the stream-selector grammar, the four
  label matching operators (`=`, `!=`, `=~`, `!~`), the four line filter operators (`|=`, `!=`,
  `|~`, `!~`) with the example `{job="mysql"} |= "error"`, chained line filters, and "To avoid
  escaping special characters you can use the ` (backtick) instead of \" when quoting strings".
  This page is the whole of `logql.ts`.
- `https://grafana.com/docs/loki/latest/query/logcli/getting-started/` — `logcli` and its
  environment: `LOKI_ADDR` ("Server address"), `LOKI_USERNAME` / `LOKI_PASSWORD` ("for HTTP basic
  auth"), `LOKI_BEARER_TOKEN` and `LOKI_BEARER_TOKEN_FILE` ("adds the Authorization header to API
  requests for authentication purposes"), `LOKI_ORG_ID` ("adds X-Scope-OrgID to API requests for
  representing tenant ID") and the TLS paths. **No fixture**: this is the agent-tooling contract,
  and it is the reason Loki declares a CLI spec where Sentry declares nothing.
- `https://grafana.com/docs/loki/latest/configure/` — `limits_config` is where a Loki operator sets
  per-tenant query limits. **No fixture, and deliberately no transcribed default**: the section was
  truncated in the page as fetched, so the registration's rate-limit budget is recorded as a choice
  rather than as a number read off a page.

## What is deliberately **not** in a fixture

- **Credentials.** The bearer token is built at run time from an obviously fake string, so the
  repository's own secret scanner has nothing to find (BD-002).
- **Very large payloads.** The port's byte caps are about a 50 MB line and a multi-megabyte result.
  Committing either would be a fixture nobody can read and a repository nobody wants to clone, so
  those two cases are **scripted responses built inside the test** — the test's own business, not
  the corpus's — and the replay harness excludes a scripted response from the coverage accounting
  for exactly that reason.
- **Sequencing.** These files are recorded exchanges, not a state machine. `http-replay.ts` decides
  which recorded response answers which request, counts what was served, and fails on a fixture
  nothing exercises.

## Ambiguities found in the documentation, and what was done about them

1. **No status-code table.** The reference documents statuses only in passing (`/ready` answers
   200, a malformed push timestamp answers 400). The adapter's mapping from status to
   `IntegrationErrorCode` is therefore recorded as a choice in `http.ts`, and the `429` fixture is
   labelled `inferred` rather than presented as Loki's documented rate-limit answer.
2. **Nothing states what an empty match returns.** An empty `result` array in the documented
   envelope is the reasoned guess. It is the most consequential case in the corpus, because "no
   lines" is what an agent reads as "the error stopped" — which is why the adapter's `truncated`
   flag is asserted for it, not just its `line_count`.
3. **Ordering across streams is not specified.** The page shows one stream. Loki orders entries
   *within* a stream by `direction`; the port's consumers read the streams flattened, so the
   adapter sorts globally and regroups, and the fixture carries two streams so that a test can tell
   the difference.
4. **Structured metadata may add a third element to a values tuple** in Loki 3.x. The schema models
   an entry as an open array whose first two members are checked, rather than as a two-tuple that
   would reject it.
