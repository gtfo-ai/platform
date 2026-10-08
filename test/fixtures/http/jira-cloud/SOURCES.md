# Jira Cloud HTTP fixtures — where each one comes from

WP-08 was implemented **without access to a Jira site**. Nothing here was recorded from a live
call, and pretending otherwise is exactly how a provider adapter passes its own tests and fails in
production. Every document is therefore derived from an Atlassian *published* source, and each file
carries a `source` block naming that source, the date it was retrieved and how far the file sits
from it.

| `evidence` | what it means |
|---|---|
| `documented` | Atlassian's own published example, with values replaced by obviously fake ones (BD-002) and members the adapter never reads removed. Nothing about the shape is ours. |
| `documented-adapted` | The **shape** is Atlassian's published example; the **content** is this repository's scenario (the workflow of product/19 §6, the ticket the contract suite reads). A field that is present is a field Atlassian's example has. |
| `composed` | Atlassian documents each part but publishes no complete example of this combination — the webhook envelope plus a comment, for instance. The file is the documented parts assembled, and the `note` says which sentence licenses each part. |
| `inferred` | The shape is Atlassian's, but that **this** endpoint answers it is a reasoned guess the `note` states — WP-110's `error-issue-key-does-not-exist.json`, a Data Center knowledge-base answer assumed of Cloud's `search/jql`. |
| `invented` | Nothing in the documentation states this shape. **There are no such files**, and adding one should be argued for in review rather than done quietly. |

## The `source` blocks are checked, and here is exactly how far

