# GitLab — setup guide

Applies to **gitlab.com** and to a **self-managed** instance. Everything below is from GitLab's
published documentation; the version each feature needs is stated, because a self-managed instance
is usually behind gitlab.com.

## 1. Decide which token the binding uses

The binding needs **one API token** for reads and writes (merge requests, discussions, pipelines,
job logs, repository files). GitLab accepts it in the `PRIVATE-TOKEN` header.

| Token kind | Can the binding mint workspace credentials with it? | Notes |
|---|---|---|
| Personal access token of a bot user | **Yes** | The only kind that can create project access tokens: *"You must use a personal access token with this endpoint. You cannot authenticate with a project access token."* |
| Project or group access token | No | Everything else works; leave `mint_credentials` off — and no stage that writes can run. |

Scopes: `api` (the platform reads and writes merge requests, discussions and notes). The same
token is also sent to GitLab's **GraphQL** endpoint, `/api/graphql`, for one read — a merge
request's diff stats, which the REST API does not publish — and `api` covers it (GitLab documents
`read_api` or `api` for GraphQL queries). Since WP-59 the platform also **closes** a merge request
it opened when a person asks for a task to be reworked, which the same scope allows.

The platform **does not follow redirects** (since WP-59): if `base_url` answers with one — an
`http://` URL redirected to `https://`, a moved instance — every call fails naming the method and
the path. Configure the URL the redirect points at.
The token's user needs at least the **Maintainer** role on the project to create project access
tokens, and **Developer** for everything else.

> Create a bot user rather than using a person's account. Its name appears on every comment the
> platform leaves, and revoking a person's token later should not take the platform down with it.

## 2. Configure the binding

