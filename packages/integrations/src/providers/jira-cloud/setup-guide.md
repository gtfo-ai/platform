# Connecting Jira Cloud

> Rendered in the settings UI when a Jira Cloud binding is added (product/08 § "Setup UX").
> Every value below is a placeholder. Never paste a real token into a document, a ticket or a chat.

## What the platform will do with this access

| It does | It never does |
|---|---|
| Reads the tickets your pick-up rule matches, with their comments, links and epic | Edits a ticket's description (BD-023) |
| Keeps **one** "Agentic workpad" comment per ticket up to date, and posts questions as separate comments | Posts a second workpad, or deletes anything |
| Moves a ticket to a status **you** mapped, and only when it is not already there | Invents a status or creates a workflow |
| Adds and removes the labels your configuration names | Touches a label it was not told about |
| Links the merge request it opened | Transitions or comments on a ticket in another project |

In **shadow mode** it does none of the writes: they are recorded as `would_have` and you can read
them in the audit before you trust the platform with the real thing.

The workpad and each question are found again by a marker the platform writes into its own
comment, so before it edits or posts one it **reads the ticket's comments**, oldest first, a page
at a time, to the end of the thread. It reads at most **twenty pages** of comments plus the empty
page that ends the read (2 000 comments at the page size it asks for, fewer if your site answers
shorter pages). On a ticket longer than that the
workpad update and any marked comment **fail, and say so in the audit log**, rather than post a
second copy: the platform will not answer "not there" about a thread it did not finish reading.

## 1. Create an API token

1. Sign in as the account the platform should act as. Use **one dedicated account per platform
   installation** (`agentic-bot@your-domain`), never a person's own and never one shared by two
   installations. It is worth the licence: every comment, transition and assignment is attributed to
   it, and revoking it revokes everything. It also matters to the claim: the platform claims a ticket
   by assigning it to *this* account, so on a person's own account a ticket assigned to that person
   reads as already claimed by the platform, and two installations sharing one account each see the
   other's claim as their own (PROGRESS backlog 538, `docs/OPEN-QUESTIONS.md` Q118).
2. Go to **Atlassian account → Security → API tokens → Create API token**.
3. Copy the token. Atlassian shows it once.

The platform authenticates with `Authorization: Basic base64(email:api_token)`, which is what
Atlassian documents for API-token access to the REST API.

## 2. Give the account the permissions it needs

In the project's **Project settings → People / Permissions**, the account needs:

| Permission | Used by |
|---|---|
| Browse projects | reading tickets, and searching them — the poll (step 5) and the history bootstrap — and reading the project's statuses (step 6) |
| Assign issues | the claim: assigning a ticket to this account when work starts, and unassigning it only if this account still holds it |
| Add comments | the workpad and questions |
| Edit issues | labels |
| Transition issues | status changes; without it Jira lists no transitions at all |
| Link issues | linking the merge request |
| Create issues | the scope-creep valve and epic splitting (only if you enable them) |

The first four — *Browse Projects*, *Assign Issues*, *Transition Issues* and *Add Comments* — are
what the ticket lifecycle (step 6) needs. A missing *Assign Issues* is reported by name the first time
the platform claims a ticket (`forbidden`, naming the permission), not as a bare `403`.

Nothing here needs Jira administration rights: the platform reads a project's statuses through the
endpoint any account with *Browse Projects* may call, never the administrators' status search. If you would rather not grant *Create issues*, leave
it out: the platform reports the missing capability instead of failing halfway through a task.

## 3. Configure the binding

| Field | Example | Notes |
|---|---|---|
| `site_url` | `https://acme-example.atlassian.net` | Your site, no path |
| `user_email` | `agentic-bot@example.test` | The account the token belongs to |
| `api_token` | `FAKE-jira-api-token-0123456789` | **Secret.** Stored encrypted, redacted from every log and audit row |
| `webhook_secret` | `FAKE-jira-webhook-secret-0123456789` | **Secret.** Needed for the webhook (step 4); leave it unset on a binding that only polls |
| `project_keys` | `["ACME"]` | Deliveries for any other project are ignored and recorded as such |
| `pickup_label` | `agentic` | The label that means "this ticket is for the platform" (product/19 §6) |
| `poll_enabled` | `true` | Poll Jira for the pick-up rule instead of (or beside) the webhook — step 5. Off by default |
| `poll_interval_seconds` | `60` | Seconds between two polls of this binding; 30 to 86400, default 60 |

