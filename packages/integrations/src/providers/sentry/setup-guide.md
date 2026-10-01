# Sentry — setup guide

Applies to **sentry.io** (including its regional hosts) and to a **self-hosted** Sentry. Everything
below is from Sentry's published documentation, retrieved 2026-09-10; where the documentation says
nothing, this guide says so rather than guessing.

The platform uses Sentry in exactly two places (product/08, Q16):

1. it **pre-fetches** the linked issue's latest event into a bug task's Investigation context, and
2. **only where the binding sets `resolve_on_merge`** (off by default), it **resolves** the issues
   a bug task's ticket links once that task's merge request merges (§ 5). Without the flag a merged
   fix does not resolve its Sentry issue; the vendor's `Fixes <SHORT-ID>` route (§ 4) still does.

Everything else Sentry can do is out of scope for this binding.

## 1. Create the auth token

**Settings → Developer Settings → Organization Tokens** (or a user auth token for a self-hosted
instance). The platform sends it as `Authorization: Bearer <token>`.

| Scope | Why |
|---|---|
| `event:read` | Read an issue, its latest event and a project's issue list. |
| `event:write` | Resolve an issue (`PUT …/issues/{id}/`; Sentry documents `event:admin` **or** `event:write`). |
| `org:read` | *Test connection* reads `GET /api/0/organizations/{org}/`, which needs this. |

Leave `event:admin`, `project:write` and everything else off. The platform never deletes an issue,
never merges issues and never changes project settings.

> Create the token on a bot identity rather than on a person's account. Sentry publishes no expiry
> for an auth token, so the health panel shows `token_expires_at` as **unknown** rather than
> "never" — put a calendar reminder on rotation. To rotate, put the new token in a new environment
> variable on `APP_INTEGRATION_SECRET_ENV` and press **Replace credentials** on the integration's card
> (`POST /api/integrations/<id>/secrets`); the old sealed token is deleted.

## 2. Configure the binding

| Field | Required | What it is |
|---|---|---|
| `base_url` | no (`https://sentry.io`) | Instance root — `https://sentry.io`, `https://us.sentry.io`, or your self-hosted root. **Not** the `/api/0` path, and no trailing slash. |
| `organization` | yes | The organization **slug**, as it appears in a `sentry.io/<org>/<project>/` URL. |
| `auth_token` | yes | Secret. The token from step 1. |
| `request_timeout_ms` | no (30 000) | Per-request timeout. |
| `resolve_on_merge` | no (`false`) | Resolve the issues a bug task's ticket links when its merge request merges (§ 5). Set it on the **binding** — whether a merge closes issues is the project's decision; set on the account, every binding of it inherits it unless the binding says `false`. Needs `event:write`. |

The platform **does not follow redirects** (since WP-59), not even Sentry's own: its API
301-redirects a path without a trailing slash, and every path the platform builds carries one, so
nothing is lost. A `base_url` that answers with a redirect fails every call naming the method and
the path — configure the URL it points at.

### Caps — what the platform will and will not hand an agent

A Sentry event is attacker-influenced text that ends up in an agent's context (BD-022), and three
of its members have no natural bound. Each cap leaves a **visible marker** in the text saying what
was dropped and which key dropped it, so a truncated trace is never mistaken for a whole one.

| Field | Default | What it bounds |
|---|---|---|
| `max_issues` | 25 | Highest `limit` a search may ask for. A larger one is **refused**, not clamped. Sentry's own maximum is 100. |
| `max_stack_frames` | 50 | Frames kept, from the innermost end. A runaway recursion pads the *front*. |
| `max_stack_trace_bytes` | 65 536 | Bytes of the rendered trace, after redaction. |
| `max_breadcrumbs` | 25 | Crumbs kept, newest last. The gap is announced as a crumb of its own. |
| `max_breadcrumb_bytes` | 1 024 | Bytes of one crumb message. |
| `max_tags` | 50 | Tags kept. |
| `max_message_bytes` | 8 192 | Bytes of the event message, the issue title and the culprit. |

### How a bug task finds its issue (WP-89)

The platform reads the issue the **ticket links**. Before a bug task's Investigator runs, it looks in
the ticket's title, description and comments for a link to *this binding's* instance and
organization — `https://<org>.sentry.io/issues/<id>/`, `https://<host>/organizations/<org>/issues/<id>/`,
or the older `https://<host>/<org>/<project>/issues/<id>/` — and reads the **first** one: the issue
and its latest event, two `integration_actions` rows (`get_issue`, `get_latest_event`) against this
binding. Sentry's own *Create Jira issue* action puts such a link in the description; a human can
paste one. A link to another host or another organization is ignored, and a short id (`ACME-1AB`)
on its own is not followed. So a ticket author can choose which issue **of this organization** the
agent is shown, never which host is called or whose credential is used — if you bind one
organization to two projects, its issues are readable from both.

What reaches the prompt is redacted, placed inside a data block and cut at 12 000 characters with
the cut announced — the caps above bound what the adapter reads, the prompt has a bound of its own
(`MAX_ERROR_EVENT_EXCERPT_CHARS`, derived in `packages/domain/src/prompt/assembly.ts`). A ticket
with no link, an issue with no event left, a Sentry that is down or a binding that will not load
never stops the task: the prompt's block says which (`no_issue_link`, `unavailable`, …), the
platform logs why, and the investigation runs.

## 3. Webhooks — not used in v1

There is **no inbound normaliser** for this type. product/08 lists `error.issue.created` as
optional and technical/02's event catalogue has no such event, so a normaliser would have nothing
legal to emit. Do not point a Sentry webhook at the platform; nothing would consume it.

