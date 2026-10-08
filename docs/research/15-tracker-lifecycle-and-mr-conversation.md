# 15 — Tracker statuses, ticket claim and merge-request conversation: what the vendors document

Written 2026-10-08 by the architect's M10-head pass (session 15) for BD-031 and TD-029. Only public
vendor documentation was read. No Jira or GitLab instance was called by this pass; the live
observations of one Jira site and one GitLab merge request are the product owner's, recorded in
`technical/PROGRESS.md` backlog 535 and 537, and are cited from there rather than repeated.

Atlassian's reference pages render client-side and arrive truncated through a plain fetch, so the
Jira half was read from the published OpenAPI documents:
<https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json> (REST v3) and
<https://developer.atlassian.com/cloud/jira/platform/swagger.v3.json> (REST v2). The platform's Jira
client addresses `/rest/api/3/*` (`packages/integrations/src/providers/jira-cloud/client.ts:5`). Every
path below exists in both versions with the same parameters; the one difference that matters is that a
comment `body` is Atlassian Document Format in v3 and a plain string in v2.

## Jira Cloud

| # | What | Endpoint | Documented shape (short quotes) | Grade |
|---|---|---|---|---|
| J1 | A project's statuses | `GET /rest/api/3/project/{projectIdOrKey}/statuses` | *"Returns the valid statuses for a project … grouped by issue type"*: an array of `{id, name, self, statuses[], subtask}`; each status has `id, name, description, iconUrl, scope, statusCategory`, and a category is `{id, key, name, colorName}`. Permission: *Browse Projects*. | verified |
| J1a | The category keys | same | `key` is typed only as a string. No enum is documented, the word `indeterminate` appears nowhere in the specification, and this endpoint's own example omits `statusCategory`. The product owner's live read of one project (backlog 535) returned the three categories `new`, `indeterminate` and `done`. | verified (doc) + observed (535); the full key set is **[unverified]** |
| J2 | The newer statuses search | `GET /rest/api/3/statuses/search` | `projectId`, `statusCategory` (`TODO`, `IN_PROGRESS`, `DONE`), paginated `values[]`. Requires *Administer projects* or *Administer Jira*, so it is **not** usable by an ordinary service account. | verified — rejected for that reason |
| J3 | A ticket's available transitions | `GET /rest/api/3/issue/{issueIdOrKey}/transitions` | each transition has `id, name, to` (a status with `statusCategory`), `hasScreen, isAvailable, isConditional, isGlobal, isInitial, looped, fields`; `expand=transitions.fields`; `includeUnavailableTransitions` (default false). Without *Transition issues* the response *"will not list any transitions"*. The documented example carries `"statusCategory":{"key":"in-flight",…}`, a fourth spelling. | verified |
| J4 | Assign | `PUT /rest/api/3/issue/{issueIdOrKey}/assignee` | body `{"accountId": "…"}`; `null` *"set to unassigned"*; `"-1"` *"assigned to the default assignee for the project"*; 204 on success, 400 for an unknown user or a missing `accountId`, also 403 and 404. Permission: *Browse Projects* and *Assign Issues*. | verified |
| J5 | Comments | `GET /rest/api/3/issue/{issueIdOrKey}/comment` | `startAt` (default 0), `maxResults` (default 100), `orderBy` one of `created`, `-created`, `+created` (400 otherwise); `{startAt, maxResults, total, comments[]}`; a comment has `id, author (accountId …), body` (ADF), `created, updated`. The specification describes `total` as *"The number of items returned"*, which contradicts its name. | verified; `total`'s meaning **[unverified]** |
| J6 | The binding's own account | `GET /rest/api/3/myself` | *"Returns details for the current user"*, example starts `{"accountId": …}`. The adapter already reads it (`jira-cloud/index.ts:549-561` since WP-172; `520-529` when written). | verified |
| J7 | Webhooks | <https://developer.atlassian.com/cloud/jira/platform/webhooks/> | `jira:issue_updated`; `comment_created`, `comment_updated`, `comment_deleted`; changelog items carry `field, fieldtype, from, fromString, to, toString`, *"one entry for each field that has been changed"*. | verified |