The same values can come from the environment (TD-020):

```
JIRA_SITE=https://acme-example.atlassian.net
JIRA_USER_EMAIL=agentic-bot@example.test
JIRA_API_TOKEN=            # or JIRA_API_TOKEN_FILE=/run/secrets/jira_api_token
JIRA_WEBHOOK_SECRET=       # or JIRA_WEBHOOK_SECRET_FILE=/run/secrets/jira_webhook_secret
```

The platform **does not follow redirects** (since WP-59): a `site_url` that answers with one fails
every call as `did not complete`. Use the site URL itself, `https://<site>.atlassian.net`.

## 4. Register the webhook (recommended)

A ticket reaches the platform in one of two ways: this webhook, or the poll in step 5. **A binding
with neither passes *Test connection* and never starts a task.** The webhook is the faster and
cheaper of the two and the only one that carries comments and the ticket readiness linter's
*created* event, so use it when the instance is reachable from Atlassian at `APP_BASE_URL`, which is
what the URL below is built from. With no public URL, skip to step 5 and switch polling on.

1. **Jira settings → System → WebHooks → Create a WebHook.**
2. **URL:** `https://<your-instance>/webhooks/jira-cloud/<integration-id>` (the exact URL is shown
   above this guide on the integrations screen, with a Copy button; the API publishes it as the
   `webhook_url` field of `GET /api/integrations/<integration-id>/setup-guide`).
3. **Secret:** generate one and paste the same value into `webhook_secret`. Atlassian shows it once.
4. **Events:** *Issue: created, updated* and *Comment: created*. Nothing else is used, and every
   other event is answered with "not handled by this provider" in the delivery log. *Issue updated*
   is what tells the platform a ticket was edited: a task whose ticket changes is shown the new
   text at its next agent stage, and without the event it keeps the text it read when it started.
5. **JQL filter** (recommended): `project = ACME` — Jira warns that an empty filter sends events for
   every issue in the site, which is more data than the platform needs or should see.

The platform verifies `X-Hub-Signature` on every delivery, de-duplicates on
`X-Atlassian-Webhook-Identifier` (Jira keeps it stable across retries), and rejects a delivery whose
timestamp is more than a day old — enough for Jira's own retry schedule, not enough for a captured
request to be replayed a week later.

## 5. Choose how tickets are picked up — and whether to poll

Either a **label** (the default, `agentic`) or a **status**. The webhook announces a ticket when it
carries the rule's label or enters its status.

**Polling** (`poll_enabled: true`, WP-87) asks Jira for the same rule every `poll_interval_seconds`,
as JQL over the tickets updated since the last poll:

```
labels = "agentic" AND updated >= "-15m" ORDER BY updated ASC
```

The window is relative on purpose: an absolute JQL date is interpreted in the *site's* time zone,
which would silently skip tickets on a site that is not in UTC. It always overlaps the previous
poll a little, and a ticket seen twice in the same state is recorded once. Each ticket a poll finds
is treated exactly like a webhook's match — and **a binding with both the webhook and polling never
starts a ticket twice**, whichever of the two sees it first. The history bootstrap asks the same
rule with its own window.

What polling does not see, so you can choose knowingly:

- **Tickets that already matched before you switched it on.** The first poll reads the last
  interval only, so a ticket labelled last month is not started by switching polling on today;
  touch it (any edit) and the next poll finds it.
- **Comments and new-ticket linting.** Both are webhook-only.
- **A bulk edit of more than a thousand labelled tickets within a few minutes.** A poll reads up to
  a thousand tickets at once; past that it cannot get beyond the edit, and says so in the server log
  on every poll (*"the ticket poll is stalled"*). Use the webhook for a site that bulk-edits on that
  scale.

