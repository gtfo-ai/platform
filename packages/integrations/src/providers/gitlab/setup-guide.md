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
| Project or group access token | No | Everything else works; leave `mint_credentials` off. |

Scopes: `api` (the platform reads and writes merge requests, discussions and notes).
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
| `mint_credentials` | no (off) | Whether the platform may mint short-lived project access tokens. See step 5. |
| `read_access_level` / `push_access_level` | no (20 / 30) | Role given to a minted credential: 20 Reporter, 30 Developer, 40 Maintainer. |

Environment names for the bundled `glab` CLI follow TD-020: `GITLAB_HOST`, `GITLAB_TOKEN`.

## 3. Create the webhook

**Settings → Webhooks → Add new webhook**, URL `<APP_WEBHOOK_PUBLIC_URL>/webhooks/gitlab/<integrationId>`.

Triggers to enable:

- **Merge request events** → `mr.opened`, `mr.updated`, `mr.merged`, `mr.closed`
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

If the instance has no public URL for this platform (`APP_WEBHOOK_PUBLIC_URL` unset), skip the
webhook and rely on polling; the same normaliser runs and the dedup key makes both paths safe to
run together.

## 4. Protect the default branch

**Settings → Repository → Protected branches**, protect `main` (or your default) with
**Allowed to push and merge: No one**.

This is a prerequisite, not a suggestion. A GitLab access token carries scopes and a role but
**no branch scoping**, so the platform's `push:agentic/*` constraint is enforced by the credential
helper and by *your* protected-branch rules, not by the token. The platform checks the branch's
`protected` flag and will report a project whose default branch is unprotected.

Add `agentic/*` as a protected branch only if you want to restrict who may delete those branches;
the platform does not need it.

## 5. Optional: let the platform mint short-lived credentials

With `mint_credentials` on, each workspace gets its own project access token
(`POST /projects/:id/access_tokens`) scoped to `read_repository` (+ `write_repository` for a push
credential), revoked when the workspace is destroyed.

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

If any prerequisite is missing, the platform refuses the mint with a message naming the tier and
the token kind rather than surfacing GitLab's 404 — GitLab answers 404 both for "no such project"
and for a feature you may not see.

Leave `mint_credentials` off to use the binding's own token for cloning. That token is then
long-lived and as broad as its scopes, which is the trade.

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
| `Idempotency-Key` delivery header | GitLab 17.4+ — not used; the dedup key is event + object id + revision, so webhooks and polling dedup against each other |
| Project access tokens | any self-managed tier; **Premium/Ultimate on gitlab.com** |
| Code Owners *enforcement* | Premium/Ultimate. The platform reads the `CODEOWNERS` file on any tier — it is just a file — and uses it for reviewer routing; GitLab will not enforce approvals on Free. |

## What the platform will never do

It does not merge (BD-007). It reports merge state, comments, resolves threads and reads gates; a
human presses **Merge**.
