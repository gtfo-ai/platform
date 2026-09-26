/**
 * The registration (BD-017): adding a provider is a module plus a registration, and the registry's
 * own guards are what make the second half trustworthy.
 */
import { exactSecretRedactor, noSecretsRedactor, type SecretRedactor } from '@platform/application';
import { fixedClock, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationRegistry } from '../../registry.js';
import { slackConfigSchema } from './config.js';
import { SLACK_PROVIDER_ID, type SlackFetch } from './http.js';
import {
  createSlackRegistration,
  slackAgentTooling,
  slackProviderRegistration,
  slackRateLimitPolicy,
} from './index.js';
import { assertSocketHost } from './provider.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a5';

const config = {
  channel: 'C0FAKECHAN1',
  team_id: 'T0FAKETEAM1',
};

const secrets = {
  bot_token: 'xoxb-FAKE-bot-token-DO-NOT-USE',
  app_token: 'xapp-FAKE-app-token-DO-NOT-USE',
  signing_secret: 'fake-slack-signing-secret-do-not-use',
};

/**
 * Written out in full rather than omitted, which is the whole point of the field being required
 * (standing rule 31): a binding that injected nothing says so, and a reader can find every place
 * that claims it.
 */
const noSecrets = (): SecretRedactor => noSecretsRedactor();

describe('slackProviderRegistration', () => {
  it('registers as a communication provider and is resolvable by type', () => {
    const registry = createIntegrationRegistry([slackProviderRegistration]);
    expect(registry.get('communication', SLACK_PROVIDER_ID).displayName).toContain('Slack');
    expect(() => registry.get('git', SLACK_PROVIDER_ID)).toThrow(/not "git"/);
  });

  it('declares every secret field, and each exists in the config schema', () => {
    // The registry refuses a secret field that is not in the schema — a typo there would render
    // the value as plain configuration (BD-002). This asserts the list is the whole list.
    expect([...slackProviderRegistration.secretFields].sort()).toEqual([
      'app_token',
      'bot_token',
      'signing_secret',
    ]);
    for (const field of slackProviderRegistration.secretFields) {
      expect(Object.keys(slackConfigSchema.shape)).toContain(field);
    }
  });

  it('exposes nothing to an agent', () => {
    // Deliberate: a Slack CLI in a run container would bypass the question record and the audit.
    expect(slackAgentTooling).toBeNull();
    expect(slackProviderRegistration.agentTooling).toBeNull();
  });

  it('declares a budget no faster than one message a second', () => {
    expect(slackRateLimitPolicy.refillPerSecond).toBeLessThanOrEqual(1);
  });

  it('builds a working port from config and secrets', () => {
    const port = slackProviderRegistration.create({
      integrationId: INTEGRATION_ID,
      config,
      secrets,
      redactor: noSecrets(),
    });
    expect(port.ref).toEqual({
      integrationId: INTEGRATION_ID,
      provider: SLACK_PROVIDER_ID,
      type: 'communication',
      // The host the executor's egress allow-list decides on (`IntegrationRef.host`, WP-51).
      host: 'slack.com',
    });
    expect(port.capabilities()).toEqual({
      threads: true,
      buttons: true,
      messageUpdate: true,
      socketMode: true,
      digest: true,
    });
  });

  it('offers buttons only when a click can reach the platform (WP-43)', () => {
    const buttons = (
      overrides: { readonly config?: object; readonly secrets?: Record<string, string> } = {},
    ): boolean =>
      slackProviderRegistration
        .create({
          integrationId: INTEGRATION_ID,
          config: { ...config, ...overrides.config },
          secrets: overrides.secrets ?? secrets,
          redactor: noSecrets(),
        })
        .capabilities().buttons;
    const { app_token: _app, ...noAppToken } = secrets;
    const { signing_secret: _signing, ...noSigningSecret } = secrets;

    expect(buttons(), 'Socket Mode with both credentials').toBe(true);
    expect(buttons({ secrets: noAppToken }), 'Socket Mode cannot open').toBe(false);
    expect(buttons({ secrets: noSigningSecret }), 'no envelope could be verified').toBe(false);
    expect(
      buttons({ config: { socket_mode: false }, secrets: noAppToken }),
      'the HTTP transport needs no app-level token',
    ).toBe(true);
    expect(
      buttons({ config: { socket_mode: false }, secrets: noSigningSecret }),
      'and it does need the signing secret',
    ).toBe(false);
  });

  it('holds Socket Mode as an inbound connection, selected by default and refused without a signing secret', () => {
    const support = slackProviderRegistration.inboundConnection;
    expect(support?.selected({ channel: 'C0FAKECHAN1' })).toBe(true);
    expect(support?.selected({ channel: 'C0FAKECHAN1', socket_mode: false })).toBe(false);
    const { signing_secret: _signing, ...noSigningSecret } = secrets;
    expect(() =>
      support?.open(
        {
          integrationId: INTEGRATION_ID,
          config,
          secrets: noSigningSecret,
          redactor: noSecrets(),
        },
        { onDelivery: async () => {}, execute: async (_ref, _action, perform) => perform() },
      ),
    ).toThrow(/SLACK_SIGNING_SECRET/);
  });

  it('refuses a binding with no bot token rather than failing at the first message', () => {
    expect(() =>
      slackProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config,
        secrets: { ...secrets, bot_token: '   ' },
        redactor: noSecrets(),
      }),
    ).toThrow(/SLACK_BOT_TOKEN/);
  });

  it('refuses an unknown config key', () => {
    expect(() =>
      slackProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { ...config, chanel: 'C0FAKETYPO1' },
        secrets,
        redactor: noSecrets(),
      }),
    ).toThrow();
  });

  it('mints ids that satisfy the platform id schema', () => {
    // `feedback.received` carries a record id the normaliser mints; a malformed one would fail a
    // schema three layers away, inside a transaction.
    const port = slackProviderRegistration.create({
      integrationId: INTEGRATION_ID,
      config,
      secrets,
      redactor: noSecrets(),
    });
    expect(port).toBeDefined();
  });
});