**Edits to a ticket that left the rule are still seen** (WP-110). Each poll also re-reads the tickets
of this binding's running tasks, whatever the pick-up rule says — so with a **status** rule, a ticket
the platform has moved on to *In Progress* is still read, and an edit to it reaches the running task
at its next agent stage, as it does with a label rule. That second read is one more request per poll
and names at most a hundred tickets (the hundred whose tasks moved last; the server log says when
there are more). It never starts a ticket: what it finds is an edit, never a pick-up. The platform's
own writes — the status it sets, the workpad it updates — are edits too, so the next agent stage may
re-read the ticket once more than it strictly needs to. A running task whose ticket was deleted does
not break the read: Jira refuses a search naming a key that does not exist (`400`, *"An issue with key
'…' does not exist"*), and the platform drops the keys it names and asks again — or, when the refusal
names no key, splits the list until the refused ticket stands alone — and re-reads every other task's
ticket. The server log then names the gone ticket on every poll (*"the tracker refused these live
tasks' tickets as not existing"*) until its task ends. If the read still fails, the poll records the
rule's matches, logs a warning, and tries again next time.

**A ticket moved to another Jira project is the same ticket.** Jira gives a moved issue a new key and
keeps its issue id; the platform records the id beside the key, so a moved ticket that matches again
— by webhook, by poll or by a manual start under its new key — meets the task it already has rather
than starting a second one. A task created before this release recorded no id and is matched by key.
Make sure the integration reads **both** projects (`project_keys`) if tickets move between them.
Edits made **after** the move reach the task too: an update under the new key carries the same id,
so the task's ticket text is read again before its next stage, and the task itself follows the move —
the board and the workpad name the new key, and the task's history records the change. The poll asks
for a task's ticket by that id rather than by its key, so the poll finds a moved ticket as well. A
comment that asks the task (`@agentic ask …`) on the moved ticket reaches it by the id too, even
before an edit has moved the task's key, and a comment on an unrelated ticket that now holds the old
key asks nothing of it. Two
things keep the old key, by design: the task's branch (`agentic/<old key>`) and the merge request's
title, because renaming either would break work already pushed. A task created before this release
has no id and does not follow a move.

## 6. Map your statuses

The platform never invents a status. It moves a ticket **by status name**, resolved against that
project's own workflow at the moment of the move, and fails loudly if the workflow has no transition
that leads there — a silently ignored transition looks exactly like a working mapping until someone
opens the board. The defaults are in product/19 §6; anything your workflow does not have, leave
unmapped and the platform will leave the ticket alone.

The **ticket lifecycle** (BD-031) is the binding's `lifecycle` block: `in_progress`, `in_review`,
`approved`, `qa`, `returned` (a list) and `done`, each naming one of *your* statuses, plus `claim` and
`take_assigned_tickets`. `pickup_status` stays where it is and is the lifecycle's *pick up from* slot,
so no other slot may name the same status (compared ignoring case); the binding is refused if one
does. The platform reads the statuses it may name from Jira itself — the union of every issue type's
statuses in each project of `project_keys` — so **a binding that maps a lifecycle needs
`project_keys`**: with none, there is no project to read statuses from and the read is refused.

## 7. Test the connection

*Test connection* performs one read-only call (`GET /rest/api/3/myself`) and reports the account it
authenticated as. If it fails, the message you see has already been through the secret redactor — if
Jira quoted your token back in an error, you will see `[REDACTED:integration:jira_api_token]`.

## What this provider deliberately does not do

- **Attachment text.** `capabilities().attachments` is `false`: nothing downloads an attachment or
  extracts text from it, and `attachments_text` is always empty.
- **Custom fields.** `capabilities().customFields` is `false`, and a transition that is given field
  values is refused rather than sent — the platform cannot check them against the transition screen,
  and an unchecked field turns into an opaque Jira 400 halfway through a stage.
- **Jira Data Center.** This provider speaks Cloud's REST v3 and ADF. Data Center is a second
  provider (wiki markup, a different auth story), and adding it changes nothing outside its own
  directory (BD-017).
