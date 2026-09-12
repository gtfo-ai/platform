/**
 * The catalogue against the tree, and its one declaration against the adapters it describes.
 *
 * Three questions, and each one is a way this file can go stale silently:
 *
 *  1. **Is a provider missing?** The set of shipped providers is read off disk — the directories
 *     under `src/providers/` — rather than restated here (standing rule 7). A sixth provider fails
 *     this file on the commit that adds it.
 *  2. **Does every guide exist?** `setupGuidePath` is a string; a rename would leave it pointing at
 *     nothing and `GET /api/integrations/:id/setup-guide` would be the first thing to notice.
 *  3. **Is `inboundWebhook` true?** It is the one field the catalogue *declares* rather than
 *     derives, so it is checked against the object the provider's own `create` returns — the same
 *     `'inbound' in port` question `bindings/inbound-loader.ts` asks in production — in **both**
 *     directions, over every entry (standing rule 68).
 *
 * The adapters below are built with the smallest configuration each schema accepts and a redactor
 * that removes nothing: nothing is called on them, so the construction is the whole test. Slack is
 * built with `socket_mode: false` so no code path here could reach a socket at all.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IntegrationActionExecutor } from '@platform/application';
import { noSecretsRedactor } from '@platform/application';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { findShippedProvider, readSetupGuide, SHIPPED_PROVIDERS } from './catalogue.js';
import { gitlabProviderRegistration } from './providers/gitlab/index.js';
import { fixedActionContext } from './providers/jira-cloud/index.js';
import { createJiraCloudRegistration } from './providers/jira-cloud/registration.js';
import { lokiProviderRegistration } from './providers/loki/index.js';
import { sentryProviderRegistration } from './providers/sentry/index.js';
import { slackProviderRegistration } from './providers/slack/index.js';
import type { AnyProviderRegistration } from './registry.js';

const INTEGRATION_ID = '0199aa11-2b3c-7d4e-8f90-000000000001' as Id;

/** Never called: Jira's registration captures one, and nothing below makes a provider call. */
const unusedExecutor = {
  perform: () => {
    throw new Error('the catalogue test makes no provider call');
  },
} as unknown as IntegrationActionExecutor;

const clock = { now: () => '2026-09-13T00:00:00.000Z' as `${string}T${string}` };

/**
 * One registration per shipped provider, with the smallest configuration each schema accepts.
 *
 * Every credential below is obviously fake (BD-002). They are here because several adapters refuse
 * to be constructed without one — GitLab answers *"the binding has no API token; set GITLAB_TOKEN
 * (TD-020)"* — which is standing rule 18 working, and is why this file cannot be written with empty
 * secrets.
 */
const BUILDABLE: readonly {
  readonly registration: AnyProviderRegistration;
  readonly config: Record<string, unknown>;
  readonly secrets: Record<string, string>;
}[] = [
  {
    registration: gitlabProviderRegistration,
    config: { base_url: 'https://gitlab.example.test' },
    secrets: { token: 'FAKE-gitlab-token-DO-NOT-USE' },
  },
  {
    registration: createJiraCloudRegistration({
      executor: unusedExecutor,
      clock,
      actionContext: fixedActionContext('normal'),
    }),
    config: { site_url: 'https://acme.atlassian.test', user_email: 'ops@example.test' },
    secrets: { api_token: 'FAKE-jira-api-token-DO-NOT-USE' },
  },
  {
    registration: lokiProviderRegistration,
    config: { base_url: 'https://loki.example.test:3100', auth_mode: 'none' },
    secrets: {},
  },
  {
    registration: sentryProviderRegistration,
    config: { organization: 'acme' },
    secrets: { auth_token: 'FAKE-sentry-auth-token-DO-NOT-USE' },
  },
  {
    registration: slackProviderRegistration,
    config: { channel: '#agentic', socket_mode: false },
    secrets: {
      bot_token: 'xoxb-FAKE-slack-bot-token',
      signing_secret: 'FAKE-slack-signing-secret',
    },
  },
];

