/**
 * The GitLab adapter driven **through** `IntegrationActionExecutor` (technical/06 § "Outbound:
 * actions").
 *
 * This file exists because of an obligation the executor's own docblock puts on the provider work
 * packages, verbatim:
 *
 * > a port method that changes provider state must be asserted to reach the executor as a
 * > `MutatingActionRequest`, by running it in shadow mode and asserting the provider was not
 * > entered.
 *
 * For a fake, "not entered" is a call log. For a real adapter it is stronger: **zero HTTP
 * requests**, observed on the transport the adapter was given. The 429 half proves the other
 * direction — that GitLab's documented rate-limit answer (`429` with `Retry-After` in seconds)
 * arrives as an `IntegrationRateLimitedError` and is waited out on the executor's injected timer,
 * never on a wall clock.
 *
 * It is also where the assertion lands that the contract suite's docblock calls a security
 * assertion rather than a behaviour one: a minted token must not appear in the audit row.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  type IntegrationActionRequest,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  type VirtualTimer,
} from '@platform/application';
import type { JsonObject, TaskMode } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLOCK_AT, GITLAB_PROJECT } from '../support/integrations/gitlab-fixtures.js';
import { gitlabReplayContext } from '../support/integrations/gitlab-harness.js';
import {
  loadReplayFixture,
  type ReplayInteraction,
} from '../support/integrations/gitlab-replay.js';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b9';
const TASK_ID = '00000000-0000-4000-8000-0000000000c9';
const MINTED_TOKEN = 'FAKE-project-access-token-DO-NOT-USE';
const OPEN_MR_KEY = 'POST /projects/acme%2Fapi/merge_requests';

/**
 * The recorded 201, taken from the same file the contract run uses rather than restated, so this
 * test cannot drift away from the fixture everything else is held to.
 */
const recordedCreated = (): ReplayInteraction => {
  const created = loadReplayFixture('merge-requests').find(
    (interaction) =>
      interaction.method === 'POST' &&
      interaction.path === '/projects/acme%2Fapi/merge_requests' &&
      interaction.status === 201,
  );
  if (created === undefined) {
    throw new Error('the recorded 201 for POST /merge_requests is missing');
  }
  return created;
};

/**
 * GitLab.com answers `429` and documents `Retry-After` as "seconds until the quota is reset"
 * (<https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/#response-headers>,
 * retrieved 2026-09-10). The header names and the status are documented; the numbers are
 * illustrative and marked as such.
 */
const rateLimited = (retryAfterSeconds: string): ReplayInteraction => ({
  method: 'POST',
  path: '/projects/acme%2Fapi/merge_requests',
  status: 429,
  headers: {
    'retry-after': retryAfterSeconds,
    'ratelimit-limit': '2000',
    'ratelimit-observed': '2001',
    'ratelimit-remaining': '0',
    'ratelimit-reset': '1780000000',
  },
  body: { message: 'Retry later' },
  source: {
    url: 'https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/#response-headers',
    retrieved: '2026-09-10',
    kind: 'documented',
    note: 'Header names and the 429 status are documented; the values are illustrative.',
  },
});

describe('GitLab through IntegrationActionExecutor', () => {
  let auditLog: MemoryIntegrationAuditLog;
  let timer: VirtualTimer;

  beforeEach(() => {
    auditLog = createMemoryAuditLog();
    timer = createVirtualTimer({ autoAdvance: true });
  });

  const executor = () =>
    createIntegrationActionExecutor({
      auditLog,
      redactor: noSecretsRedactor(),
      timer,
      clock: fixedClock(CLOCK_AT),
      rateLimits: { capacity: 100, refillPerSecond: 100, maxConcurrent: 4 },
    });

  const openRequest = (
    context: ReturnType<typeof gitlabReplayContext>,
    mode: TaskMode,
  ): IntegrationActionRequest<JsonObject> => ({
    integration: context.port.ref,
    action: 'open_merge_request',
    mutating: true,
    mode,
    payload: { project: GITLAB_PROJECT, branch: 'agentic/task-2' },
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    perform: async () => {
      const opened = await context.port.openMergeRequest({
        project: GITLAB_PROJECT,
        branch: 'agentic/task-2',
        target: 'main',
        title: 'Draft: add the parser',
        description: 'Requested by a human, linked to the task.',
        draft: true,
        labels: ['agentic'],
        reviewers: [],
        remove_source_branch: true,
      });
      return { iid: opened.ref.iid };
    },
    shadowResult: () => ({ would_have: 'open_merge_request' }),
    describeResult: (result) => result,
  });

  it('performs a mutating action in normal mode and issues exactly one request', async () => {
    const context = gitlabReplayContext();

    const outcome = await executor().execute(openRequest(context, 'normal'));

    expect(outcome.status).toBe('ok');
    expect(
      context.replay.requests.map((request) => request.key),
      'exactly one POST reached the provider',
    ).toEqual([OPEN_MR_KEY]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok']);
  });

  it('records would_have in shadow mode and issues no HTTP request at all', async () => {
    const context = gitlabReplayContext();

    const outcome = await executor().execute(openRequest(context, 'shadow'));

    expect(outcome.status, 'a mutating action in shadow mode is never performed').toBe(
      'would_have',
    );
    expect(
      context.replay.requests,
      'shadow mode reached no GitLab endpoint, not even a read',
    ).toEqual([]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['would_have']);
    expect(auditLog.events, 'nothing was performed, so nothing is announced').toEqual([]);
  });

  it("waits GitLab's documented Retry-After on the executor's timer and retries", async () => {
    const context = gitlabReplayContext();
    context.replay.script([rateLimited('2'), recordedCreated()]);

    const outcome = await executor().execute(openRequest(context, 'normal'));

    expect(outcome.status).toBe('ok');
    expect(outcome.attempts, 'one refusal plus one success').toBe(2);
    expect(timer.sleeps, 'waited exactly what GitLab asked for, in milliseconds').toEqual([2000]);
    expect(
      context.replay.requests.map((request) => request.key),
      'the adapter itself was entered twice, so the 429 came from a provider and not a lambda',
    ).toEqual([OPEN_MR_KEY, OPEN_MR_KEY]);
    expect(auditLog.entries[0]?.attempts).toBe(2);
  });

  it('never puts the minted token in the audit row (BD-002, TD-012)', async () => {
    const context = gitlabReplayContext();

    const outcome = await executor().execute({
      integration: context.port.ref,
      action: 'mint_credential',
      mutating: true,
      mode: 'normal',
      payload: { project: GITLAB_PROJECT, scope: 'push', ttl_seconds: 3600 },
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      perform: async () =>
        context.port.mintCredential({
          project: GITLAB_PROJECT,
          scope: 'push',
          branchPatterns: ['agentic/*'],
          ttlSeconds: 3600,
        }),
      shadowResult: () => ({
        username: null,
        value: '',
        scope: 'push' as const,
        branchPatterns: [],
        expiresAt: CLOCK_AT,
        revokeId: null,
      }),
      // The evidence a mint leaves is the handle and the expiry — never the value (BD-003).
      describeResult: (credential) => ({
        revoke_id: credential.revokeId,
        expires_at: credential.expiresAt,
        scope: credential.scope,
      }),
    });

    expect(outcome.result.value, 'the caller still gets the credential').toBe(MINTED_TOKEN);
    expect(
      JSON.stringify(auditLog.entries),
      'the audit row must not carry the token',
    ).not.toContain(MINTED_TOKEN);
    expect(JSON.stringify(auditLog.events), 'nor may the event').not.toContain(MINTED_TOKEN);
  });
});
