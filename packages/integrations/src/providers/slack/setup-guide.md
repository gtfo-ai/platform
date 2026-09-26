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
| `channel` | yes | Where task threads are opened, and where a notification with no task (a budget window) is posted. A channel id (`C0123456789`, from *View channel details*) is safer than a name, which changes when somebody renames the channel. A **project** can override it on its own binding, from the project settings page. |
| `team_id` | recommended | `T…`, the workspace id (`auth.test` reports it, and *Test connection* shows it). With it set, a delivery from another workspace is rejected as `not_for_this_project`. |
| `digest_channel` | no | Where the digest goes; falls back to `channel`. |
| ~~`digest_cron` / `digest_timezone`~~ | — | **Removed at WP-32.** *When* the digest goes out is `features.digest.at` in the project's own configuration, read in the organisation's zone (`TZ`, Q38); this schema is strict, so a binding that still carries either key is refused at load with the key named. |
| `socket_mode` | no (on) | **On** — the manifest's own setting, and the one to pick: the process that serves the API opens one Socket Mode connection for this integration and every click and thread message arrives over it, with no public URL (a thread *reply* arrives but is not yet matched to its task — see §5). **Off** means inbound arrives over HTTP at `/webhooks/slack/<integrationId>` instead, which needs a public URL and a manifest you have edited to carry it (see *Which transport* below). |
| `signature_tolerance_seconds` | no (300) | How old a delivery may be before it is treated as a replay. Slack's own sample uses five minutes. |
| `bot_token`, `app_token`, `signing_secret` | yes | Secrets, from step 2. |

Then run **Test connection**: it calls `auth.test` (read-only) and shows the workspace it is
talking to.

### Which transport, and which process holds it

**Socket Mode, unless you have a reason not to.** It is what the manifest selects and it needs no
public URL. Slack is explicit that the two are not combined: *"When you toggle Socket Mode on,
you'll **only** receive events and interactive payloads over your WebSocket connections — not over
HTTP"* (<https://docs.slack.dev/apis/events-api/using-socket-mode>, retrieved 2026-09-26). So pick
one: leave `socket_mode` on and the manifest as shipped, or turn both off together — set
`socket_mode: false` here, disable Socket Mode on the app, and give *Interactivity* and *Event
Subscriptions* the request URL `https://<your instance>/webhooks/slack/<integrationId>`.

- **The connection is held by the process that serves the API** — `ROLE=all` (the default) or
  `ROLE=api`. It is opened when that process starts, re-read every minute so an integration you
  create in the wizard is picked up without a restart, and closed when the process stops. A
  `ROLE=worker` process opens none and says so in its log, naming the integration.
- **Two API replicas hold two connections, and that is fine.** Slack keeps up to ten per app and
  sends each payload to any one of them; a payload Slack sends twice is recognised by its content
  and performed once.
- **A rotated app-level token needs a restart** of the API process: a connection already held is
  not re-read.
- **`APP_INTEGRATION_HOSTS` must name `slack.com`.** Opening the connection is a call like any
  other the platform makes for a binding, and a host nobody declared is refused before it is made.

## 5. What the platform does with it

- **One thread per task.** The first message opens the thread; every question, approval and
  notification for that task is a reply in it.
- **A question is a message in the thread.** Answer it on the task page or in the inbox. On this
  build a *reply* in the thread is not yet matched to its task — the adapter remembers which thread
  belongs to which task only in the process that posted it — so a reply is recorded and changes
  nothing (PROGRESS backlog 195).
- **An approval is Approve / Request changes**, posted with its buttons when a click can reach the
  platform — Socket Mode with the app-level token and the signing secret, or HTTP with the signing
  secret — and as text naming the task page otherwise. A decision from chat is a *human decision*
  (BD-006): it is decided by the approval itself, so the person who clicks must be **mapped** and
  must hold a role that may decide it (a maintainer, for a plan). Anything else is recorded on the
  delivery and changes nothing. An approval raised during quiet hours reaches the digest as a line
  without buttons, because by then the task page is the place to decide.
- **A decision only counts from a mapped user.** A Slack account maps to a platform user by its
  Slack member **id**, which Slack sets and nobody can type; an unmapped author is recorded as
  `unmapped_identity` and acted on by nobody. Map your team on **Settings → Provider identities**
  (an admin screen) before you expect a click to work (product/08, Q10). The platform never matches
  an account by email on its own.
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
| Buttons do nothing | Read the delivery's `inbox.error` (no screen shows it yet; the API process also logs `held-connection delivery handled` per click): `unmapped_identity` — the clicker is not mapped on **Settings → Provider identities**; `decision_refused: not_permitted` — they are mapped but their role may not decide this approval; `decision_refused: already_decided` — somebody decided first. With no row at all, see the next line. Interactivity off, or an app installed from an older manifest, also silences them: re-apply the manifest and reinstall. |
| Every decision is `unmapped_identity` | The Slack account is not mapped to a platform user on **Settings → Provider identities**. |
| No approval is posted, only text saying to decide on the task page | The binding cannot receive a click: the signing secret is missing, or Socket Mode is on and the app-level token is missing. |
| Nothing arrives at all | **No process that serves the API is running** — the connection is held by `ROLE=all` or `ROLE=api`, and a `ROLE=worker` process logs that it holds none, naming the integration. Otherwise the API process's log names the integration and the reason it holds no connection: the app-level token missing or lacking `connections:write`, the signing secret missing, or `slack.com` absent from `APP_INTEGRATION_HOSTS`. With `socket_mode` off, Slack has no request URL to call unless you gave the app one. |
| Every call fails with `… could not be reached, or answered with a redirect …` | Slack's API answered with a redirect, which the platform refuses to follow with the bot token on the request (since WP-59) — or the network path is down. |
| Deliveries rejected as unverified | The signing secret is unset or wrong. It is not optional in Socket Mode. |
