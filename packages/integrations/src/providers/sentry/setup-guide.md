# Sentry — setup guide

Applies to **sentry.io** (including its regional hosts) and to a **self-hosted** Sentry. Everything
below is from Sentry's published documentation, retrieved 2026-09-10; where the documentation says
nothing, this guide says so rather than guessing.

The platform uses Sentry in exactly two places (product/08, Q16):

1. it **pre-fetches** the linked issue's latest event into a bug task's Investigation context, and
2. it **resolves** the issue when the fix merges.

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
> "never" — put a calendar reminder on rotation.

## 2. Configure the binding

| Field | Required | What it is |
|---|---|---|
| `base_url` | no (`https://sentry.io`) | Instance root — `https://sentry.io`, `https://us.sentry.io`, or your self-hosted root. **Not** the `/api/0` path, and no trailing slash. |
| `organization` | yes | The organization **slug**, as it appears in a `sentry.io/<org>/<project>/` URL. |
| `auth_token` | yes | Secret. The token from step 1. |
| `request_timeout_ms` | no (30 000) | Per-request timeout. |

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
| `comment(issue, text)` | refuses | The fix is announced on the **ticket** and on the **merge request**; the Sentry issue is *resolved*, which is the state change that matters. |
| `linkMergeRequest(issue, url)` | refuses | Sentry associates code with an issue through its **source-code integration**: install the GitHub/GitLab integration in Sentry, and put `Fixes <SHORT-ID>` (for example `Fixes API-7B`) in the merge commit message. Sentry then links — and can auto-resolve — the issue itself. |

If you need the comment, say so on Q43: the alternative is an undocumented endpoint, and an adapter
that calls one is an adapter that breaks without a changelog entry.

## 5. Resolving on merge

`resolve(issue)` sends `{"status": "resolved"}`. `resolve(issue, {inRelease})` sends
`{"status": "resolved", "statusDetails": {"inRelease": "<version>"}}`, which asks Sentry to
regress the issue only if it recurs **after** that release.

Two notes worth knowing before you read the audit log:

- the adapter issues the `PUT` and then **re-reads** the issue. Sentry's "Update an Issue" page
  publishes no response body, so the state the platform records comes from a read of the resource
  rather than from a shape nobody documents. Two requests per resolve is expected;
- a second `resolve` of an already-resolved issue succeeds and changes nothing.

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