const providerDirectories = (): string[] =>
  readdirSync(fileURLToPath(new URL('./providers/', import.meta.url)), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

describe('the shipped provider catalogue', () => {
  it('names every provider directory on disk, and no others', () => {
    // The instrument first (standing rule 4): a sweep that found nothing would agree with an
    // empty catalogue.
    const directories = providerDirectories();
    expect(directories.length).toBeGreaterThan(4);
    expect(directories).toContain('gitlab');

    // Provider ids are the directory names — `jira-cloud`, `gitlab`, `slack`, `sentry`, `loki`.
    expect(SHIPPED_PROVIDERS.map((entry) => entry.id)).toEqual(directories);
  });

  it('finds a provider by id and refuses one it does not ship', () => {
    expect(findShippedProvider('gitlab')?.displayName).toContain('GitLab');
    expect(findShippedProvider('fake-git')).toBeUndefined();
    expect(findShippedProvider('')).toBeUndefined();
  });

  it('declares at least one credential field for every provider that has one', () => {
    // Not "every provider has secrets" — a provider could legitimately have none — but the four
    // that do must not silently lose the declaration, because the read API removes exactly these
    // keys from `integrations.config`.
    for (const entry of SHIPPED_PROVIDERS) {
      expect(
        entry.secretFields.every((field) => field.length > 0),
        entry.id,
      ).toBe(true);
      expect(new Set(entry.secretFields).size, entry.id).toBe(entry.secretFields.length);
    }
    expect(findShippedProvider('gitlab')?.secretFields).toContain('token');
    expect(findShippedProvider('jira-cloud')?.secretFields).toContain('api_token');
    expect(findShippedProvider('slack')?.secretFields).toContain('signing_secret');
  });

  it('ships the setup guide every entry points at', async () => {
    for (const entry of SHIPPED_PROVIDERS) {
      const guide = await readSetupGuide(entry);
      expect(guide.markdown.length, entry.id).toBeGreaterThan(200);
      expect(guide.title.length, entry.id).toBeGreaterThan(0);
      // The title comes from the file's own heading, not from the display name, whenever it has
      // one — every shipped guide does, so a fallback that silently took over would be invisible.
      expect(guide.markdown.startsWith(`# ${guide.title}`), entry.id).toBe(true);
    }
  });

  it('refuses a guide path that names no file, rather than answering with an empty one', async () => {
    await expect(
      readSetupGuide({
        id: 'nope',
        type: 'git',
        displayName: 'Nope',
        secretFields: [],
        setupGuidePath: 'packages/integrations/src/providers/nope/setup-guide.md',
        inboundWebhook: false,
      }),
    ).rejects.toThrow();
  });

  it('declares inboundWebhook exactly as the built adapter answers it', () => {
    expect(BUILDABLE.map((candidate) => candidate.registration.id).sort()).toEqual(
      SHIPPED_PROVIDERS.map((entry) => entry.id),
    );

    const both = { declared: [] as string[], built: [] as string[] };
    for (const candidate of BUILDABLE) {
      const entry = findShippedProvider(candidate.registration.id);
      expect(entry, candidate.registration.id).toBeDefined();
      const port = candidate.registration.create({
        integrationId: INTEGRATION_ID,
        config: candidate.registration.configSchema.parse({
          ...candidate.config,
          ...candidate.secrets,
        }),
        secrets: candidate.secrets,
        redactor: noSecretsRedactor(),
      }) as object;
      if (entry?.inboundWebhook === true) {
        both.declared.push(candidate.registration.id);
      }
      if ('inbound' in port && (port as { inbound?: unknown }).inbound != null) {
        both.built.push(candidate.registration.id);
      }
    }

    // Both directions, and as *sets* rather than per-provider assertions, so the failure message
    // names which side is wrong (standing rule 42).
    expect(both.built.sort()).toEqual(both.declared.sort());
    // …and the check is live: a run where nobody has an inbound half would satisfy the equality.
    expect(both.built.length).toBeGreaterThan(0);
    expect(both.built.length).toBeLessThan(SHIPPED_PROVIDERS.length);
  });
});
