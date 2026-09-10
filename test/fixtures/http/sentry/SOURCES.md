# Sentry HTTP fixtures — where each one comes from

WP-11 was implemented **without access to a Sentry organization**. Nothing here was recorded from a
live call, and pretending otherwise is exactly how a provider adapter passes its own tests and
fails in production. Every document is derived from Sentry's *published* documentation, and every
recorded interaction carries a `source` block naming the page, the date it was retrieved and how
far the interaction sits from it.

## The provenance lives on the interaction, not on the file

Each file here is one recorded **conversation** — `{"interactions": [...]}`, replayed by
`test/contract/support/integrations/http-replay.ts` — and a single conversation legitimately cites
several pages: in `issue-search.json` the `200` comes from "List a Project's Issues" and the `429`
from the Rate Limits page. A file-level block would have to pick one of them, so the block sits on
the interaction, where the claim is actually true. Both shapes are accepted and
`test/contract/support/integrations/fixture-provenance.ts` says why, and why partial coverage or an
empty `interactions` list is a failure rather than a pass.

| `evidence` | what it means |
|---|---|
| `documented-adapted` | Sentry's own published example or parameter table, with values replaced by obviously fake ones (BD-002) and members the adapter never reads removed. Nothing about the *shape* is ours. |
| `composed` | The shape is documented; the **situation** is not. An issue *after* a resolution, or a response to a filtered query — no page shows one, so the document is assembled from a documented shape and the `note` says what was assembled. |
| `inferred` | The documentation does **not** state this — most often the body of an error case whose status is documented and whose body is not. The fixture is a reasoned guess, the `note` says what was assumed and what the adapter does about it, and it is never allowed to masquerade as documented. |
| `documented`, `invented` | Available in the shared vocabulary; **no file here uses them.** Nothing was transcribed with values unchanged (every example carries a real organization slug and a real permalink, both of which had to go), and adding an `invented` fixture should be argued for in review rather than done quietly. |

## The `source` blocks are checked, and here is exactly how far

`test/contract/integrations/fixture-provenance.contract.test.ts` runs the shared suite over **every**
provider directory it finds under `test/fixtures/http/` — this one included. It asserts that every
interaction in every file has a `source`, that the label is one of the five kinds, that a claim
which is not `invented` cites an `https` URL that is **not** on a domain IANA reserves for
documentation and whose host is named in *this* file, that the `retrieved` date is a real day and
not in the future, and that anything other than plain `documented` carries a `note`.

The host allow-list is scraped from this file's prose, so it is only as narrow as the prose — hence
the reserved-domain deny-list, which is scraped from nothing. It still cannot check that
`docs.sentry.io` says today what a fixture claims, that a body matches the example it cites, that a
label is honest, or that the right interaction carries the right citation. Those remain a
reviewer's job.

## Sources

All retrieved **2026-09-10**.

- `https://docs.sentry.io/api/` — the `/api/0/` path prefix, `Authorization: Bearer <auth_token>`,
  and the list of endpoint groups. **No fixture**; cited by `http.ts`.
- `https://docs.sentry.io/api/events/` — the index of the Events & Issues group. **No fixture, and
  it is the most load-bearing page in this list**: it names 21 endpoints and **none of them is a
  comment or a note**, which is why the adapter declares `capabilities().comments = false` (Q43).
- `https://docs.sentry.io/api/events/retrieve-an-issue/` —
  `GET /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/`, its full 200 example
  (including `"count": "150"` as a string beside a numeric `userCount`) and the documented 401/403/404.
- `https://docs.sentry.io/api/events/retrieve-an-issue-event/` —
  `GET …/issues/{issue_id}/events/{event_id}/` with `event_id` accepting `latest`, the full 200
  example (`entries[]` with `exception`, `breadcrumbs` and `request`, the frame members, the
  `tags` list of `{key, value}` pairs, `contexts.trace`), and the documented 400/401/403/404.
- `https://docs.sentry.io/api/events/list-a-projects-issues/` —
  `GET /api/0/projects/{org}/{project}/issues/`, the `statsPeriod` / `query` / `sort` / `limit`
  ("max 100") / `cursor` / `shortIdLookup` parameters, the default `query` of `is:unresolved`, and
  the 200 example (a bare array).
- `https://docs.sentry.io/api/events/update-an-issue/` —
  `PUT /api/0/organizations/{org}/issues/{issue_id}/`, the request parameters (`status`,
  `statusDetails`, `ignoreDuration`, `assignedTo`, `hasSeen`, `isBookmarked`, `isSubscribed`,
  `isPublic`), the documented status values including `resolvedInNextRelease`, and the scopes
  `event:admin` / `event:write`. **The page publishes no response example**; see the ambiguities
  below.