| Field | Required | What it is |
|---|---|---|
| `base_url` | yes | Instance root — `https://gitlab.com`, or `https://code.example.test/gitlab`. **Not** the `/api/v4` path, and no trailing slash. |
| `project` | recommended | `namespace/project` (GitLab's `path_with_namespace`). Deliveries about any other project are rejected as `not_for_this_project`. |
| `token` | yes | Secret. The API token from step 1. |
| `webhook_secret_token` | see step 3 | Secret. Legacy `X-Gitlab-Token` value. |
| `webhook_signing_token` | see step 3 | Secret. `whsec_…` signing token (GitLab 19.0+). |
| `webhook_tolerance_seconds` | no (300) | How old a signed delivery may be before it is treated as a replay. |
| `mint_credentials` | no (off) | Whether the platform may mint short-lived project access tokens. **Required for any stage that writes**, and for a private repository. See step 5. |
| `read_access_level` / `push_access_level` | no (20 / 30) | Role given to a minted credential: 20 Reporter, 30 Developer, 40 Maintainer. |
| `poll_enabled` | no (off) | Poll GitLab for this project's merge requests instead of (or beside) the webhook — step 3a. Needs `project`. |
| `poll_interval_seconds` | no (60) | Seconds between two polls of this binding; 30 to 86400. |
| `token_prefix` | no (`glpat-`) | The prefix your instance puts on every token. Change it only if an administrator changed the **Personal access token prefix** (Admin → Settings → General → Account and limit); project access tokens inherit it. See step 5. |

Environment names for the bundled `glab` CLI follow TD-020: `GITLAB_HOST`, `GITLAB_TOKEN`.

## 3. Create the webhook

**Settings → Webhooks → Add new webhook**, URL `<APP_BASE_URL>/webhooks/gitlab/<integrationId>` — the
exact URL is shown above this guide on the integrations screen, with a Copy button (the API
publishes it as the `webhook_url` field of `GET /api/integrations/<integrationId>/setup-guide`).

Triggers to enable:

- **Merge request events** → `mr.opened`, `mr.updated`, `mr.merged`, `mr.closed`, and `mr.approved`
  when a person adds their approval (the `approval` action; a merge request becoming *fully*
  approved, and an approval being withdrawn, are ignored by name). An approval counts as review
  time for the approver; `mr.approved` carries GitLab's own instant only from GitLab 18.10, which
  is when it started sending `actioned_at`. A push to the agent branch that the platform did not
  make — yours, after a take-over — moves the revision the platform records for the task (forward
  only, by the delivery's `updated_at`), so the next conflict check between tasks reads your commit.
  The CI gate asks GitLab for the merge request's current head each time instead, and a finished
  pipeline settles it only when it ran on that head — so deliveries arriving out of order cannot pass
  it on an older commit's pipeline.
- **Comments** (Note events) → `mr.review.comment`
- **Pipeline events** → `ci.pipeline.finished`
- **Push events** → `default_branch.moved` (only a push onto the default branch produces an event)

Authentication — pick per your version:

- **GitLab 19.0 and later: use a signing token.** *"Signing token (recommended): Select Generate
  signing token. Copy and save the token now because it is displayed only once."* It starts with
  `whsec_`. Paste it into `webhook_signing_token`. GitLab then signs each delivery per the
  [Standard Webhooks](https://www.standardwebhooks.com/) specification, and the platform verifies
  the HMAC over `{webhook-id}.{webhook-timestamp}.{body}` in constant time and rejects a delivery
  whose timestamp is older than `webhook_tolerance_seconds`.
- **Before GitLab 19.0: use a secret token.** It is *"sent as plain text in the `X-Gitlab-Token`
  HTTP header and provides weaker security guarantees than a signing token"* — it authenticates the
  sender but says nothing about whether the body was modified in transit. Paste it into
  `webhook_secret_token`.
- **Migrating:** configure both. GitLab's documented rule is *"verify the signature when
  `webhook-signature` is present and fall back to the secret token otherwise"*, which is exactly
  what the platform does. Remove the secret token once every delivery is signed.

Leave **Enable SSL verification** on.

> With neither token configured the platform rejects every delivery. That is deliberate: an
> endpoint that accepts unverified webhooks looks exactly like one that works.

The webhook is the **recommended** way in, and the only way for some events: an approval and a
finished pipeline reach the platform only as deliveries. If GitLab cannot reach the instance at
`APP_BASE_URL`, switch polling on (step 3a) — and know what you give up.

## 3a. Poll merge requests when GitLab cannot reach you

**Polling** (`poll_enabled: true`, WP-110) asks GitLab every `poll_interval_seconds` for this
project's merge requests updated since the last poll — *List project merge requests* with
`updated_after`, `order_by=updated_at` and `sort=asc`, every state. Each merge request it finds is
turned into what a webhook would have said: `mr.opened` for a new one (or a reopened one),
`mr.updated` with GitLab's own `updated_at` for an open one, `mr.merged` and `mr.closed` when it
merged or closed. So review-only mode starts from a poll, and a task waiting for its merge request
learns that it merged.

You can have both. A merge the webhook reported and a poll lists again is **one** merge: the platform
appends a merge request's open, merge or close only when its log does not already say so, whichever
of the two saw it first.

**A poll-only binding also reads the default branch and the review comments** (WP-123). A binding
with **neither** `webhook_secret_token` nor `webhook_signing_token` set receives no delivery at all
(every one is refused, above), so it is **poll-only**, and each of its polls makes two more reads:

- **The default branch's head** (the project's default branch, then that branch's commit — two
  requests per poll), compared with the head the last poll saw. When it moved, the platform records
  `default_branch.moved` — so a task waiting at Ready re-enters the rebase gate and is re-checked
  for conflicts, exactly as a Push hook would make it. The first poll only learns the head; it
  records no move.
- **The comments on each merge request waiting at Ready** (*List all merge request discussion
  items*), at most **twenty** merge requests per poll, the ones that reached Ready first. A comment a
  person wrote after the task reached Ready is recorded as `mr.review.comment`, once, so a
  reviewer's comment returns the task to Implementation after the usual two-minute window. GitLab's
  own system notes (*"added 1 commit"*) and the platform's own notes (its conflict warning) are not
  review comments and are skipped. The comparison is between GitLab's clock and the platform's, so
  a comment written up to five minutes **before** the task reached Ready is read too, and a GitLab
  clock up to five minutes slow loses no comment.

A binding **with** a webhook secret makes neither read: its webhook already brings both events, and
one door per binding means nothing can arrive twice. So configure either a webhook secret **or**
nothing — a secret set for a webhook GitLab cannot reach turns both reads off.

What polling does not see, so you can choose knowingly:

- **Approvals and finished pipelines.** A list of merge requests says what each one *is*, not what
  happened inside it, so these stay webhook-only. The CI gate does not need the pipeline event (it
  asks GitLab for the head's pipeline itself). An approval counts toward the approver's review time
  and changes nothing else, so a poll-only binding undercounts that metric. A comment read by a poll
  is dated by the poll that read it, up to one interval after it was written.
- **Merge requests that changed before you switched it on.** The first poll reads the last interval
  only. A merge request opened last month and edited today is an update, not a new one, so it does
  not start a review.
- **A merge request opened and closed between two polls** is seen closed, never open.
- **More than a thousand merge requests updated within a few minutes.** A poll reads up to a
  thousand at once; past that it cannot move on, and says so in the server log on every poll
  (*"the merge-request poll is stalled"*).

## 4. Protect the default branch

**Settings → Repository → Protected branches**, protect `main` (or your default) with
**Allowed to push and merge: No one**.

This is a prerequisite, not a suggestion. A GitLab access token carries scopes and a role but
**no branch scoping**, so the platform's `push:agentic/*` constraint is enforced by the credential
helper and by *your* protected-branch rules, not by the token. The platform checks the branch's
`protected` flag and will report a project whose default branch is unprotected.

Add `agentic/*` as a protected branch only if you want to restrict who may delete those branches;
the platform does not need it.

## 5. Let the platform mint short-lived credentials (needed for any stage that writes)

With `mint_credentials` on, each agent run with a checkout gets its own project access token
(`POST /projects/:id/access_tokens`): `read_repository` for a read-only stage, `read_repository` +
`write_repository` for a stage that writes, revoked when the run ends. **Without it, a stage that
writes — implementation, conflict resolution, the librarian — is refused before its workspace is
created**, naming this setting; read-only stages still run, but only against a repository GitLab
serves without authentication.

Prerequisites:

- the binding token is a **personal** access token (step 1);
- its user has the **Maintainer** or **Owner** role on the project;
- on **gitlab.com**, the project is on **Premium or Ultimate** — *"On GitLab.com, project access
  tokens require a Premium or Ultimate subscription."* Self-managed instances have them on every
  tier.

Two things to know before you turn it on:

- **GitLab grants whole days.** `expires_at` is a date and *"Personal, group, and project access
  tokens expire at midnight UTC on the expiry date"*, so a credential asked for with a one-hour
  lifetime lives until the next midnight UTC at the earliest. The platform reports the instant
  GitLab will actually enforce, never the shorter one it asked for.
- **A bot user is created per token**, named `project_<id>_bot_<random>`. Its contributions show up
  as that user.
- **The token prefix must match your instance.** Every process of the platform redacts a minted
  token by its recorded *shape* — `token_prefix`, then GitLab's random part, at the token's length —
  so a run that prints its token into a CI log or a merge-request comment is redacted everywhere,
  not only in the process that minted it. An administrator can change GitLab's default `glpat-`
  prefix, and project access tokens inherit it; set `token_prefix` to the same value. A token that
  does not start with `token_prefix` is **revoked and refused** at the mint, with a message naming
  this setting, because no other process could redact it.

If any prerequisite is missing, the platform refuses the mint with a message naming the tier and
the token kind rather than surfacing GitLab's 404 — GitLab answers 404 both for "no such project"
and for a feature you may not see.

The binding's own token is **never** handed to a workspace instead: it is the token that *mints*,
the most powerful secret an instance holds, and a run's container is the one place the platform does
not trust. With `mint_credentials` off, a private repository cannot be checked out by any stage.

## 6. Verify

Run **Test connection**. It calls `GET /version` — a read, never a mutation — and reports the
version and edition, e.g. `GitLab 18.1.1-ee (Enterprise Edition) at gitlab.example.test`.

Then, in GitLab, **Settings → Webhooks → Test → Merge request events** and check that the delivery
was accepted.

## Feature availability by version and tier

| Feature | Needs |
|---|---|
| Merge requests, discussions, thread resolution, pipelines, job logs | any version, any tier |
| `detailed_merge_status` | GitLab 15.6+ (before that the platform uses `merge_status`, which is still returned) |
| `order_by=merged_at` on the merge request list | GitLab 17.2+ — not used; the platform orders by `updated_at` and sorts client-side so older instances work |
| Signed webhooks (Standard Webhooks) | GitLab 19.0+ (generally available 19.1) |
| `Idempotency-Key` delivery header | GitLab 17.4+ — not used; the dedup key is event + object id + revision, so a redelivery of the same event is recognised whatever its header |
| Project access tokens | any self-managed tier; **Premium/Ultimate on gitlab.com** |
| Code Owners *enforcement* | Premium/Ultimate. The platform reads the `CODEOWNERS` file on any tier — it is just a file — and uses it for reviewer routing; GitLab will not enforce approvals on Free. |

## What the platform will never do

It does not merge (BD-007). It reports merge state, comments, resolves threads and reads gates; a
human presses **Merge**.