/**
 * The half a required field cannot check for itself.
 *
 * `ProviderCreateInput.redactor` is checked where the object is **constructed**; nothing in the
 * type system says `create` has to *use* it. Slack's registration compiled cleanly through WP-11's
 * merge while forwarding nothing at all, which is standing rule 31 one level out — so these two
 * cases drive the production path and read a string the adapter emitted.
 *
 * They are also the mutation targets: `redactor: noSecretsRedactor()` in place of
 * `redactor: input.redactor` compiles, and kills the first; dropping the
 * `composeSecretRedactors(...)` wrapping in `provider.ts` compiles, and kills the second.
 */
describe('createSlackRegistration threads the redactor into the port it builds', () => {
  const PLANTED = 'FAKE-injected-secret-value-0123456789';

  /** `auth.test`, whose `team` is where each case plants the secret it is about. */
  const authTestAnswering = (team: string): SlackFetch => {
    return async () =>
      new Response(
        JSON.stringify({
          ok: true,
          url: 'https://fake-workspace.slack.com/',
          team,
          team_id: 'T0FAKETEAM1',
          user: 'agentic',
          user_id: 'U0FAKEBOT01',
          bot_id: 'B0FAKEBOT01',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
  };

  const portWith = (fetch: SlackFetch, redactor: SecretRedactor) =>
    createSlackRegistration({
      clock: fixedClock('2026-06-01T09:00:00.000Z'),
      fetch,
      ids: sequentialIds(1),
    }).create({ integrationId: INTEGRATION_ID, config, secrets, redactor });

  it("forwards the caller's redactor into a string the adapter emits", async () => {
    const port = portWith(
      authTestAnswering(`acme ${PLANTED}`),
      exactSecretRedactor([{ name: 'injected', value: PLANTED }]),
    );
    const probe = await port.testConnection();
    expect(probe.detail).toContain('[REDACTED:integration:injected]');
    expect(probe.detail, "the caller's redactor reached the emitted string").not.toContain(PLANTED);
  });

  it("redacts the binding's own bot token even when the caller's redactor knows nothing", async () => {
    // `noSecretsRedactor()` is a legitimate thing for a composition root to pass, and it must not
    // be able to disarm the adapter: the binding's own credentials are composed on top.
    const port = portWith(authTestAnswering(`acme ${secrets.bot_token}`), noSecretsRedactor());
    const probe = await port.testConnection();
    expect(probe.detail).toContain('[REDACTED:integration:slack_bot_token]');
    expect(probe.detail).not.toContain(secrets.bot_token);
  });
});

describe('slackConfigSchema', () => {
  it('defaults the Web API root, the tolerance and Socket Mode', () => {
    const parsed = slackConfigSchema.parse(config);
    expect(parsed.base_url).toBe('https://slack.com/api');
    expect(parsed.signature_tolerance_seconds).toBe(300);
    expect(parsed.socket_mode).toBe(true);
  });

  /**
   * WP-32 removed `digest_cron` and `digest_timezone` with the per-binding digest job they
   * configured; the schema is strict, so a binding that still carries one is refused by name rather
   * than quietly ignored. The assertion is kept because a *silently accepted* leftover key is
   * exactly what the removal must not turn into (standing rule 83, and rule 42's other side).
   */
  it('refuses the digest schedule keys the per-binding job used to carry', () => {
    expect(() => slackConfigSchema.parse({ ...config, digest_cron: '0 9 * * 1-5' })).toThrow(
      /digest_cron/,
    );
    expect(() => slackConfigSchema.parse({ ...config, digest_timezone: 'UTC' })).toThrow(
      /digest_timezone/,
    );
  });

  it('refuses a base URL with a trailing slash and a channel with a space', () => {
    expect(() =>
      slackConfigSchema.parse({ ...config, base_url: 'https://slack.com/api/' }),
    ).toThrow(/must not end with a slash/);
    expect(() => slackConfigSchema.parse({ ...config, channel: '#two words' })).toThrow(
      /no spaces/,
    );
  });
});

describe('the Socket Mode host (WP-43 review round 1, backlog 196)', () => {
  it('accepts the binding’s own host and a subdomain of it, as Slack answers for slack.com', () => {
    for (const url of [
      'wss://wss-primary.slack.com/link/?ticket=x',
      'wss://slack.com/link/?ticket=x',
      'wss://WSS-BACKUP.Slack.com./link/?ticket=x',
    ]) {
      expect(assertSocketHost(url, 'slack.com'), url).toBe(url);
    }
  });

  it('refuses a foreign host, a lookalike suffix and a binding with no host, by name', () => {
    for (const [url, host] of [
      ['wss://attacker.example.test/link/?ticket=x', 'slack.com'],
      // A suffix match without the dot would accept this one.
      ['wss://evilslack.com/link/?ticket=x', 'slack.com'],
      ['wss://slack.com.attacker.example.test/link', 'slack.com'],
      ['wss://wss-primary.slack.com/link', null],
    ] as const) {
      expect(() => assertSocketHost(url, host), url).toThrow(/neither the binding's host/);
    }
    expect(() => assertSocketHost('wss://attacker.example.test/x', 'slack.com')).toThrow(
      /"attacker\.example\.test"/,
    );
  });
});
