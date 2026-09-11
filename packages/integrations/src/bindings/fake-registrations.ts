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
import type { GitProviderPort, TaskManagementPort } from '@platform/application';
import * as z from 'zod';
import type { AnyProviderRegistration } from '../registry.js';

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
  create: ({ secrets }) => {
    refuseWrongToken(FAKE_GIT_PROVIDER_ID, options.token, secrets.token);
    return options.port;
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
  create: ({ secrets }) => {
    refuseWrongToken(FAKE_TASK_MANAGEMENT_PROVIDER_ID, options.token, secrets.token);
    return options.port;
  },
});
