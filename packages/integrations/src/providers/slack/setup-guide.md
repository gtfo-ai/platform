# Slack — setup guide

Everything below is from Slack's published documentation (retrieved 2026-09-10). The whole setup
is one **app manifest**, which is why this guide is short: a manifest cannot be half-applied the
way a settings screen can.

## 1. Create the app from the manifest

Go to **[Your Apps](https://api.slack.com/apps) → Create New App → From an app manifest**, pick the
workspace, and paste
[`app-manifest.json`](./app-manifest.json)
(`packages/integrations/src/providers/slack/app-manifest.json`).

It asks for exactly five bot scopes and nothing else:

| Scope | Why the platform needs it |
|---|---|
| `chat:write` | Post and edit task threads, questions, approvals and the digest. |
| `channels:history` | Receive the `message` events that carry a threaded answer, in public channels. |
| `groups:history` | The same, in private channels. Without it, a private project channel captures no answers. |
| `users:read` | Map a Slack user id to an account — and refuse a bot or a deactivated one. |
| `users:read.email` | Map a platform user's email to a Slack account (product/08). Without it Slack answers `missing_scope` and **every** chat answer is refused as `unmapped_identity`. |

Deliberately **not** requested: `chat:write.public`, which would let the app post into any public
channel without being invited. An invite is the operator's consent, and a bot that can surprise
`#general` is a bot nobody trusts. There are no user scopes at all — everything the platform does,
it does as the bot.

`manifest.test.ts` asserts that this list and the adapter agree, in both directions: an extra scope
in the manifest fails the build as loudly as a missing one.

## 2. Install it and collect three credentials

They do three different jobs and mixing them up is the most common Slack setup failure.

| Credential | Where it comes from | What it is for | Env (TD-020) |
|---|---|---|---|
| **Bot token** `xoxb-…` | *Install App* → *Bot User OAuth Token* | Every Web API call the platform makes | `SLACK_BOT_TOKEN` |
| **App-level token** `xapp-…` | *Basic Information* → *App-Level Tokens* → **Generate**, scope `connections:write` | Opening the Socket Mode connection, and nothing else | `SLACK_APP_TOKEN` |
| **Signing secret** | *Basic Information* → *App Credentials* | Verifying that an inbound delivery came from Slack | `SLACK_SIGNING_SECRET` |

`connections:write` is not in the manifest because the manifest schema does not carry app-level
token scopes; it is generated on that screen.

> **The signing secret is required even in Socket Mode.** The interactivity and events HTTP paths
> exist whether or not you use them, and a binding that cannot verify a delivery rejects every one
> rather than accepting it unverified. An absent, empty or whitespace value refuses everything —
> including a signature computed with the empty key, which is a signature anybody can compute.

Every one of the three has a `_FILE` variant for a secret file (TD-020).

## 3. Invite the bot to the project channel

```
/invite @Agentic
```

in the channel this project's tasks should appear in. Without it Slack answers `not_in_channel`,
which the platform reports as `forbidden` with that fix in the message — a different failure from
`channel_not_found`, on purpose.

## 4. Configure the binding

| Field | Required | What it is |
|---|---|---|
| `channel` | yes | Where task threads are opened. A channel id (`C0123456789`, from *View channel details*) is safer than a name, which changes when somebody renames the channel. |
| `team_id` | recommended | `T…`, the workspace id (`auth.test` reports it, and *Test connection* shows it). With it set, a delivery from another workspace is rejected as `not_for_this_project`. |
| `digest_channel` | no | Where the digest goes; falls back to `channel`. |
| `digest_cron` / `digest_timezone` | no (`0 9 * * 1-5`, `UTC`) | The digest schedule and the zone it is read in. Never the host's zone. WP-32 owns the policy that overrides these. |
| `socket_mode` | no (on) | Off means inbound arrives over HTTP at `/webhooks/slack/<integrationId>` instead. |
| `signature_tolerance_seconds` | no (300) | How old a delivery may be before it is treated as a replay. Slack's own sample uses five minutes. |
| `bot_token`, `app_token`, `signing_secret` | yes | Secrets, from step 2. |

Then run **Test connection**: it calls `auth.test` (read-only) and shows the workspace it is
talking to.

## 5. What the platform does with it

- **One thread per task.** The first message opens the thread; every question, approval and
  notification for that task is a reply in it.
- **A question is a message with buttons**, one per option, plus "Reply in this thread to answer".
  Either route works: a click carries the option, a reply carries whatever you type.
- **An approval is Approve / Request changes.** A decision from chat is a *human decision*
  (BD-006), which is why the next point is not a detail.
- **An answer only counts from a mapped user.** A Slack account maps to a platform user by its
  Slack user **id**, which Slack sets and nobody can type; an unmapped author's message is recorded
  as `unmapped_identity` and acted on by nobody. Map your team before you expect answers to work
  (product/08, Q10). A bot account and a deactivated account are refused outright.
- **A reply with no open question is feedback**, recorded against the task — including from an
  unmapped author, with a null user id, because feedback is data rather than a decision.
- **Nothing outside a task thread is read.** A message in the channel that is not a reply in a
  thread the platform opened produces no event at all.

## 6. Agent tooling: none

The platform exposes no Slack CLI, no Slack MCP server and no token to an agent. An agent asks a
human through the platform (`ask_human`, `notify_human`), which records the question, its deadline,
its reminder and its audit row. A Slack credential inside a run container would route around all
four (BD-002, BD-025).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `not_found` on the first post | `channel` is wrong, or it is a private channel the bot cannot see. |
| `forbidden` mentioning `/invite` | The channel exists and the bot is not in it (step 3). |
| `forbidden` on identity mapping | The `users:read.email` scope is missing (step 1). Reinstall after changing scopes. |
| Buttons do nothing | Interactivity is off, or the app was installed from an older manifest. Re-apply the manifest and reinstall. |
| Every answer is `unmapped_identity` | The Slack account is not mapped to a platform user, or `users:read.email` is missing. |
| Nothing arrives at all | The app-level token is missing or lacks `connections:write`, or `socket_mode` is off and no public URL is configured. |
| Deliveries rejected as unverified | The signing secret is unset or wrong. It is not optional in Socket Mode. |
