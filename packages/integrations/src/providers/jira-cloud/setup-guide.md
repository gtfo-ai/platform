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

## 1. Create an API token

1. Sign in as the account the platform should act as. A dedicated account (`agentic-bot@your-domain`)
   is worth the licence: every comment and transition is attributed to it, and revoking it revokes
   everything.
2. Go to **Atlassian account → Security → API tokens → Create API token**.
3. Copy the token. Atlassian shows it once.

The platform authenticates with `Authorization: Basic base64(email:api_token)`, which is what
Atlassian documents for API-token access to the REST API.

## 2. Give the account the permissions it needs

In the project's **Project settings → People / Permissions**, the account needs:

| Permission | Used by |
|---|---|
| Browse projects | reading tickets, searching, polling |
| Add comments | the workpad and questions |
| Edit issues | labels |
| Transition issues | status changes |
| Link issues | linking the merge request |
| Create issues | the scope-creep valve and epic splitting (only if you enable them) |

Nothing here needs Jira administration rights. If you would rather not grant *Create issues*, leave
it out: the platform reports the missing capability instead of failing halfway through a task.

## 3. Configure the binding

| Field | Example | Notes |
|---|---|---|
| `site_url` | `https://acme-example.atlassian.net` | Your site, no path |
| `user_email` | `agentic-bot@example.test` | The account the token belongs to |
| `api_token` | `FAKE-jira-api-token-0123456789` | **Secret.** Stored encrypted, redacted from every log and audit row |
| `webhook_secret` | `FAKE-jira-webhook-secret-0123456789` | **Secret.** Leave empty to poll instead of receiving webhooks |
| `project_keys` | `["ACME"]` | Deliveries for any other project are ignored and recorded as such |
| `pickup_label` | `agentic` | The label that means "this ticket is for the platform" (product/19 §6) |

The same values can come from the environment (TD-020):

```
JIRA_SITE=https://acme-example.atlassian.net
JIRA_USER_EMAIL=agentic-bot@example.test
JIRA_API_TOKEN=            # or JIRA_API_TOKEN_FILE=/run/secrets/jira_api_token
JIRA_WEBHOOK_SECRET=       # or JIRA_WEBHOOK_SECRET_FILE=/run/secrets/jira_webhook_secret
```

## 4. Register the webhook (optional but better)

Only if this instance has a public URL (`APP_WEBHOOK_PUBLIC_URL`). Without one, skip to step 5 —
polling is a first-class path, not a fallback of last resort.

1. **Jira settings → System → WebHooks → Create a WebHook.**
2. **URL:** `https://<your-instance>/webhooks/jira-cloud/<integration-id>` (the settings page shows
   the exact URL once the binding is saved).
3. **Secret:** generate one and paste the same value into `webhook_secret`. Atlassian shows it once.
4. **Events:** *Issue: created, updated* and *Comment: created*. Nothing else is used, and every
   other event is answered with "not handled by this provider" in the delivery log.
5. **JQL filter** (recommended): `project = ACME` — Jira warns that an empty filter sends events for
   every issue in the site, which is more data than the platform needs or should see.

The platform verifies `X-Hub-Signature` on every delivery, de-duplicates on
`X-Atlassian-Webhook-Identifier` (Jira keeps it stable across retries), and rejects a delivery whose
timestamp is more than a day old — enough for Jira's own retry schedule, not enough for a captured
request to be replayed a week later.

## 5. Choose how tickets are picked up

Either a **label** (the default, `agentic`) or a **status**. Both are polled with JQL when there is
no webhook:

```
labels = "agentic" AND updated >= "-15m" ORDER BY updated ASC
```

The window is relative on purpose: an absolute JQL date is interpreted in the *site's* time zone,
which would silently skip tickets on a site that is not in UTC.

## 6. Map your statuses

The platform never invents a status. It moves a ticket **by status name**, resolved against that
project's own workflow at the moment of the move, and fails loudly if the workflow has no transition
that leads there — a silently ignored transition looks exactly like a working mapping until someone
opens the board. The defaults are in product/19 §6; anything your workflow does not have, leave
unmapped and the platform will leave the ticket alone.

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
