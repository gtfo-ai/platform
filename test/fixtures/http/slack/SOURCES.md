# Slack HTTP fixtures — where each one comes from

WP-10 was implemented **without access to a Slack workspace**. Nothing here was recorded from a
live call, and pretending otherwise is exactly how a provider adapter passes its own tests and
fails in production. Every document is derived from Slack's *published* documentation, and every
recorded interaction carries a `source` block naming that page, the date it was retrieved, and how
far the interaction sits from it.

## The provenance lives on the interaction, not on the file

Each file here is one recorded **conversation** — `{"interactions": [...]}`, replayed by
`test/contract/support/integrations/slack-replay.ts` — and a single conversation legitimately cites
several claims from one page: in `chat-post-message.json` the `200` is the page's printed example
while the `channel_not_found` `200` is assembled from that page's error list and the Web API's
error envelope. A file-level block would have to pick one label for both, so the block sits on the
interaction, where the claim is actually true. WP-08's Jira corpus is one document per file and
carries its block per file; both shapes are accepted, and
`test/contract/support/integrations/fixture-provenance.ts` says why, and why partial coverage or an
empty `interactions` list is a failure rather than a pass.

| `kind` | what it means | where it is used here |
|---|---|---|
| `documented` | Slack's own printed example, with values replaced by obviously fake ones (BD-002) and members the adapter never reads removed. Nothing about the shape is ours. | the `chat.postMessage` and `chat.update` success bodies, `users.lookupByEmail` and `users.info` success bodies, `apps.connections.open` |
| `documented-adapted` | Every *fact* is documented but no printed example carries this exact body: an error slug from the method's error list dressed in the Web API's documented `{ok: false, error}` envelope, or a success body reduced to the members the adapter reads. The `note` says which facts were combined. | every `ok: false` body, the threaded `chat.postMessage`, `auth.test` (its `bot_id`) |
| `composed` | The documentation states the *field* exists and never shows it in this state, so the fixture is assembled around it. | `users.info` for a bot account and for a deactivated account |
| `inferred`, `invented` | Available in the shared vocabulary; **no file here uses them.** Adding an `invented` fixture should be argued for in review rather than done quietly. | — |

**Why so many are `documented-adapted` rather than `documented`.** Slack's reference pages list a
method's error codes in a table and print exactly one example body: the success. The universal
error envelope is documented separately, on
`https://docs.slack.dev/apis/web-api/` — so an error fixture is always two documented facts joined
by us. That join is a real editorial act, and the label says so rather than borrowing the
credibility of a printed example.

## The `source` blocks are checked, and here is exactly how far

`test/contract/integrations/fixture-provenance.contract.test.ts` runs the shared suite over
**every** provider directory it finds under `test/fixtures/http/` — this one included. It asserts
that every interaction in every file has a `source`, that the label is one of the five kinds, that
a claim which is not `invented` cites an `https` URL which is **not** on a domain IANA reserves for
documentation (`.invalid`, `.example`, `.test`, `example.com` …) and whose host is named in *this*
file, that the `retrieved` date is a real day and not in the future, and that anything other than
plain `documented` carries a `note`.

It still cannot check that `docs.slack.dev` says today what a fixture claims, that a body matches
the example it cites, that a label is honest, or that the right interaction carries the right
citation. Those remain a reviewer's job.

## Sources

All retrieved **2026-09-10**.

- `https://docs.slack.dev/reference/methods/chat.postMessage` — the arguments (`channel`, `text`,
  `blocks`, `thread_ts`), "Accepted content types: `application/x-www-form-urlencoded`,
  `application/json`", the example success response, and the error list the adapter's mapping is
  built from (`channel_not_found`, `invalid_blocks`, `not_in_channel`, `msg_too_long`,
  `ratelimited`, `invalid_auth`, `token_revoked`, `missing_scope`, `is_archived`, …).
- `https://docs.slack.dev/reference/methods/chat.update` — the required `channel` and `ts`, the
  example success response, and `message_not_found`, `cant_update_message`, `edit_window_closed`,
  and "The `text` field cannot exceed 4,000 characters".
- `https://docs.slack.dev/reference/methods/auth.test` — the example success response, the note
  that a bot token's response carries `bot_id`, and the authentication error slugs.
- `https://docs.slack.dev/reference/methods/users.info` — the required `users:read` scope, the
  example user object, and `user_not_found` / `user_not_visible`.
- `https://docs.slack.dev/reference/methods/users.lookupByEmail` — the required `users:read.email`
  scope, the example user object, and `users_not_found`.
- `https://docs.slack.dev/reference/methods/apps.connections.open` — "POST
  https://slack.com/api/apps.connections.open", the app-level token in the `Authorization` header,
  and the example `wss://` response.
- `https://docs.slack.dev/apis/web-api/rate-limits` — the tiers, "generally allows posting one
  message per second per channel, while also maintaining a workspace-wide limit", "HTTP 429 Too
  Many Requests" and `Retry-After: 30` ("the number of seconds until you can retry"). The 429 is
  **not** a file here: it is scripted by `slack-executor.contract.test.ts`, where the interaction
  that exercises it lives, and it carries its own `source` block there.
- `https://docs.slack.dev/authentication/verifying-requests-from-slack` — `v0:timestamp:body`,
  `X-Slack-Signature`, `X-Slack-Request-Timestamp`, the five-minute replay window and "use an hmac
  `compare` function". **No fixture file**: signatures are computed by the harness over the exact
  bytes it sends, see below. Transcribed in `signature.ts`.
