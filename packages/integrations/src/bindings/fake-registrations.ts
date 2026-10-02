/**
 * The registry half of the fakes (technical/10: "the fakes are not test scaffolding").
 *
 * WP-07 shipped an in-memory fake per type and every later tier has used them by *constructing*
 * one. WP-15a made the composition root read the `bindings` table instead, so a tier that wants a
 * fake provider now has to go in the same door a real one does: a **registration**, resolved by
 * provider id, handed a validated config and a decrypted credential.
 *
 * That is the point of this file rather than an inconvenience. With it, the `e2e-fake-claude` tier
 * exercises the loader, the secret store's decryption, the strict config parse and the redactor
 * composition as production code, and only the thing on the far side of the HTTP call is a double —
 * which is exactly the boundary technical/10 draws for that tier.
 *
 * ## The credential is checked, not ignored
 *
 * `create` refuses when the resolved credential is not the one the caller said to expect. A
 * registration that shrugged at an absent or wrong token would let a whole e2e pass with the secret
 * store deleted, which is standing rule 18 with a credential in it: the empty case must not be the
 * permissive one. The check is a plain equality against a value the caller supplies, so a test that
 * seeds one credential and expects another fails at the binding rather than four stages later.
 */
import {
  type CommunicationPort,
  DEFAULT_TICKET_POLL_INTERVAL_SECONDS,
  type GitProviderPort,
  type InboundNormaliser,
  MAX_TICKET_POLL_INTERVAL_SECONDS,
  type MergeRequestPollPlan,
  MIN_TICKET_POLL_INTERVAL_SECONDS,
  type ObservabilityErrorsPort,
  type ObservabilityLogsPort,
  type SecretRedactor,
  type TaskManagementPort,
  TICKET_POLL_CONFIG_KEYS,
  type TicketPollPlan,
  type WebhookDelivery,
} from '@platform/application';
import * as z from 'zod';
import { isFakeLogSelector } from '../logs/fake.js';
import type { AnyProviderRegistration } from '../registry.js';

/**
 * The delivery body as the adapter's normaliser may read it: the loader's redactor applied to the
 * **whole** body first, as GitLab, Jira and Slack do (`gitlab/inbound.ts`, `jira-cloud/webhook.ts`,
 * `slack/inbound.ts`). JSON is redacted as JSON so a placeholder never breaks the document; a body
 * that is not JSON is redacted as text and left for the normaliser to refuse as malformed.
 */
const redactedBody = (body: string, redactor: SecretRedactor): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return redactor.redactText(body).value;
  }
  return JSON.stringify(redactor.redactJson(parsed as never).value);
};

/**
 * **The loader's redactor, honoured** (WP-73b, PROGRESS backlog 260). Each fake is built once by
 * the test and its `inbound` normaliser is its own, so `create` used to hand back the prebuilt port
 * and drop `input.redactor` — and in the e2e tier a fake's normalised inbound **event** carried a
 * value the `inbox` row had redacted (WP-72 measured a `glpat-` value in `mr.review.comment`'s
 * `events.payload`). Production is not affected: every real adapter composes the redactor itself.
 *
 * What is wrapped is `normalise` alone. `verify` still reads the **original** body — a signature is
 * over the bytes that were sent — and `deliveryKey` is the fake's own (built from a header id, not
 * from the body), which is the divergence each fake's register now names.
 */
const withInboundRedactor = <TPort extends object>(
  port: TPort,
  redactor: SecretRedactor,
): TPort => {
  const inbound = (port as { inbound?: InboundNormaliser }).inbound;
  if (inbound === undefined) {
    return port;
  }
  const redacting: InboundNormaliser = {
    verify: (delivery) => inbound.verify(delivery),
    deliveryKey: (delivery) => inbound.deliveryKey(delivery),
    normalise: async (delivery: WebhookDelivery, context) =>
      inbound.normalise({ ...delivery, body: redactedBody(delivery.body, redactor) }, context),
  };
  return new Proxy(port, {
    get: (target, key, receiver) =>
      key === 'inbound' ? redacting : Reflect.get(target, key, receiver),
  });
};

