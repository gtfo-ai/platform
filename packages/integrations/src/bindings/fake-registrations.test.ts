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
import { createFakeTaskManagement } from '../task-management/fake.js';
import {
  fakeErrorsRegistration,
  fakeGitRegistration,
  fakeLogsRegistration,
  fakeTaskManagementRegistration,
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

/**
 * WP-110: the binding's config decides whether a fake polls, as GitLab's and Jira's do — so a tier
 * switches polling on in `bindings.config` and the sweep's query over that column is on the path.
 */
describe('the fake registrations’ poll plans (WP-110)', () => {
  it('answers the git poll plan from the binding’s config, off by default', async () => {
    const { fake } = await setUp();
    const create = (config: Record<string, unknown>) =>
      fakeGitRegistration({ port: fake, token: TOKEN }).create({
        integrationId: INTEGRATION_ID,
        config: { project: 'acme/api', token: TOKEN, ...config },
        secrets: { token: TOKEN },
        redactor: noSecretsRedactor(),
      }) as typeof fake;
    expect(create({}).pollPlan()).toBeNull();
    expect(create({ poll_enabled: true }).pollPlan()).toEqual({
      interval_seconds: 60,
      receives_webhooks: false,
    });
    expect(create({ poll_enabled: true, poll_interval_seconds: 30 }).pollPlan()).toEqual({
      interval_seconds: 30,
      receives_webhooks: false,
    });
    // WP-123: a binding a webhook reaches says so, and the poller makes neither poll-only read.
    expect(create({ poll_enabled: true, receives_webhooks: true }).pollPlan()).toEqual({
      interval_seconds: 60,
      receives_webhooks: true,
    });
    expect(() => create({ poll_enabled: true, poll_interval_seconds: 5 })).toThrow();
  });

  it('polls a status rule when the binding names one, as Jira’s status wins over its label', () => {
    const tickets = createFakeTaskManagement({ integrationId: INTEGRATION_ID });
    const create = (config: Record<string, unknown>) =>
      fakeTaskManagementRegistration({ port: tickets, token: TOKEN }).create({
        integrationId: INTEGRATION_ID,
        config: { token: TOKEN, poll_enabled: true, ...config },
        secrets: { token: TOKEN },
        redactor: noSecretsRedactor(),
      }) as typeof tickets;
    expect(create({}).pollPlan()?.rule).toEqual({ kind: 'label', label: 'agentic' });
    expect(create({ pickup_status: 'Ready for agent' }).pollPlan()?.rule).toEqual({
      kind: 'status',
      status: 'Ready for agent',
    });
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

  it('answers resolve-on-merge from the binding’s config, off unless it is set (WP-111)', () => {
    const errors = fakeErrorsRegistration({
      // The prebuilt fake says `true`; the binding's config is what must win, both ways.
      port: createFakeObservabilityErrors({ integrationId: INTEGRATION_ID, resolveOnMerge: true }),
      token: TOKEN,
    });
    const flagOf = (config: Record<string, unknown>) =>
      (errors.create(input(config)) as { resolveOnMerge(): boolean }).resolveOnMerge();
    expect(flagOf({ token: TOKEN })).toBe(false);
    expect(flagOf({ token: TOKEN, resolve_on_merge: false })).toBe(false);
    expect(flagOf({ token: TOKEN, resolve_on_merge: true })).toBe(true);
    expect(errors.configSchema.safeParse({ token: TOKEN, resolve_on_merge: 'yes' }).success).toBe(
      false,
    );
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
