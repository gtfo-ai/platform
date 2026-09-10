# GitLab HTTP fixtures — where each one comes from

WP-09 was implemented **without access to a GitLab instance**. Nothing here was recorded from a
live call, and pretending otherwise is exactly how a provider adapter passes its own tests and
fails in production. Every document is derived from GitLab's *published* documentation, and every
recorded interaction carries a `source` block naming that page, the date it was retrieved and how
far the interaction sits from it.

## The provenance lives on the interaction, not on the file

Each file here is one recorded **conversation** — `{"interactions": [...]}`, replayed by
`test/contract/support/integrations/gitlab-replay.ts` — and a single conversation legitimately
cites several pages: in `merge-requests.json` the `201` comes from the merge-requests page and the
`409` from the REST troubleshooting status table. A file-level block would have to pick one of
them, so the block sits on the interaction, where the claim is actually true. WP-08's Jira corpus
is one document per file and carries its block per file; both shapes are accepted, and
`test/contract/support/integrations/fixture-provenance.ts` says why, and why partial coverage or an
empty `interactions` list is a failure rather than a pass.

| `kind` | what it means |
|---|---|
| `documented` | GitLab's own published example or attribute table, with values replaced by obviously fake ones (BD-002) and members the adapter never reads removed. Nothing about the shape is ours. |
| `inferred` | The documentation does **not** state this — most often the status code of an error case the endpoint's page does not publish. The fixture is a reasoned guess, the `note` says what was assumed and what the adapter does about it, and it is never allowed to masquerade as `documented`. |
| `documented-adapted`, `composed`, `invented` | Available in the shared vocabulary; **no file here uses them**. Adding an `invented` fixture should be argued for in review rather than done quietly. |

## The `source` blocks are checked, and here is exactly how far

`test/contract/integrations/fixture-provenance.contract.test.ts` runs the shared suite over
**every** provider directory it finds under `test/fixtures/http/` — this one included. It asserts
that every interaction in every file has a `source`, that the label is one of the five kinds, that
a claim which is not `invented` cites an `https` URL which is **not** on a domain IANA reserves for
documentation (`.invalid`, `.example`, `.test`, `example.com` …) and whose host is named in *this*
file, that the `retrieved` date is a real day and not in the future, and that anything other than
plain `documented` carries a `note`.

The host allow-list is scraped from this file's prose, so it is only as narrow as the prose — hence
the reserved-domain deny-list, which is scraped from nothing. It still cannot check that
`docs.gitlab.com` says today what a fixture claims, that a body matches the example it cites, that
a label is honest, or that the right interaction carries the right citation. Those remain a
reviewer's job.

## Sources

All retrieved **2026-09-10**.

- `https://docs.gitlab.com/api/version/` — `GET /version`, the `version`/`revision`/`enterprise`
  response used to detect the instance version.
- `https://docs.gitlab.com/api/projects/` — the project object: `id`, `path_with_namespace`,
  `default_branch`, `web_url`, the repository URLs.
- `https://docs.gitlab.com/api/branches/` — the branch object and its `commit` block, including
  `protected`, which is the guard the pipeline actually reads.
- `https://docs.gitlab.com/api/protected_branches/` — the protected-branch object. The page states
  the `200` but not the status for a branch with no protection rule; that case is `inferred`.
- `https://docs.gitlab.com/api/merge_requests/` — "Create a merge request", "Retrieve a merge
  request", "Update a merge request" and "List project merge requests" examples, the `state`,
  `updated_after`, `order_by` and `sort` attributes, and the `merge_status` /
  `detailed_merge_status` / `has_conflicts` table, including "the mergeability … is checked
  asynchronously … Poll this API endpoint".
- `https://docs.gitlab.com/api/discussions/` — "List all merge request discussion items", "Create a
  merge request thread" (with the text-diff `position` form), "Add note to a merge request thread",
  "Retrieve a merge request discussion item" and "Resolve a merge request thread".
- `https://docs.gitlab.com/api/pipelines/` — "List project pipelines" with `sha`, `order_by` and
  `sort`, and "Retrieve a single pipeline". The empty-list case for a commit with no pipeline is
  `inferred`; so is the type of a non-null `coverage`, which every published example shows as
  `null`.
- `https://docs.gitlab.com/api/jobs/` — "List pipeline jobs" and "Retrieve a job log file", both
  the `200` that serves the log and the documented "404: Job not found or no log file".
- `https://docs.gitlab.com/api/repository_files/` — the raw-file endpoint the CODEOWNERS read uses.
  The page does not state the status for a missing file, so both `404`s here are `inferred` from
  the REST status table.
- `https://docs.gitlab.com/user/project/codeowners/reference/` — the CODEOWNERS syntax the fixture
  body is assembled from: default owner, multiple owners, an inline comment, an email owner, a
  section with default owners, an optional section with an approval count, and a role owner.
- `https://docs.gitlab.com/api/project_access_tokens/` — "Create a project access token", "Revoke a
  project access token" ("returns 204 No content"), and "404: Not Found if the access token does
  not exist".
- `https://docs.gitlab.com/api/rest/troubleshooting/` — the REST status table: "404 Not Found — A
  resource could not be accessed", "409 Conflict — A conflicting resource already exists".
- `https://docs.gitlab.com/user/project/integrations/webhook_events/` — the Merge Request, Note and
  Pipeline hook payloads, and the `X-Gitlab-Event` header. **No fixture file here**: the deliveries
  are built and signed in `test/contract/support/integrations/gitlab-fixtures.ts`, see below.
- `https://docs.gitlab.com/user/project/integrations/webhooks/` — webhook delivery, the legacy
  `X-Gitlab-Token` secret, and the Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`) the verifier implements; transcribed in `webhook-verify.ts`.
- `https://docs.gitlab.com/api/rest/` — the namespaced `/api/v4` paths and the `PRIVATE-TOKEN`
  header; cited by `http.ts` and behind every path in these files.
- `https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/` — the rate-limit
  response headers the HTTP client reads on a `429`.

## What is deliberately **not** in a fixture

- **Signatures.** A webhook delivery is built by `gitlab-fixtures.ts` and signed by the harness over
  the exact bytes it sends. A literal signature here would be a signature over a body nobody could
  reproduce, and it would go stale the first time a field moved. The signing tokens are built at run
  time from obviously fake strings so that the repository's own secret scanner has nothing to find
  (BD-002).
- **Credentials.** The minted project access token in `access-tokens.json` is shaped like nothing
  GitLab issues, for the same reason.
- **Sequencing.** These files are *recorded exchanges*, not a state machine. `gitlab-replay.ts`
  decides which recorded response answers which request, counts what was served, and fails on a
  fixture nothing exercises; its divergence register says where the double is not GitLab.

## Ambiguities found in the documentation, and what was done about them

1. **No published body for a duplicate source branch (`409`).** The status is documented in the
   REST table; the message string in `merge-requests.json` is illustrative, only the status is
   load-bearing, and the adapter never reads that body.
2. **`coverage` is `null` in every published pipeline example.** The type of a present value is
   never stated, so the fixture uses the string form and the schema accepts a number or a numeric
   string.
3. **A second resolve of an already resolved thread is not documented.** The same `200` is assumed
   and the fixture repeats it.
4. **GitLab publishes `user_notes_count` (notes) and no thread count.** The adapter counts
   non-system threads from the discussions endpoint instead.
