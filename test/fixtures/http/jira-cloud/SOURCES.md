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