- `https://docs.slack.dev/apis/events-api/using-socket-mode` — `apps.connections.open`, the
  envelope (`envelope_id`, `type`, `payload`, `accepts_response_payload`, `retry_attempt`,
  `retry_reason`), the `hello` / `disconnect` types, the `link_disabled` / `warning` /
  `refresh_requested` reasons and the ack shape. **No fixture file**: envelopes are built by
  `slack-fixtures.ts`, which is where the payloads they carry are also built.
- `https://docs.slack.dev/reference/events/message` — the Events API `event_callback` envelope and
  the `message` event (`type`, `channel`, `user`, `text`, `ts`, `channel_type`). **No fixture
  file**: built by `slack-fixtures.ts`.
- `https://docs.slack.dev/reference/interaction-payloads/block_actions-payload` — the printed
  `block_actions` payload (`type`, `team`, `user`, `api_app_id`, `container`, `trigger_id`,
  `channel`, `message`, `response_url`, `actions[]` with `action_id`, `block_id`, `text`, `value`,
  `action_ts`). **No fixture file**: built by `slack-fixtures.ts`.
- `https://docs.slack.dev/reference/block-kit/blocks`,
  `https://docs.slack.dev/reference/block-kit/blocks/section-block`,
  `https://docs.slack.dev/reference/block-kit/blocks/actions-block`,
  `https://docs.slack.dev/reference/block-kit/blocks/header-block`,
  `https://docs.slack.dev/reference/block-kit/block-elements/button-element` — the limits the
  adapter enforces before sending (50 blocks per message; section text 3,000 and `block_id` 255;
  25 elements per actions block; header text 150; button text 75, value 2,000, `action_id` 255;
  `style` is `primary` or `danger`). **No fixture file**: transcribed in `blocks.ts` and asserted
  in both directions in `blocks.test.ts`.
- `https://docs.slack.dev/messaging/formatting-message-text` — "Slack uses `&`, `<`, and `>` as
  control characters … they must be converted to HTML entities", and the `@channel` / `@here` /
  `@everyone` broadcast mentions those characters spell. **No fixture file**: this is why
  `mrkdwn.ts` escapes before it converts.
- `https://docs.slack.dev/reference/app-manifest` and `https://docs.slack.dev/app-manifests/` — the
  manifest's sections (`_metadata`, `display_information`, `features`, `oauth_config`, `settings`),
  the name/description limits, and the "Create New App → From an app manifest" flow.
  **No fixture file**: the manifest is a shipped artefact,
  `packages/integrations/src/providers/slack/app-manifest.json`, held to the adapter by
  `manifest.test.ts`.
- `https://docs.slack.dev/tools/node-slack-sdk/web-api/` — "The client will retry a failed API
  method call up to 10 times, spaced out over about 30 minutes" and the automatic 429 handling.
  **No fixture file**: it is the evidence behind Q42, the decision not to use `@slack/web-api`.

## What is deliberately **not** in a fixture

- **Signatures.** A delivery is built and signed by `slack-fixtures.ts` over the exact bytes it
  sends. A literal signature here would be a signature over a body nobody could reproduce, and it
  would go stale the first time a field moved. The signing secret is an obviously fake string built
  at run time, so the repository's own secret scanner has nothing to find (BD-002).
- **Credentials.** The bot token, the app-level token and the signing secret in the harness are
  shaped like nothing Slack issues, for the same reason. The `wss://` ticket above is fake because
  a real one is a short-lived credential.
- **Sequencing.** These files are *recorded exchanges*, not a state machine. `slack-replay.ts`
  decides which recorded response answers which request — by path and by a subset of the request
  body, because every Slack method is a `POST` to its own path and the *body* is what
  distinguishes one call from another — counts what was served, and fails on a fixture nothing
  exercises.

## Ambiguities found in the documentation, and what was done about them

1. **No printed example of any error body.** Every reference page lists error slugs in a table and
   prints only the success. Each error fixture is therefore the documented slug inside the
   documented envelope, labelled `documented-adapted`, and the `note` says so. The adapter reads
   only `ok` and `error`, so nothing else about those bodies is load-bearing.
2. **`missing_scope` carries `needed` and `provided`.** Widely returned, nowhere printed. Recorded
   as adapted, and the adapter reads neither member — it maps the slug and stops.
3. **A bot account and a deactivated account are never shown.** `is_bot` and `deleted` are
   documented members shown as `false` in every example. Identity mapping must refuse both, so the
   two fixtures are `composed` rather than borrowed.
4. **The rate-limited response has no published body.** Only "HTTP 429 Too Many Requests" and
   `Retry-After: 30`. The scripted 429 in the executor test therefore carries a body that is
   illustrative and a status and header that are documented; only the latter two are load-bearing.
5. **Socket Mode's envelope is documented as a shape, not as an example.** The page gives the
   member names with placeholder values (`"<unique_identifier_string>"`) rather than a filled-in
   envelope, and it does not print the payload an `events_api` envelope carries. The harness
   therefore builds the envelope from the member list and the payload from the Events API and
   interaction-payload pages, which is why those envelopes are built in code with the two pages
   cited at the builder rather than recorded as one document that would have to cite three.