export const FAKE_GIT_PROVIDER_ID = 'fake-git';
export const FAKE_TASK_MANAGEMENT_PROVIDER_ID = 'fake-task-management';

export interface FakeRegistrationOptions<TPort> {
  /** The already-built fake this binding resolves to. */
  readonly port: TPort;
  /** The credential the `secrets` row is expected to decrypt to, under the field `token`. */
  readonly token: string;
}

const refuseWrongToken = (providerId: string, expected: string, actual: unknown): void => {
  if (actual !== expected) {
    // Never the value: this message reaches a log and a test failure.
    throw new Error(
      `${providerId}: the binding was built with a credential that is not the one the secret store holds`,
    );
  }
};

/**
 * The fake git provider's binding config: the project, the credential, and — since WP-110 — the
 * merge-request polling switch under the platform's key names, so a tier that polls through this
 * registration switches it on in `bindings.config` the way an operator switches GitLab's on.
 */
const fakeGitConfigSchema = z.strictObject({
  project: z.string().regex(/^[^/\s]+(\/[^/\s]+)+$/, 'expected a namespace/project path'),
  token: z.string().min(1),
  [TICKET_POLL_CONFIG_KEYS.enabled]: z.boolean().default(false),
  [TICKET_POLL_CONFIG_KEYS.intervalSeconds]: z
    .int()
    .min(MIN_TICKET_POLL_INTERVAL_SECONDS)
    .max(MAX_TICKET_POLL_INTERVAL_SECONDS)
    .default(DEFAULT_TICKET_POLL_INTERVAL_SECONDS),
});

/** The prebuilt git port, answering `pollPlan()` from **this binding's** config (WP-110). */
const withGitPollPlan = (port: GitProviderPort, config: unknown): GitProviderPort => {
  const parsed = fakeGitConfigSchema.parse(config);
  const plan: MergeRequestPollPlan | null = parsed.poll_enabled
    ? { interval_seconds: parsed.poll_interval_seconds }
    : null;
  return new Proxy(port, {
    get: (target, key, receiver) =>
      key === 'pollPlan' ? () => plan : Reflect.get(target, key, receiver),
  });
};

export const fakeGitRegistration = (
  options: FakeRegistrationOptions<GitProviderPort>,
): AnyProviderRegistration => ({
  id: FAKE_GIT_PROVIDER_ID,
  type: 'git',
  displayName: 'Fake git provider (in-memory)',
  configSchema: fakeGitConfigSchema,
  secretFields: ['token'],
  setupGuidePath: 'packages/integrations/src/git/fake.ts',
  agentTooling: null,
  // The same declaration the real git provider carries (TD-026), so a tier that fetches a mirror
  // through this registration resolves its credential the way production does rather than through a
  // shape only the fake has (standing rule 1).
  gitCredential: { passwordField: 'token', username: 'agentic' },
  // WP-80: the fake's minted values have a declared prefix and an alphanumeric tail, as the real git
  // provider's do, so the loader admits its minting on the same declaration production needs.
  credentialMinting: {
    shape: 'stable',
    // WP-107: the fake's own words, so a test that reads a refusal reads a provider's sentence.
    hints: {
      enable: 'fake git: build the fake with `capabilities.credentialMinting` set',
      shape: 'fake git: the fake declares its prefix as `credentialPrefix`',
    },
  },
  create: ({ config, secrets, redactor }) => {
    refuseWrongToken(FAKE_GIT_PROVIDER_ID, options.token, secrets.token);
    return withGitPollPlan(withInboundRedactor(options.port, redactor), config);
  },
});

export const FAKE_COMMUNICATION_PROVIDER_ID = 'fake-communication';

/**
 * The chat fake, as a registration (WP-32).
 *
 * `channel` is in the config schema and declared through `communicationChannels`, exactly as
 * Slack's is, so the e2e tier exercises the **loader's** channel resolution rather than a shape
 * only a test has: the registry's boot-time check, the strict config parse and the refusal of a
 * binding with no channel are all production code on this path.
 */
