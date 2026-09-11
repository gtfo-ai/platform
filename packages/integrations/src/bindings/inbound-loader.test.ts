/**
 * The loader that turns `integrations.id` into the objects the webhook endpoint needs (WP-15c).
 *
 * Three facts have to stay apart, and the whole file is about them: an integration **nobody has**,
 * an integration **nobody has bound**, and an integration whose adapter **cannot be built**. The
 * first is a 404 that writes nothing, the second is a delivery that is stored and performs nothing,
 * and the third is a deployment defect that must not look like either.
 */
import type {
  BindingRepository,
  IntegrationAccount,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import { noSecretsRedactor, SecretResolutionError } from '@platform/application';
import type { Id, JsonObject } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { AnyProviderRegistration } from '../registry.js';
import { createIntegrationRegistry } from '../registry.js';
import { createInboundIntegrationLoader } from './inbound-loader.js';
import { BindingLoadError } from './loader.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000000c1' as Id;
const PROJECT_A = '00000000-0000-4000-8000-0000000000b1' as Id;
const PROJECT_B = '00000000-0000-4000-8000-0000000000b2' as Id;

/** Obviously fake, and long enough to clear `MIN_SECRET_LENGTH`. */
const WEBHOOK_SECRET = 'FAKE-PLANTED-webhook-secret-0123456789';

const accountOf = (overrides: Partial<IntegrationAccount> = {}): IntegrationAccount => ({
  integrationId: INTEGRATION,
  type: 'task_management',
  provider: 'probe',
  name: 'acme tickets',
  config: { pickup_label: 'agentic' },
  secretIds: ['00000000-0000-4000-8000-0000000000e1' as Id],
  bindings: [
    {
      bindingId: '00000000-0000-4000-8000-0000000000f1' as Id,
      projectId: PROJECT_A,
      config: { pickup_label: 'agentic' },
    },
  ],
  ...overrides,
});

const repositoryOf = (account: IntegrationAccount | null): BindingRepository => ({
  forProject: async () => [],
  forIntegration: async () => account,
});

const secretsOf = (
  resolved: Readonly<Record<string, string>> | Error = { webhook_secret: WEBHOOK_SECRET },
): SecretStore => ({
  resolve: async () => {
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved;
  },
});

/**
 * A registration that records the config it was built with and **composes no redactor of its own**.
 *
 * That second half is the seam `loader.test.ts` uses for the same reason: an adapter that redacts
 * for itself would discharge the loader's obligation and make deleting it invisible.
 */
const probeRegistration = (
  built: { config: JsonObject; redactor: SecretRedactor }[],
  options: { readonly withInbound?: boolean; readonly throwOnCreate?: boolean } = {},
): AnyProviderRegistration => ({
  id: 'probe',
  type: 'task_management',
  displayName: 'Probe',
  configSchema: z.strictObject({
    pickup_label: z.string().min(1),
    webhook_secret: z.string().min(1),
  }),
  secretFields: ['webhook_secret'],
  setupGuidePath: 'none',
  agentTooling: null,
  create: ({ config, redactor }) => {
    if (options.throwOnCreate === true) {
      throw new Error('the adapter refused to be built');
    }
    built.push({ config: config as JsonObject, redactor });
    const port = {
      ref: { integrationId: INTEGRATION, provider: 'probe', type: 'task_management' },
      capabilities: () => ({}),
      testConnection: async () => ({ ok: true, checked_at: '2026-06-01T10:30:00.000Z' }),
    };
    return (
      options.withInbound === false
        ? port
        : {
            ...port,
            inbound: {
              verify: () => true,
              deliveryKey: () => 'probe:d-1',
              normalise: async () => ({ events: [], ignored: [] }),
            },
          }
    ) as never;
  },
});

const loaderFor = (
  account: IntegrationAccount | null,
  options: {
    readonly built?: { config: JsonObject; redactor: SecretRedactor }[];
    readonly secrets?: SecretStore;
    readonly withInbound?: boolean;
    readonly throwOnCreate?: boolean;
    readonly registered?: boolean;
  } = {},
) =>
  createInboundIntegrationLoader({
    repository: repositoryOf(account),
    secrets: options.secrets ?? secretsOf(),
    registry: createIntegrationRegistry(
      options.registered === false
        ? []
        : [
            probeRegistration(options.built ?? [], {
              ...(options.withInbound === undefined ? {} : { withInbound: options.withInbound }),
              ...(options.throwOnCreate === undefined
                ? {}
                : { throwOnCreate: options.throwOnCreate }),
            }),
          ],
    ),
    platformRedactor: noSecretsRedactor(),
  });

describe('an integration nobody has', () => {
  it('resolves to null rather than throwing, so the endpoint can answer 404 and write nothing', async () => {
    expect(await loaderFor(null).forIntegration(INTEGRATION)).toBeNull();
  });
});

describe('an integration nobody has bound', () => {
  it('resolves to an account with no bindings, which is a different fact from having no row', async () => {
    const resolved = await loaderFor(accountOf({ bindings: [] })).forIntegration(INTEGRATION);
    expect(resolved).not.toBeNull();
    expect(resolved?.bindings).toEqual([]);
    // The delivery is still verifiable: the credential belongs to the account, not to a project.
    expect(resolved?.inbound).not.toBeNull();
  });
});

describe('the two adapters', () => {
  it('builds the account one from `integrations.config` and each binding from its own merge', async () => {
    const built: { config: JsonObject; redactor: SecretRedactor }[] = [];
    const account = accountOf({
      bindings: [
        {
          bindingId: '00000000-0000-4000-8000-0000000000f1' as Id,
          projectId: PROJECT_A,
          config: { pickup_label: 'agentic-a' },
        },
        {
          bindingId: '00000000-0000-4000-8000-0000000000f2' as Id,
          projectId: PROJECT_B,
          config: { pickup_label: 'agentic-b' },
        },
      ],
    });

    const resolved = await loaderFor(account, { built }).forIntegration(INTEGRATION);

    expect(resolved?.bindings.map((binding) => binding.projectId)).toEqual([PROJECT_A, PROJECT_B]);
    // Authenticity is the **account's** question and meaning is the **project's**, so the pick-up
    // rule a project overrides must not decide which deliveries the account accepts.
    expect(built.map((entry) => entry.config.pickup_label)).toEqual([
      'agentic',
      'agentic-a',
      'agentic-b',
    ]);
  });

  it('gives every adapter a redactor over the account’s own resolved credentials', async () => {
    const built: { config: JsonObject; redactor: SecretRedactor }[] = [];

    await loaderFor(accountOf(), { built }).forIntegration(INTEGRATION);

    // The registration composes none of its own, so this is the loader's — and it is what finds
    // the binding's secret in a `X-Gitlab-Token` header on the way to `inbox.headers`.
    for (const entry of built) {
      const redacted = entry.redactor.redactText(`token ${WEBHOOK_SECRET} here`);
      expect(redacted.value).not.toContain(WEBHOOK_SECRET);
      expect(redacted.value).toContain(
        `[REDACTED:integration:probe:${INTEGRATION}:webhook_secret]`,
      );
      expect(redacted.count).toBe(1);
    }
  });

  it('reports no inbound half rather than pretending one, for a provider that has none', async () => {
    const resolved = await loaderFor(accountOf(), { withInbound: false }).forIntegration(
      INTEGRATION,
    );
    expect(resolved?.inbound).toBeNull();
    // And no bindings are built either: they could normalise nothing.
    expect(resolved?.bindings).toEqual([]);
  });
});

describe('an integration whose adapter cannot be built', () => {
  it('throws for a provider this build does not register', async () => {
    await expect(
      loaderFor(accountOf(), { registered: false }).forIntegration(INTEGRATION),
    ).rejects.toBeInstanceOf(BindingLoadError);
  });

  it('throws when the credentials cannot be read, and names no value', async () => {
    const loader = loaderFor(accountOf(), {
      secrets: secretsOf(new SecretResolutionError('row is missing', [])),
    });
    await expect(loader.forIntegration(INTEGRATION)).rejects.toThrow(
      /credentials that cannot be read/,
    );
  });

  it('throws when the merged config fails the provider’s schema, quoting the paths and never the values', async () => {
    const loader = loaderFor(accountOf({ config: {} }));
    const thrown = await loader.forIntegration(INTEGRATION).catch((error: Error) => error);

    expect((thrown as Error).message).toContain('fails its schema at: pickup_label');
    // The merged document holds the credential, so the *paths* are the only safe thing to quote.
    // Asserted positively on the string rather than with `rejects.not.toThrow`, which passes
    // whenever the call rejects at all.
    expect((thrown as Error).message).not.toContain(WEBHOOK_SECRET);
  });

  it('throws when the adapter itself refuses to be instantiated', async () => {
    await expect(
      loaderFor(accountOf(), { throwOnCreate: true }).forIntegration(INTEGRATION),
    ).rejects.toThrow(/could not be instantiated/);
  });
});