`test/contract/integrations/fixture-provenance.contract.test.ts` runs the shared suite in
`test/contract/support/integrations/fixture-provenance.ts` over **every** provider directory it
finds under `test/fixtures/http/` — this one included, and WP-09…WP-11's when they land. It asserts
that each file has a `source`, that the label is one of the four above (plus WP-09's `inferred`),
that anything claiming a documented origin carries a real `retrieved` date and cites an `https` URL
which is **not** on a domain IANA reserves for documentation (`.invalid`, `.example`, `.test`,
`example.com` …) and whose host is named in *this* file, and that every label other than
`documented` carries a `note`.

The allow-list is scraped from this file's prose, so it is only as narrow as the prose: the first
draft of the suite allowed `example.invalid` because the paragraph you are reading names it, and
the reviewer's own mutation survived. Hence the reserved-domain rule, which is not scraped from
anything.

It still cannot check that the vendor's page says what a fixture claims, that the body matches the
example it cites, or that a label is honest — relabelling `composed` as `documented` keeps a valid
URL and a valid date. Those remain a reviewer's job; the suite exists because before it, rewriting
a label and pointing the URL at a domain that does not exist changed no test at all.

## Sources

- `https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json` — the OpenAPI 3.0.1
  document for the Jira Cloud platform REST API v3, `info.version`
  `1001.0.0-SNAPSHOT-a6463b4310f8edea4a3e…`, retrieved 2026-09-10. Request and response examples
  come from the `example` member of each operation.
- `https://developer.atlassian.com/cloud/jira/platform/webhooks/` — event names, delivery headers,
  the `X-Hub-Signature` scheme and its published test vector, the retry policy, and the one
  complete `jira:issue_updated` payload example. Retrieved 2026-09-10.
- `https://developer.atlassian.com/cloud/jira/platform/rate-limiting/` — `429`, `Retry-After`,
  `X-RateLimit-*`, `RateLimit-Reason`, and "some transient 5xx responses may include a
  `Retry-After` header". Retrieved 2026-09-10.
- `https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/` — the
  `Authorization: Basic base64(email:api_token)` header. Retrieved 2026-09-10.
- `https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/` — ADF: the root
  `doc` node, the block/inline/mark vocabulary, and "the simplest document … with no content".
  Retrieved 2026-09-10.
- `https://support.atlassian.com/jira-software-cloud/docs/jql-fields/` — the JQL fields the polling
  fallback uses (`labels`, `status`, `parent`, `updated`), their operators, and the warning that an
  absolute date literal is read "relative to your configured time zone". Retrieved 2026-09-10.

- `https://support.atlassian.com/jira/kb/how-to-handle-http-400-bad-request-errors-on-jira-search-rest-api-endpoint/`
  — retrieved 2026-10-01 (WP-110 review round 1): search answers **400** when JQL names an issue key
  that does not exist, with *"An issue with key '…' does not exist for field 'key'."* in
  `errorMessages`. The article is scoped to Jira Data Center/Server and `/rest/api/2/search`; the
  Cloud swagger's `search/jql` documents a 400 without naming this case, so
  `error-issue-key-does-not-exist.json` is labelled `inferred`. The adapter drops the keys such an
  error names and asks again; since WP-134 (backlog 375) it also reads Jira's other JQL wording
  (*"The value '…' does not exist for the field 'key'."*) and **bisects** a refusal that names no key,
  within `MAX_KEY_SEARCHES`. The replay answers the documented sentence for a `key in (…)` naming a
  key it does not hold, or — when a test asks (`refuseUnknownKeysWith`, its divergence 9) — the other
  wording or an opaque message, because Cloud's wording is not measured.
- `https://support.atlassian.com/jira/kb/moved-issues-no-longer-redirect-from-previous-issue-key-or-url-in-jira/`
  — retrieved 2026-10-03 (WP-134, backlog 418): a moved issue's previous keys and URLs *"are
  automatically redirected to the current key or URL"*, and the article's query joins every former
  key to the issue's own id (`moved_issue_key.issue_id = jiraissue.id`) — which is what the adapter
  relies on when it carries the issue's `id` as `TicketRef.id`. No fixture: the webhook and issue
  documents above already carry `id` beside `key`, and the replay's `moveIssue` (divergence 10)
  answers an old key under the new one.
- `https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-fields-reference-939938743.html`
  — retrieved 2026-10-04 (WP-145, backlog 437): the JQL fields reference's *Issue key* section —
  *"Allows searching for issues using their unique identifier or ID number"*, syntax `issueKey`,
  aliases `id`, `issue`, `key`, operators including `IN`. The Data Center page, because the Cloud
  page above renders client-side and its text could not be read; that Cloud's `search/jql` accepts
  `id in (…)` is **inferred**. `search-jql-by-id-after-move.json` is that read after a move — the
  issue's id answering it under its new key, inferred from this page and the moved-issues article
  above — and the adapter asks a live task's ticket by the id the task recorded rather than by its
  key. The replay answers `id in (…)` from its state (divergence 11).
- `https://jira.atlassian.com/browse/JRASERVER-30245` — retrieved 2026-10-04 (WP-145): *"Have JIRA
  Search Function Return Results When Searching Legacy Issue Keys"* (2012, Server, closed as a
  duplicate of JRASERVER-30678, no fix version) reports that a JQL query naming a moved issue's
  former key *"breaks instead of returning the updated result"*. Whether today's Cloud resolves a
  former key in JQL is **not measured** and nothing here relies on it: that is why the poll asks by
  id, and why the replay refuses an old key in `key in (…)` (divergence 10). No fixture.