## 4. What this binding cannot do, and what to do instead

Two port methods are declared **unsupported** and refuse with `unsupported_capability`. This is not
caution: Sentry's published API reference documents 21 endpoints for Events & Issues, and none of
them is a comment, a note or a code link (open question **Q43**).

| Port method | Status | The supported route instead |
|---|---|---|
| `comment(issue, text)` | refuses | The fix is announced on the **ticket** and on the **merge request**; resolving the Sentry issue is the state change that matters, and it happens on merge only where the binding sets `resolve_on_merge` (§ 5) — no comment is ever posted. |
| `linkMergeRequest(issue, url)` | refuses | Sentry associates code with an issue through its **source-code integration**: install the GitHub/GitLab integration in Sentry, and put `Fixes <SHORT-ID>` (for example `Fixes API-7B`) in the merge commit message. Sentry then links — and can auto-resolve — the issue itself. |

If you need the comment, say so on Q43: the alternative is an undocumented endpoint, and an adapter
that calls one is an adapter that breaks without a changelog entry.

## 5. Resolving on merge

**Off unless the binding sets `resolve_on_merge: true`** (step 2). product/08 calls the resolve
*optional*, and it is a write to your Sentry, so a binding that says nothing resolves nothing.

When the flag is set, this is what happens when a merge request the platform made **merges**:

1. the task must be a **bug** task (the `bug` template — the project's `templates` map routes the
   ticket's issue type to it). Any other task's merge resolves nothing;
2. the platform scans the task's **stored ticket text** — title, description and the comments it
   kept — for links to issues of **this binding's** host and organisation (the same scan the
   Investigation pre-fetch uses: `https://<org>.sentry.io/issues/<id>/`,
   `…/organizations/<org>/issues/<id>/` and `…/<org>/<project>/issues/<id>/`, at most 20 issues,
   each once). A link to another host or organisation is ignored, and a short id such as `API-7B`
   is not followed;
3. it **resolves** each linked issue: `{"status": "resolved"}`, with **no release** — the platform
   knows that the fix merged, not which release will carry it. Each resolve is one call through the
   platform's action executor: one row in the audit log (`integration_actions`, action
   `resolve_issue`), against this binding, rate-limited on its budget, and a `would_have` row with
   no call for a task running in shadow mode;
4. each resolve is **keyed on the task and the issue**, so a second merge event for the same task
   — a redelivery, a poll and a webhook reporting the same merge, a merge request reopened and
   merged again — **replays** (a `replayed` audit row, no request) and resolves nothing twice.

What it does **not** do: it posts no comment on the issue and links no merge request to it (§ 4,
Q43 — Sentry documents neither); it never un-resolves, ignores or assigns anything. An issue
Sentry refuses (deleted, or outside the token's reach) is logged and left as a `failed` audit row
while the other linked issues are still resolved; a refusal a retry may cure (a rate limit, Sentry
unavailable) retries the whole step, and the issues already resolved replay.

> **What the flag hands to anyone who can comment on the ticket.** Which issues are resolved is
> chosen by the ticket's text — its title, its description **and its newest twenty comments that the
> platform did not mark as its own** — within this binding's organisation only, never another host or credential. On a
> flagged binding, anyone who can edit or comment on a bug ticket that the platform takes to a merge
> can have it resolve any issue of that organisation by linking it there. That is why the flag is
> off by default; Sentry re-opens a resolved issue as a regression when it recurs.

What the adapter does when it is called, worth knowing before you read the audit log:

- it issues the `PUT` and then **re-reads** the issue. Sentry's "Update an Issue" page publishes no
  response body, so the state the platform records comes from a read of the resource rather than
  from a shape nobody documents. Two requests per resolve is expected (one audit row);
- a second `resolve` of an already-resolved issue succeeds and changes nothing;
- `resolve(issue, {inRelease})` — `{"status": "resolved", "statusDetails": {"inRelease":
  "<version>"}}`, which asks Sentry to regress the issue only if it recurs **after** that release —
  exists on the adapter, and the on-merge step does not use it.

## 6. Agent tooling — nothing is mounted, and why

The platform mounts **no** Sentry tool into a run container and injects **no** Sentry credential
(BD-025). The three surfaces Sentry publishes each fail a different requirement:

- the hosted MCP server at `https://mcp.sentry.dev/mcp` states "All connections use OAuth. The
  first connection will trigger an authentication flow to connect to your Sentry account". A run
  container has no browser, and a tooling spec carries **names only** — there is no field for a
  value, deliberately;
- the classic `sentry-cli` has a fully documented environment (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `SENTRY_URL`) and **no issue commands at all**;
- the new interactive CLI is announced on Sentry's own CLI page, and its documentation lives off
  the vendor's documentation site.

What the agent gets instead is the **pre-fetched event** — bounded by the caps in step 2 and
redacted by TD-012's redactor — presented as data. If you want the MCP server mounted, that is a
decision about BD-025, not a configuration flag.

## 7. Test connection

*Test connection* performs one read-only call, `GET /api/0/organizations/<organization>/`. It never
mutates. Common failures:

| Result | Usually means |
|---|---|
| `no auth token is configured for this binding` | The secret is missing, empty or whitespace. The platform refuses **before** sending anything; an empty token is not a token. |
| `… answered 401` | The token is wrong or revoked. |
| `… answered 403` | The token is valid but lacks `org:read`, or cannot see this organization. |
| `… answered 404` | The `organization` slug is wrong — check it against the URL of any issue. |

The `detail` line is run through the secret redactor before it is stored, so a probe can be shown
in the settings screen without leaking what was sent.
