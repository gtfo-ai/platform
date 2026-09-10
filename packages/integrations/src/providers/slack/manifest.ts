/**
 * The Slack app manifest, and the constants that hold it to the adapter (WP-10 acceptance:
 * "contract suite; **manifest file**").
 *
 * `app-manifest.json` beside this file is what an operator pastes into **Your Apps → Create New
 * App → From an app manifest** (<https://docs.slack.dev/app-manifests/>, retrieved 2026-09-10). It
 * is the whole setup: the scopes, the events, interactivity and Socket Mode, in one document that
 * cannot be half-applied the way a settings screen can.
 *
 * A manifest is a configuration file, and a configuration file drifts away from the code it
 * configures silently — the failure is not an exception but a delivery that never arrives, months
 * later, for the one event nobody subscribed to. So the lists live here as constants, the manifest
 * is read from disk by `manifest.test.ts`, and the two are asserted to agree. That test is the
 * point of this module: an adapter that reads `message.groups` while the manifest subscribes only
 * to `message.channels` is a private channel in which no answer is ever captured.
 *
 * ## Why each scope, so that a reviewer can refuse one
 *
 *  - `chat:write` — `chat.postMessage` and `chat.update`. Deliberately **not**
 *    `chat:write.public`, which would let the app post into any public channel without being
 *    invited: an invite is the operator's consent, and `not_in_channel` is a better failure than a
 *    surprise message in #general.
 *  - `channels:history`, `groups:history` — receive the `message` events that carry a threaded
 *    answer. Without the second one, a private project channel silently captures nothing.
 *  - `users:read` — `users.info`, which maps a Slack user id to an account and, critically,
 *    refuses bots and deactivated accounts.
 *  - `users:read.email` — `users.lookupByEmail`, the only way to map a platform user's email onto
 *    a Slack account (product/08). Without it Slack answers `missing_scope` and identity mapping
 *    is impossible, which means every chat answer is refused as `unmapped_identity`.
 *
 * The app-level token's scope, `connections:write`, is **not** in the manifest: it belongs to the
 * `xapp-` token an operator generates under *Basic Information → App-Level Tokens*, which the
 * manifest schema does not carry. The setup guide says so at the step where it matters.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Bot scopes the adapter's five Web API methods need. Sorted, because the manifest is. */
export const SLACK_BOT_SCOPES = [
  'channels:history',
  'chat:write',
  'groups:history',
  'users:read',
  'users:read.email',
] as const;

/** Events the inbound normaliser understands. Anything else is `unsupported_event`. */
export const SLACK_BOT_EVENTS = ['message.channels', 'message.groups'] as const;

/** The scope of the app-level (`xapp-`) token, which the manifest does not carry. */
export const SLACK_APP_TOKEN_SCOPE = 'connections:write' as const;

export const SLACK_MANIFEST_PATH = 'packages/integrations/src/providers/slack/app-manifest.json';

/** The manifest as shipped. Read from disk so nothing can diverge from the file operators paste. */
export const readSlackManifest = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./app-manifest.json', import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