export const fakeCommunicationRegistration = (
  options: FakeRegistrationOptions<CommunicationPort>,
): AnyProviderRegistration => ({
  id: FAKE_COMMUNICATION_PROVIDER_ID,
  type: 'communication',
  displayName: 'Fake chat provider (in-memory)',
  configSchema: z.strictObject({
    channel: z.string().min(1),
    digest_channel: z.string().min(1).nullish(),
    token: z.string().min(1),
  }),
  secretFields: ['token'],
  setupGuidePath: 'packages/integrations/src/communication/fake.ts',
  agentTooling: null,
  communicationChannels: { channel: 'channel', digestChannel: 'digest_channel' },
  create: ({ secrets, redactor }) => {
    refuseWrongToken(FAKE_COMMUNICATION_PROVIDER_ID, options.token, secrets.token);
    return withInboundRedactor(options.port, redactor);
  },
});

/**
 * The fake task manager's binding config (WP-87): the credential, and the polling switch under the
 * platform's own key names with Jira's pick-up label beside it, so a tier that polls through this
 * registration switches it on the way an operator does — in `bindings.config` — and the sweep's
 * query over that column is production code on the path.
 */
const fakeTaskManagementConfigSchema = z.strictObject({
  token: z.string().min(1),
  [TICKET_POLL_CONFIG_KEYS.enabled]: z.boolean().default(false),
  [TICKET_POLL_CONFIG_KEYS.intervalSeconds]: z
    .int()
    .min(MIN_TICKET_POLL_INTERVAL_SECONDS)
    .max(MAX_TICKET_POLL_INTERVAL_SECONDS)
    .default(DEFAULT_TICKET_POLL_INTERVAL_SECONDS),
  pickup_label: z.string().min(1).default('agentic'),
  /**
   * WP-110 (backlog 298): a **status** pick-up rule, which wins over the label as Jira's does
   * (`pickupRuleOf`) — so a tier can poll the rule a status mapping moves a ticket out of.
   */
  pickup_status: z.string().min(1).nullish(),
  /**
   * WP-122 pre-review round: the binding's declared scope, Jira's `project_keys` — what
   * `ticketScope` answers from, so a tier can set it the way an operator does.
   */
  project_keys: z.array(z.string().min(1)).default([]),
});

/** The plan the binding's config states — `null` unless it switched polling on. */
const fakePollPlanOf = (config: unknown): TicketPollPlan | null => {
  const parsed = fakeTaskManagementConfigSchema.parse(config);
  if (!parsed.poll_enabled) {
    return null;
  }
  return {
    rule:
      typeof parsed.pickup_status === 'string'
        ? { kind: 'status', status: parsed.pickup_status }
        : { kind: 'label', label: parsed.pickup_label },
    interval_seconds: parsed.poll_interval_seconds,
  };
};

/** {@link TaskManagementPort.ticketScope} as Jira answers it, from this binding's `project_keys`. */
const fakeTicketScopeOf =
  (config: unknown): TaskManagementPort['ticketScope'] =>
  (ticketKey) => {
    const keys = fakeTaskManagementConfigSchema.parse(config).project_keys;
    if (keys.length === 0) {
      return { kind: 'unscoped' };
    }
    return keys.includes(ticketKey.split('-')[0] ?? ticketKey)
      ? { kind: 'in_scope' }
      : { kind: 'out_of_scope', scope: [...keys] };
  };

/**
 * The prebuilt port, answering `pollPlan()` and `ticketScope()` from **this binding's** config
 * rather than its own.
 */
const withBindingConfig = (port: TaskManagementPort, config: unknown): TaskManagementPort => {
  const plan: TicketPollPlan | null = fakePollPlanOf(config);
  const ticketScope = fakeTicketScopeOf(config);
  return new Proxy(port, {
    get: (target, key, receiver) =>
      key === 'pollPlan'
        ? () => plan
        : key === 'ticketScope'
          ? ticketScope
          : Reflect.get(target, key, receiver),
  });
};

