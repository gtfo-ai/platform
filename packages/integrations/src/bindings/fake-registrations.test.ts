/**
 * The fake registrations honour the loader's redactor — WP-73b, PROGRESS backlog 260.
 *
 * `create` used to return the prebuilt fake and drop `input.redactor`, so a fake's normalised
 * inbound **event** carried what the `inbox` row had redacted. Asserted here on the event a
 * registration-built fake produces, both ways (rule 42): the planted value is gone and the
 * placeholder is present when the redactor holds it, and the same delivery normalised by the
 * fake built directly still carries it — so the wrapper, not the fake, is what redacts.
 */

import { exactSecretRedactor, noSecretsRedactor } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createFakeObservabilityErrors } from '../errors/fake.js';
import { createFakeGitProvider } from '../git/fake.js';
import { createFakeObservabilityLogs } from '../logs/fake.js';
import {
  fakeErrorsRegistration,
  fakeGitRegistration,
  fakeLogsRegistration,
} from './fake-registrations.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000f7' as Id;
const PROJECT_ID = '00000000-0000-4000-8000-0000000000f8' as Id;
const TOKEN = 'FAKE-registration-token-0123456789';
const PLANTED = 'FAKE0planted0value0in0a0comment0';

const context = {
  projectId: PROJECT_ID,
  integrationId: INTEGRATION_ID,
  resolveUser: () => null,
  resolveThread: async () => null,
};

const setUp = async () => {
  const fake = createFakeGitProvider({
    integrationId: INTEGRATION_ID,
    projects: [{ path: 'acme/api', defaultBranch: 'main' }],
    clockStart: '2026-09-27T10:00:00.000Z' as IsoDateTime,
  });
  const mr = await fake.openMergeRequest({
    project: 'acme/api',
    branch: 'agentic/acme-1',
    target: 'main',
    title: 'Draft: a change',
    description: '',
    draft: true,
    labels: [],
    reviewers: [],
    remove_source_branch: true,
  });
  const delivery = fake.emitReviewComment({
    project: 'acme/api',
    iid: mr.ref.iid,
    discussionId: 'disc-1',
    authorId: 'someone',
    text: `pushed with ${PLANTED}`,
  });
  return { fake, delivery };
};

const textOf = (result: { events: readonly { payload: unknown }[] }): string =>
  JSON.stringify(result.events[0]?.payload);

describe('the fake git registration (backlog 260)', () => {
  it('applies the loader’s redactor to the body before the fake’s normaliser reads it', async () => {
    const { fake, delivery } = await setUp();
    const port = fakeGitRegistration({ port: fake, token: TOKEN }).create({
      integrationId: INTEGRATION_ID,
      config: { project: 'acme/api', token: TOKEN },
      secrets: { token: TOKEN },
      redactor: exactSecretRedactor([{ name: 'planted', value: PLANTED }]),
    }) as typeof fake;

    // Verified against the bytes that were sent: the signature is over the original body.
    expect(port.inbound.verify(delivery)).toBe(true);
    const normalised = await port.inbound.normalise(delivery, context);
    expect(normalised.events.map((event) => event.type)).toEqual(['mr.review.comment']);
    expect(textOf(normalised)).not.toContain(PLANTED);
    expect(textOf(normalised)).toContain('[REDACTED');
    // Everything else is the fake's own: the proxy forwards every other member.
    expect(port.ref).toEqual(fake.ref);
  });

  it('leaves the fake built directly as it was, so the redaction is the registration’s', async () => {
    const { fake, delivery } = await setUp();
    expect(textOf(await fake.inbound.normalise(delivery, context))).toContain(PLANTED);
  });
});

/** WP-89: the bug pre-fetch's two fakes go in the loader's door like every other binding. */
describe('the fake observability registrations (WP-89)', () => {
  const input = (config: Record<string, unknown>, token = TOKEN) => ({
    integrationId: INTEGRATION_ID,
    config,
    secrets: { token },
    redactor: noSecretsRedactor(),
  });

  it('refuses a credential that is not the one the secret store holds', () => {
    const errors = fakeErrorsRegistration({
      port: createFakeObservabilityErrors({ integrationId: INTEGRATION_ID }),
      token: TOKEN,
    });
    expect(() => errors.create(input({ token: 'wrong' }, 'wrong'))).toThrow(/not the one/);
    expect(errors.create(input({ token: TOKEN }))).toBeDefined();
  });

  it('answers the excerpt selector from the binding’s config, and refuses one the fake cannot parse', () => {
    const logs = fakeLogsRegistration({
      port: createFakeObservabilityLogs({ integrationId: INTEGRATION_ID }),
      token: TOKEN,
    });
    const configured = logs.create(input({ token: TOKEN, excerpt_selector: '{app="api"}' }));
    expect((configured as { excerptSelector(): string | null }).excerptSelector()).toBe(
      '{app="api"}',
    );
    const unconfigured = logs.create(input({ token: TOKEN }));
    expect((unconfigured as { excerptSelector(): string | null }).excerptSelector()).toBeNull();
    expect(logs.configSchema.safeParse({ token: TOKEN, excerpt_selector: 'app=api' }).success).toBe(
      false,
    );
  });
});
