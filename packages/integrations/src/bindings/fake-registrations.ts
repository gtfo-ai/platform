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
import type {
  CommunicationPort,
  GitProviderPort,
  InboundNormaliser,
  SecretRedactor,
  TaskManagementPort,
  WebhookDelivery,
} from '@platform/application';
import * as z from 'zod';
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

export const fakeGitRegistration = (
  options: FakeRegistrationOptions<GitProviderPort>,
): AnyProviderRegistration => ({
  id: FAKE_GIT_PROVIDER_ID,
  type: 'git',
  displayName: 'Fake git provider (in-memory)',
  configSchema: z.strictObject({
    project: z.string().regex(/^[^/\s]+(\/[^/\s]+)+$/, 'expected a namespace/project path'),
    token: z.string().min(1),
  }),
  secretFields: ['token'],
  setupGuidePath: 'packages/integrations/src/git/fake.ts',
  agentTooling: null,
  // The same declaration the real git provider carries (TD-026), so a tier that fetches a mirror
  // through this registration resolves its credential the way production does rather than through a
  // shape only the fake has (standing rule 1).
  gitCredential: { passwordField: 'token', username: 'agentic' },
  create: ({ secrets, redactor }) => {
    refuseWrongToken(FAKE_GIT_PROVIDER_ID, options.token, secrets.token);
    return withInboundRedactor(options.port, redactor);
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

export const fakeTaskManagementRegistration = (
  options: FakeRegistrationOptions<TaskManagementPort>,
): AnyProviderRegistration => ({
  id: FAKE_TASK_MANAGEMENT_PROVIDER_ID,
  type: 'task_management',
  displayName: 'Fake task management provider (in-memory)',
  configSchema: z.strictObject({ token: z.string().min(1) }),
  secretFields: ['token'],
  setupGuidePath: 'packages/integrations/src/task-management/fake.ts',
  agentTooling: null,
  create: ({ secrets, redactor }) => {
    refuseWrongToken(FAKE_TASK_MANAGEMENT_PROVIDER_ID, options.token, secrets.token);
    return withInboundRedactor(options.port, redactor);
  },
});