export const fakeTaskManagementRegistration = (
  options: FakeRegistrationOptions<TaskManagementPort>,
): AnyProviderRegistration => ({
  id: FAKE_TASK_MANAGEMENT_PROVIDER_ID,
  type: 'task_management',
  displayName: 'Fake task management provider (in-memory)',
  configSchema: fakeTaskManagementConfigSchema,
  secretFields: ['token'],
  setupGuidePath: 'packages/integrations/src/task-management/fake.ts',
  agentTooling: null,
  create: ({ config, secrets, redactor }) => {
    refuseWrongToken(FAKE_TASK_MANAGEMENT_PROVIDER_ID, options.token, secrets.token);
    return withBindingConfig(withInboundRedactor(options.port, redactor), config);
  },
});

export const FAKE_ERRORS_PROVIDER_ID = 'fake-errors';
export const FAKE_LOGS_PROVIDER_ID = 'fake-logs';

/**
 * The error-tracker fake, as a registration (WP-89): the bug pre-fetch reads a project's errors
 * binding through the loader like every other binding, so the e2e tier's Sentry double goes in the
 * same door — the rows, the decryption, the strict config parse and the redactor composition are
 * production code, and only the far side of the HTTP call is a double.
 *
 * `resolve_on_merge` is **binding** configuration, as it is for Sentry (WP-111), so the port
 * answers `resolveOnMerge()` from the binding's config rather than from the prebuilt fake — the
 * shape the log store's `excerptSelector()` has below — off unless the binding sets it.
 */
export const fakeErrorsRegistration = (
  options: FakeRegistrationOptions<ObservabilityErrorsPort>,
): AnyProviderRegistration => {
  const configSchema = z.strictObject({
    token: z.string().min(1),
    resolve_on_merge: z.boolean().default(false),
  });
  return {
    id: FAKE_ERRORS_PROVIDER_ID,
    type: 'errors',
    displayName: 'Fake error tracker (in-memory)',
    configSchema,
    secretFields: ['token'],
    setupGuidePath: 'packages/integrations/src/errors/fake.ts',
    agentTooling: null,
    create: ({ config, secrets }) => {
      refuseWrongToken(FAKE_ERRORS_PROVIDER_ID, options.token, secrets.token);
      const resolveOnMerge = configSchema.parse(config).resolve_on_merge;
      return new Proxy(options.port, {
        get: (target, key, receiver) =>
          key === 'resolveOnMerge' ? () => resolveOnMerge : Reflect.get(target, key, receiver),
      });
    },
  };
};

/**
 * The log-store fake, as a registration (WP-89). `excerpt_selector` is **binding** configuration,
 * as it is for Loki, so the port answers `excerptSelector()` from the binding's config rather than
 * from the prebuilt fake — the shape `withBindingConfig` gives the task manager — and a selector this
 * fake's grammar cannot parse is refused at the config parse, as Loki refuses one.
 */
export const fakeLogsRegistration = (
  options: FakeRegistrationOptions<ObservabilityLogsPort>,
): AnyProviderRegistration => {
  const configSchema = z.strictObject({
    token: z.string().min(1),
    excerpt_selector: z
      .string()
      .refine(isFakeLogSelector, { message: 'expected {label="value", …}' })
      .nullish(),
  });
  return {
    id: FAKE_LOGS_PROVIDER_ID,
    type: 'logs',
    displayName: 'Fake log store (in-memory)',
    configSchema,
    secretFields: ['token'],
    setupGuidePath: 'packages/integrations/src/logs/fake.ts',
    agentTooling: null,
    create: ({ config, secrets }) => {
      refuseWrongToken(FAKE_LOGS_PROVIDER_ID, options.token, secrets.token);
      const selector = configSchema.parse(config).excerpt_selector ?? null;
      return new Proxy(options.port, {
        get: (target, key, receiver) =>
          key === 'excerptSelector' ? () => selector : Reflect.get(target, key, receiver),
      });
    },
  };
};