- `https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json` again, `info.version`
  `1001.0.0-SNAPSHOT-25c77f084cd5b3af3ca57b4c883ff311ffe3ca25`, retrieved **2026-10-08** for WP-172
  (the ticket lifecycle; `docs/research/15-tracker-lifecycle-and-mr-conversation.md` J1–J6):
  - **J1** `getAllStatuses`, `GET /rest/api/3/project/{projectIdOrKey}/statuses` — *"Returns the
    valid statuses for a project. The statuses are grouped by issue type"*; permission *Browse
    Projects*; `200` an array of `IssueTypeWithStatus`, `404` for a project the account cannot see.
    The example omits `statusCategory`, which `StatusDetails` documents. →
    `project-statuses-acme.json` (`documented-adapted`). **J2** (`statuses/search`) is not used: it
    requires project administration.
  - **J3** `getTransitions` — the example's two target categories, `in-flight` and `completed`. →
    `transitions-category-keys.json` (`documented-adapted`).
  - **J4** `assignIssue`, `PUT /rest/api/3/issue/{issueIdOrKey}/assignee` — body `{"accountId": …}`,
    `null` *"the issue is set to unassigned"*; permission *Browse Projects* and *Assign Issues*;
    `204` with no body, `400` (user not found, `accountId` missing), `403` (*"the user does not have
    the necessary permission"*, no example body), `404`. No fixture: a `204` has no document, and the
    replay answers the write from its state (it refuses an account its directory does not hold with
    `400`, as documented). The `403` is scripted inline in
    `packages/integrations/src/providers/jira-cloud/lifecycle.test.ts`, as the `ErrorCollection`
    every 4xx carries, in words of this repository's own.
  - **J5** `getComments` with `orderBy=-created` — the envelope `comments-acme-1.json` already
    records; `total` is not read by `listComments` (ambiguity 6 below).
  - **J6** `getCurrentUser` — `myself.json`, unchanged.

## What is deliberately **not** in a fixture

- **Signatures.** A webhook fixture carries the delivery headers Atlassian documents but no
  `X-Hub-Signature`: the harness computes it over the exact bytes it sends. A literal here would be
  a signature over a body nobody could reproduce, and it would go stale the first time a field
  moved. The one signature this repository asserts as a constant is Atlassian's own published test
  vector, in `packages/integrations/src/providers/jira-cloud/webhook.test.ts`.
- **Sequencing.** These files are *documents*, not a recorded conversation. The stateful double in
  `test/contract/support/integrations/jira-cloud-replay.ts` decides which document answers which
  request, and keeps the issue's own state, because the contract suite transitions a ticket and
  reads it back. Its divergence register says exactly where that double is not Jira.

## Ambiguities found in the documentation, and what was done about them

1. **`GET issue` shows `fields.comment` as an array.** The published `getIssue` example has
   `"comment": [ … ]`, while `getComments` returns `{comments, startAt, maxResults, total}`. The
   adapter never reads the issue's embedded comment field: it calls
   `GET /rest/api/3/issue/{key}/comment`, whose envelope is unambiguous.
2. **The webhooks page spells the actor's account id `accoundId`.** Every user shape in the REST API
   spells it `accountId`, so that is a typo in the documentation. The schema reads `accountId`; a
   delivery with only `accoundId` therefore has no actor identity, and the fixture records the
   decision rather than hiding it.
3. **No complete `comment_created` example is published.** See `composed` above.
4. **`GET issue/{key}/comment?expand=` accepts only `renderedBody`.** Comment *properties* — the
   invisible way to mark a comment — are returned by `POST /rest/api/3/comment/list?expand=properties`
   and by nothing else, so reading a marker back would cost a second request per ticket read. The
   marker is visible text in the comment body instead; `adf.ts` says why, and `upsertWorkpad`
   compensates by requiring the comment's author to be this binding's own account.
5. **`GET issue/{key}/comment`'s `orderBy` is documented as a three-value enum** — `created`,
   `-created`, `+created` — in the OpenAPI description
   (https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json, retrieved 2026-09-28),
   while the rendered page's prose says only *"Accepts `created`"*. `readTicket` asks for
   `-created` with `maxResults=50` since WP-83 (the newest page, cut to its size), and the replay
   honours both parameters; no fixture changed, because the envelope is the same document.
6. **`PageOfComments.total` is described as *"The number of items returned"*** in the OpenAPI
   description (https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json, `info.version`
   `1001.0.0-SNAPSHOT-d8285b35…`, re-read 2026-10-01 for WP-111), which read literally is the page's
   length, while Atlassian's own response example (`comments-acme-1.json`) and WP-83's reading treat
   it as the thread's size. The same document gives `startAt` (default 0, *"the page offset"*) and
   `maxResults` (default 100) and **no maximum** for the request, and describes the response's
   `maxResults` as *"the maximum number of items that could be returned"*. The marker search
   (WP-111, backlog 288) therefore depends on **neither** reading: it pages by `startAt`, steps by
   what a page actually returned, and stops **only on an empty page**; `total` is read only there,
   to **fail** rather than answer "not found" when a usable `total` claims more comments than were
   read. WP-111's first version stopped at `startAt + returned >= total`, and under the first
   reading that ended every search after one page and posted a second workpad (review round 1,
   backlog 377 — reproduced against the replay with `total` rewritten to the page's length). The
   reading is still not measured, because there is no Jira site. The replay honours `startAt` and
   caps a page at fifty (its divergence 8); no fixture changed, because the envelope is the same
   document.