Consequences for the design (TD-029):

- The status read is J1, unioned over issue types by name, never J2.
- The category is normalised to `todo | in_progress | done | unknown` from `new`, any other
  non-`done` key the vendor documents or the product owner observed (`indeterminate`, `in-flight`),
  and `done`. An unrecognised key is `unknown` and keeps its raw value, so a fourth spelling is
  visible rather than silently mapped.
- A transition is resolved by its **target status** (`to.name`), never by its own name. The adapter
  already does this (`resolveTransition`, `packages/integrations/src/providers/jira-cloud/index.ts:1745-1754` since WP-172; `1444-1453` when written).
  Backlog 535 asked for exactly this check, because the product owner's tracker names transitions
  with emoji and differently from their target statuses.

## GitLab

| # | What | Endpoint | Documented shape (short quotes) | Grade |
|---|---|---|---|---|
| G1 | A merge request's discussions | `GET /projects/:id/merge_requests/:merge_request_iid/discussions` (<https://docs.gitlab.com/api/discussions/>) | `individual_note`: *"If true, an individual note or part of a discussion"*. In the merge-request example, a single comment (`"type": null`) is its own discussion with `"individual_note": true`. A note carries `type` (`DiscussionNote`, `DiffNote` or `null`), `system`, `resolvable`, `resolved`, `resolved_by` and `position`. | verified |
| G2 | Whether a general note is resolvable | G1 and <https://docs.gitlab.com/api/notes/> | The notes page's merge-request example shows `"resolvable": false`, and the discussions page's single comment shows `"resolvable": true`. The documentation contradicts itself. The product owner's live read of one merge request (backlog 535 and 537) found the human review as two general notes with `resolvable: false`. | **contradictory** — the design must not depend on it |
| G3 | A new thread, optionally on a diff line | `POST …/discussions` | `body` is required. If `position` is given, `base_sha`, `head_sha`, `start_sha` and `position_type` (`text`, `image` or `file`) are required, `new_path`/`old_path` are required for `text`, and `new_line`/`old_line` are optional. | verified (the adapter already does this, `gitlab/provider.ts:1077-1115`) |
| G4 | A reply | `POST …/discussions/:discussion_id/notes` | `body` is required. | verified; whether it accepts an `individual_note` discussion's id is **[unverified]** |
| G5 | Resolve | `PUT …/discussions/:discussion_id` with `resolved=true` | it needs Developer or higher, *"or be the author of the change being reviewed"*. | verified |
| G6 | A general note | `POST …/merge_requests/:iid/notes` | `body` (up to 1,000,000 characters); merge-request notes *"are not attached to specific lines"*. | verified |
| G7 | The comment webhook | <https://docs.gitlab.com/user/project/integrations/webhook_events/> ("Comment events", `Note Hook`) | `object_attributes` are `id, internal, note, noteable_type, author_id, created_at, updated_at, project_id, attachment, line_code, commit_id, noteable_id, system, st_diff, action, url`. There is **no** `type`, `position`, `resolvable`, `resolved` or `discussion_id`, which matches `webhook-payloads.ts:13-15`. | verified (documentation only) |

Consequences for the design (TD-029):

- Because of G2, whether a human note returns a task is **never** decided by `resolvable`. A
  general note, a diff thread and a reply all count, by author and marker (TD-029 decision 6).
- Whether G4 accepts an individual note's discussion id is **not measured**. WP-173's fixture
  (`test/fixtures/http/gitlab/general-notes.json`) records only the documented `201`, and the live
  check is still open in `docs/TODO.md`. The GitLab adapter therefore tries G4 first and, on a `400`
  or `404` for an individual note, posts a new general note that names the note it answers and
  returns that note's discussion, whose id differs (divergence 8 in the adapter's docblock).
