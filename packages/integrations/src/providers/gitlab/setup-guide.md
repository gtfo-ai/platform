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
| Project or group access token | No | Everything else works; leave `mint_credentials` off — and a stage can then only run with a **static run credential** (step 5a). |

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
| `mint_credentials` | no (off) | Whether the platform may mint short-lived project access tokens. A stage that writes, and any stage on a private repository, needs **this or** a static run credential (`run_credential: static`). See step 5. |
| `run_credential` | no (`minted`) | Set on the integration, never on a project's binding (as are the two below). `minted`, `static` or `deploy_key`. `static` gives every run of the one bound project the dedicated `run_token` below instead of a minted token — for GitLab.com Free, which cannot mint. `deploy_key` (GitLab.com only) gives it a project SSH deploy key the run never holds (step 5a, C). **Weaker isolation**: step 5a. Refused beside `mint_credentials: true`. |
| `run_token_owner` | no (`dedicated_user`) | Whose token `run_token` is: `dedicated_user` (step 5a, A) or `operator` — your own, with repository scopes only (step 5a, B; checked differently, and it reaches every repository you can). Only with `static`. |
| `run_token` | with `static` | Secret. The personal access token of a **dedicated** user, or your own repository-only one — never the `token` above (refused when equal). Step 5a. |
| `run_token_username` | with `static` | The token owner's GitLab username: what git sends beside the token, and — for a dedicated user — whose role **Test connection** checks. |
| `run_token_expires_at` | with `static` | The token's expiry as a date (`YYYY-MM-DD`), **at most 90 days ahead** when written. The platform does not ask GitLab for it, and refuses a run once it has passed. |
| `run_ssh_private_key` | with `deploy_key` | Secret. An **unencrypted OpenSSH Ed25519** private key (`ssh-keygen -t ed25519 -N ""`) enabled on the bound project as a deploy key **with write access**. Never in a run's container. Refused with a passphrase, another type, a public key that is not its own, or a `run_token` beside it. Step 5a, C. |
| `run_ssh_public_key` | with `deploy_key` | The key's `ssh-ed25519 AAAA…` line — what **Test connection** looks for among the project's deploy keys and what a run's agent socket lists. |
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
- **Push events** → `default_branch.moved` (only a push onto the project's stored **Default branch** produces an event — since WP-148 whatever GitLab's own default is, because the push names its branch; a push onto GitLab's default that is not the stored branch produces none — keep the two the same anyway, outside a move)

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

- **The default branch's head** — the branch the project's **Default branch** setting stores, never
  GitLab's own default (WP-142); one request per poll — compared with the head the last poll saw.
  Changing the setting resets that comparison, so the next poll records no move. When it moved, the platform records
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
  happened inside it, so these stay webhook-only. The CI gate does not need the pipeline event: it
  asks GitLab for the head's pipeline itself — on a poll-only binding every minute after its first
  five checks, until `pipeline.limits.ci_timeout_minutes` (default 60) has passed since the task
  entered the gate, and then it parks the task with a brief naming that key (WP-136). An approval
  counts toward the approver's review time
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

**Settings → Repository → Protected branches**, protect your default branch (`main`, `develop`,
`dev` — the one the project's **Default branch** setting names) with **Allowed to merge:
Maintainers** and **Allowed to push and merge: No one**, so merging stays a person's act and nobody
pushes to it directly.

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
not trust. With `mint_credentials` off and no static run credential (step 5a), a private repository
cannot be checked out by any stage — the run is refused before its workspace is created, naming the
binding and **both** settings.

## 5a. Or: a static run credential (GitLab.com Free)

GitLab.com Free cannot create project access tokens, so it cannot mint. The founder's answer for that
case (TD-028 decision 13, BD-025's amendments of 2026-10-03 and 2026-10-04) is an **opt-in, named**
fallback the administrator chooses: a token the platform hands to a run exactly where a minted one
would go — on the create request to the launcher, answered to the run's git credential helper, never
in an environment variable, the image, the prompt or a log. **Three forms, side by side; you pick one:**

| | A. A dedicated user's token | B. Your own repository-only token | C. A project SSH deploy key |
|---|---|---|---|
| Setting | `run_credential: static` (`run_token_owner: dedicated_user`, the default) | `run_credential: static`, `run_token_owner: operator` | `run_credential: deploy_key` (GitLab.com only) |
| Costs | a seat on gitlab.com | nothing | nothing (whether a deploy key takes a seat is `[unverified]`, `docs/TODO.md`) |
| What **Test connection** checks | the user's role on the bound project: Developer passes, a higher role is refused | that the token **cannot call the API** (one `GET /user` with it must be refused, `403`), and that the default branch is protected with push **No one** and force push off | that the key is one of the bound project's deploy keys **with write access**, and that the default branch is protected with push **No one** (which admits no deploy key) |
| Re-checked before each run | the declared expiry | the declared expiry **and** the default branch's protection — the token's scope is **not**: run **Test connection** again after every re-seal | the key against its public half; the protection is **not** re-read: run **Test connection** after changing it |
| **What you lose** | the token lives to its expiry; a read-only stage holds a push-capable token; its reach is the user's memberships (one project), which the platform cannot see | all of A's, and **reach**: the token reaches **every repository you can access**, not one project — a read-only stage holds read access to all of them and a writing stage push access to every unprotected branch of all of them | no per-run revocation (removing the key is the revocation); a read-only stage can sign pushes; the run's signing oracle can authenticate to any project the key is enabled on |

C keeps the private key out of the run's container entirely and is the strongest of the three: a run
holds a **signing oracle** for its lifetime and nothing after it. It works on **GitLab.com only** — a
self-managed instance is refused by name (see C below). Choose C where it applies, A if a seat is
available, B otherwise.

### A. A dedicated user's token

1. Create a **dedicated GitLab user** for it — not a person, and not the user whose `token` the
   integration already holds.
2. Add it to the **one** project you bind, and to nothing else, with the **Developer** role. A
   Maintainer or Owner can unprotect the default branch, which is the push control; **Test
   connection** refuses one.
3. As that user, create a **personal access token** with scopes **`read_repository`** and
   **`write_repository`** only, and an expiry **at most 90 days** away.
4. Put it in the platform's environment under a name of your choice (for example
   `GITLAB_RUN_TOKEN`), add that name to `APP_INTEGRATION_SECRET_ENV`, and `docker compose up -d`.
5. On the integration: `run_credential` = `static`, `run_token_username` = the user's username,
   `run_token_expires_at` = the token's expiry date, `mint_credentials` off, and `run_token` → the
   variable's **name** (on an existing integration: re-seal it, `POST /api/integrations/:id/secrets`,
   then set the three fields).
6. Bind it to **one** project — a second project's binding is refused (`409
   static_run_credential_shared`), because the token reaches every project its user is a member of.
7. **Test connection** reports a second check, `run_credential`: the user's role on the bound
   project, read with the integration's API `token` — Developer passes; a role that cannot push
   (anything below Developer) or one above Developer is refused. It says it **cannot confirm the token
   belongs to that user** — for this form the platform never uses the run token for an API call — so check that
   yourself.

### B. Your own repository-only token

TD-028 decision 13a. No dedicated user and no seat: the token is **yours**, so any role is accepted —
Maintainer and Owner included — because what the platform checks instead is what the token **can
use**. Protection, membership and settings are API operations, and a token with only repository
scopes cannot perform them; what it can still do is git, and the default branch's protection bounds
that.

1. **Protect the default branch** as step 4 says — push **No one**, merge Maintainers — and leave
   **Allowed to force push** off. This is the push control for this form, and it is **checked**: at
   **Test connection** and again before **every** run that gets the token, so loosening it later
   refuses the next run, by name, before its workspace exists.
2. As yourself, create a **personal access token** with scopes **`read_repository`** and
   **`write_repository`** — **and nothing else**: no `api`, no `read_api`, no `read_user`. An expiry
   **at most 90 days** away.
3. Steps 4–6 of A, with `run_token_owner` = `operator` and `run_token_username` = your username.
4. **Test connection** reports two checks beside `connection`:
   - `run_credential` — the **scope proof**: one `GET /user` made **with the run token** (the only API
     call the platform ever makes with it, audited like every other). It passes only when GitLab
     **refuses** it for its scope (`403` **with** `insufficient_scope` — a 403 for any other reason, a
     proxy or a firewall, proves nothing and is refused naming its code); a `200` is refused — *"this token can call the GitLab API;
     create one with only `read_repository` and `write_repository`"* — and a `401` is a token GitLab
     does not accept.
   - `default_branch_protection` — read with the integration's API `token`: **every** protection rule
     that matches the project's default branch (the platform's stored one, the project's **Default
     branch** setting), exact **and wildcard** (`*`, `ma*`), combined as GitLab combines them — the
     most permissive wins — must leave push **No one** and force push off; anything else is refused
     naming the branch, the rule and the setting. A **group-level** protected branch (Premium) is not
     read.

**What B costs beyond A** (TD-028 decision 13a item 3): the token reaches **every repository you can
access**, not one project — a read-only stage holds read access to all of them, and a writing stage
push access to every unprotected branch of all of them. A second binding of the integration is still
refused, but nothing stops you binding **another** integration with the same token; the platform does
not detect it. `read_repository` also grants the repository files API, a read the platform does not
use. **CI runs as you**: a pipeline on a pushed `agentic/*` branch — or on a tag a run pushes — runs
under your identity, with what your role may read; a tag matching a protected-tag rule open to
Maintainers gets the project's **protected** CI/CD variables. **Protect your release tags with
"Allowed to create: No one"** too (Settings → Repository → Protected tags).

### C. A project SSH deploy key (GitLab.com)

TD-028 decision 13b (WP-146). No user and no seat: a **deploy key** is scoped by GitLab to the
projects it is enabled on. The platform holds the private key **outside** the run: the run's
container gets a socket, `/ctl/ssh-agent.sock`, served by the run shim, that answers exactly two
ssh-agent requests — *list the one public key* and *sign* — and every sign request is relayed to the
runner, which holds the key and signs with Ed25519. Every other agent request (add, remove, lock,
extensions) is refused. The run's git reaches GitLab over **SSH on port 443**:
`altssh.gitlab.com:443`, through the run's egress sidecar as an HTTP `CONNECT` — the sidecar admits
no other port, and port 22 is never opened (it would be opened for every allowed host at once).

1. **Protect the default branch** as step 4 says — push **No one**, and do **not** add the deploy key
   to the branch's *Allowed to push* list (GitLab lets you; **Test connection** refuses it).
2. Create the key **without a passphrase** and as **Ed25519** — the runner signs unattended and with
   Ed25519 only:

   ```bash
   ssh-keygen -t ed25519 -N "" -C "agentic runs" -f agentic_deploy_key
   ```

3. In the bound project: **Settings → Repository → Deploy keys → Add new key**, paste
   `agentic_deploy_key.pub`, and tick **Grant write permissions to this key**. Enable it on this one
   project only.
4. Give the platform the **private** key under a name of your choice, for example
   `GITLAB_RUN_SSH_PRIVATE_KEY`. A key spans several lines, so give it as a file:
   `GITLAB_RUN_SSH_PRIVATE_KEY_FILE` = the path of `agentic_deploy_key` mounted read-only into the
   `app` container (TD-020's `_FILE` form). Add the name (without `_FILE`) to
   `APP_INTEGRATION_SECRET_ENV`, and `docker compose up -d`.
5. On the integration: `run_credential` = `deploy_key`, `run_ssh_public_key` = the `.pub` line,
   `mint_credentials` off, no `run_token`, and `run_ssh_private_key` → the variable's **name** (on an
   existing integration: re-seal it, `POST /api/integrations/:id/secrets`, then set the fields).
   `base_url` must be `https://gitlab.com`.
6. Bind it to **one** project — a second project's binding is refused (`409
   static_run_credential_shared`), because the key reaches every project it is enabled on.
7. **Test connection** reports two checks beside `connection`, both read with the integration's API
   `token`: `run_credential` — the bound project's deploy keys list this public key **with write
   access**; and `default_branch_protection` — push **No one**, with no deploy key admitted. Both say
   the platform **cannot see whether the key is also enabled on other projects**.

Refused at the write, by name: a key with a **passphrase**, a key that is **not Ed25519** (RSA,
ECDSA, a PEM file), a `run_ssh_public_key` that is **not the private key's** (derived from its seed,
never trusted from the file), `deploy_key` with `mint_credentials: true`, a `run_token` sealed beside
the key (one kind of credential per integration), and a **self-managed** `base_url`: *"SSH deploy-key
runs reach gitlab.com through altssh.gitlab.com:443 only; a self-managed host needs its SSH port
admitted by the egress sidecar, which this build does not do"*. Refused at the run's start, before its
workspace exists: the same key checks again. A **shadow** task is never given the key.

How a run uses it: the run's git is configured through its environment — `GIT_SSH_COMMAND` (no
configuration file, the agent socket, `StrictHostKeyChecking=yes` against a `known_hosts` the
platform writes from **gitlab.com's documented host keys** pinned with `HostKeyAlias=gitlab.com`,
and the shim's `CONNECT` helper as `ProxyCommand`) and one `url.ssh://git@altssh.gitlab.com:443/.insteadOf
= https://gitlab.com/` pair — so the repository's ordinary URL fetches and pushes over SSH and no
HTTPS credential helper is configured. The launcher's own mirror fetch uses the key from a `0600`
file on its short-lived helper's tmpfs. The platform's **knowledge vault** mirror is unchanged: it
reads over HTTPS with the integration's API `token`.

**What C costs, stated** (TD-028 decision 13b item 8): **no per-run revocation** — removing the key
from the project is the revocation; **a read-only stage can sign pushes**; and the signing oracle can
be asked to authenticate to any SSH server the run's egress admits — only `altssh.gitlab.com` — so its
reach is **every project the key is enabled on**. The one control the platform adds: the gate that
reads a merge request's added lines searches them for the key's private text, and a hit parks the task
*Needs human* with a brief that says **replace the deploy key**, never printing it.

### Both A and B

Refused at the write, by name: `static` without a `run_token`; a `run_token` equal to `token`;
`static` with `mint_credentials: true`; no username or no expiry; an expiry passed or more than 90
days away. Refused at the run's start, before its workspace exists: the same token equality again,
and an expiry that has passed. A **shadow** task is never given the static token: it can push and
cannot be narrowed to read-only, so a shadow run on a private repository fails — a writing one at
its start, a read-only one at the fetch.

**What you give up, stated** (TD-028 decision 13 item 5):

- **No per-run revocation, no run-lifetime bound.** The token lives to the expiry you set. Code in a
  run's container can read it through the credential helper (as it can a minted one), and the run's
  egress admits `gitlab.com` — so it can be pushed **into the repository itself**, where, unlike a
  revoked minted token, it still works.
- **Its reach is the user's memberships and scopes, not the platform's choice.** `read_repository` and
  `write_repository` grant no REST API; for A the dedicated user's single Developer membership is what
  bounds it, for B nothing does — it is every repository you can access. The platform cannot see
  memberships beyond the probe.
- **A read-only stage holds a push-capable token.** The protected default branch remains the
  enforcement for pushes.
- **The one control the platform adds**: the gate that already reads a merge request's added lines
  searches them for the exact token, and a hit parks the task *Needs human* with a brief that says
  **rotate the run token** (revoke it in GitLab, create a new one, re-seal it, declare its expiry)
  and never prints it.

Each run records which credential it had (`runs.credential_source`: `minted`, `static`,
`deploy_key` or `none`), because neither a static token nor a deploy key writes a mint row to the
audit.

## 6. Verify

Run **Test connection**. It calls `GET /version` — a read, never a mutation — and reports the
version and edition, e.g. `GitLab 18.1.1-ee (Enterprise Edition) at gitlab.example.test`. For an
integration with `run_credential: static` it adds the checks of step 5a — for a dedicated user's
token the `run_credential` role check (`GET /users?username=` and `GET /projects/:id/members/all/:user_id`,
both with `token`); for your own (`run_token_owner: operator`) the scope proof (`GET /user` with the run
token) and `default_branch_protection` (`GET /projects/:id/protected_branches/:branch` with `token`) —
which fail until a project is bound.

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