- `https://docs.sentry.io/api/organizations/retrieve-an-organization/` —
  `GET /api/0/organizations/{org}/`, its 200 example and the `org:read` scope. This is the
  read-only probe `testConnection` makes.
- `https://docs.sentry.io/api/ratelimits/` — "Sentry rate limits every API request", the
  `X-Sentry-Rate-Limit-Limit` / `-Remaining` / `-Reset` / `-ConcurrentLimit` /
  `-ConcurrentRemaining` response headers, `-Reset` being "measured in UTC seconds from epoch", and
  "the server will respond with a 429 HTTP status code … comes with a Retry-After header". No
  numbers are published, which is why the registration's budget is recorded as a choice.
- `https://docs.sentry.io/cli/` — the documented command groups of `sentry-cli`: installation,
  configuration, releases, debug information files, sending events, code mappings, logs, snapshots,
  crons. **No `issues` group.** **No fixture**; cited by the agent-tooling decision.
- `https://docs.sentry.io/cli/configuration/` — `SENTRY_AUTH_TOKEN`, `SENTRY_API_KEY`,
  `SENTRY_DSN`, `SENTRY_URL` (default `https://sentry.io/`), `SENTRY_ORG`, `SENTRY_PROJECT` and the
  rest. **No fixture**; the environment contract that *would* have been declared if the CLI could
  read an issue.
- `https://mcp.sentry.dev/` — the hosted MCP server: `https://mcp.sentry.dev/mcp`, the
  `…/mcp/{organizationSlug}/{projectSlug}` scoping, and "All connections use OAuth. The first
  connection will trigger an authentication flow to connect to your Sentry account." **No fixture**;
  this sentence is why `agentTooling()` mounts no MCP server. (`docs.sentry.io/ai/mcp/` redirects
  here, which is how it was found.)
- `https://docs.sentry.io/organization/integrations/integration-platform/webhooks/comments/` —
  the `Sentry-Hook-Resource: comment` **webhook**. **No fixture**: it is inbound, and this port has
  no inbound normaliser in v1 (product/08 lists `error.issue.created` as optional and technical/02's
  catalogue has no such event).

## What is deliberately **not** in a fixture

- **Credentials.** The binding's auth token is built at run time from an obviously fake string, so
  the repository's own secret scanner has nothing to find (BD-002). No DSN appears anywhere: a DSN
  is a write credential and this adapter never sends events.
- **Sequencing.** These files are *recorded exchanges*, not a state machine. `http-replay.ts`
  decides which recorded response answers which request, counts what was served, and fails on a
  fixture nothing exercises. The one place a write changes a later read — `resolve` then re-read —
  is expressed as a recorded interaction tagged `"variant": "resolved"` rather than as mutable
  state, so both documents stay in the corpus and both are provenance-checked.

## Ambiguities found in the documentation, and what was done about them

1. **No comment endpoint exists in the published API reference.** The Events & Issues index lists
   21 endpoints and none of them creates or lists a comment; the only comment surface Sentry
   publishes is the inbound webhook. The port has `comment()` and a `comments` capability flag, so
   the adapter declares `false` and refuses, rather than posting to an endpoint no vendor page
   names. Filed as **Q43**, with the recommendation implemented.
2. **No merge-request link endpoint either.** Sentry associates code with an issue through the
   commit/release integration (a `Fixes <SHORT-ID>` commit message) rather than through a REST call.
   `linkMergeRequest` is therefore `false` and refuses; the setup guide explains the commit-message
   convention as the supported route. Same open question.
3. **"Update an Issue" publishes no response body.** The adapter issues the `PUT` and then re-reads
   the issue rather than mapping a shape nobody documents — which also makes a second `resolve`
   idempotent without a special case. The recorded `PUT` body is `inferred` and never read.
4. **`statusDetails.inRelease` is not spelled out.** The page documents the `statusDetails`
   parameter ("Additional resolution details") and the `resolvedInNextRelease` status value, but not
   the key inside `statusDetails` that names a specific release. The adapter sends
   `{"status": "resolved", "statusDetails": {"inRelease": "<version>"}}`; the *request* is the
   inferred part, and the recorded response is the documented issue shape.
5. **`count` is a string and `userCount` is a number**, in the same published example. Both forms
   are accepted and normalised, and a value that is neither becomes `0` rather than `NaN`.
6. **No absolute time window on the project-issues endpoint.** `statsPeriod` selects the stats
   block; it does not filter. The port's `searchIssues({since})` is therefore applied on the client,
   which is recorded in the adapter's divergence register.
