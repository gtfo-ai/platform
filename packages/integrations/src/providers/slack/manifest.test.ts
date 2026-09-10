/**
 * The manifest is held to the adapter, and the adapter to the manifest.
 *
 * WP-10's acceptance criterion is "contract suite; **manifest file**", and a manifest is the one
 * artefact whose drift is invisible: an event the code reads but the manifest does not subscribe
 * to is not an exception, it is a private channel in which no answer is ever captured, discovered
 * weeks later. So the scopes and the events are declared in `manifest.ts`, the manifest is read
 * from **disk** (the same bytes an operator pastes), and the two are compared exactly.
 *
 * `toEqual` rather than "contains": an extra scope in the manifest is a permission nobody asked
 * for, and BD-002's reviewability is worth as much as its completeness.
 */
import { describe, expect, it } from 'vitest';
import {
  readSlackManifest,
  SLACK_APP_TOKEN_SCOPE,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_MANIFEST_PATH,
} from './manifest.js';

const manifest = readSlackManifest();
const at = (path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], manifest);

describe('the Slack app manifest', () => {
  it('is where the registration says it is', () => {
    expect(SLACK_MANIFEST_PATH).toBe('packages/integrations/src/providers/slack/app-manifest.json');
  });

  it('requests exactly the bot scopes the adapter uses, and no more', () => {
    expect(at('oauth_config.scopes.bot')).toEqual([...SLACK_BOT_SCOPES]);
  });

  it('requests no user scopes at all', () => {
    // A user token acts as a human. Everything this adapter does, it does as the bot.
    expect(at('oauth_config.scopes.user')).toBeUndefined();
  });

  it('subscribes to exactly the events the inbound normaliser reads', () => {
    expect(at('settings.event_subscriptions.bot_events')).toEqual([...SLACK_BOT_EVENTS]);
  });

  it('enables Socket Mode and interactivity, and configures no request URL', () => {
    expect(at('settings.socket_mode_enabled')).toBe(true);
    expect(at('settings.interactivity.is_enabled')).toBe(true);
    // In Socket Mode there is no public URL to give, and a manifest that names one would send
    // interactivity to an endpoint this deployment may not expose.
    expect(JSON.stringify(manifest)).not.toContain('request_url');
  });

  it('names the app-level token scope in the setup guide rather than in the manifest', () => {
    // `connections:write` belongs to the `xapp-` token, which the manifest schema does not carry.
    expect(SLACK_APP_TOKEN_SCOPE).toBe('connections:write');
    expect(JSON.stringify(manifest)).not.toContain(SLACK_APP_TOKEN_SCOPE);
  });

  it('stays inside the documented display limits', () => {
    // <https://docs.slack.dev/reference/app-manifest>: name 35, description 140.
    expect(String(at('display_information.name')).length).toBeLessThanOrEqual(35);
    expect(String(at('display_information.description')).length).toBeLessThanOrEqual(140);
    expect(at('_metadata.major_version')).toBe(1);
  });

  it('carries no credential, since a manifest is a public document', () => {
    // The prefixes of every Slack credential. `token_rotation_enabled` is a *setting* and is
    // allowed to say "token"; a value beginning `xoxb-` is not.
    const rendered = JSON.stringify(manifest);
    for (const shape of ['xoxb-', 'xapp-', 'xoxp-', 'xoxe-', 'whsec_']) {
      expect(rendered, `a manifest must not carry ${shape}`).not.toContain(shape);
    }
  });
});
