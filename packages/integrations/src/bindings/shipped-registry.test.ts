/**
 * Backlog 550 through the **real** composition: the pipeline's `ticketReads` over the Jira adapter
 * built by `createPipelineProviderRegistry`, on one real executor with the production rate-limit
 * resolver — the same executor instance on both layers and the same `integrations.id`, which is
 * what `apps/server/src/pipeline.ts` composes. Only the transport is scripted (a global `fetch`
 * stub); the clock is a virtual timer, so a token wait costs no wall time.
 *
 * Before the fix the pipeline's call held a limiter slot across `perform` while the adapter's own
 * call inside it waited for a second slot of the same limiter, with no deadline: `maxConcurrent`
 * concurrent reads held every slot and none settled. The wall-clock race below bounds that so it
 * fails by name. **Canary:** make `isReentrant` in `action-executor.ts` answer `false` and the first
 * case fails on `'deadlocked'`.
 */
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  DEFAULT_RATE_LIMIT_POLICY,
  noSecretsRedactor,
  type PipelineIntegrations,
  ticketReads,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JIRA_CLOUD_RATE_LIMIT_POLICY } from '../providers/jira-cloud/index.js';
import { createPipelineProviderRegistry, pipelineRateLimitPolicy } from './shipped-registry.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000550a1';
const SELF = '557058:00000000-0000-4000-8000-0000000b0550';
const DEADLOCK_BOUND_MS = 2_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

const settledWithin = async <T>(calls: Promise<T>): Promise<T | 'deadlocked'> => {
  let bound: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadlocked'>((resolve) => {
    bound = setTimeout(() => resolve('deadlocked'), DEADLOCK_BOUND_MS);
  });
  try {
    return await Promise.race([calls, deadline]);
  } finally {
    clearTimeout(bound);
  }
};

const composeJira = () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response(JSON.stringify({ accountId: SELF, displayName: 'Agentic Platform' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const audit = createMemoryAuditLog();
  const timer = createVirtualTimer({ autoAdvance: true });
  const clock = fixedClock('2026-10-09T09:00:00.000Z', 0);
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: audit,
    redactor: noSecretsRedactor(),
    timer,
    clock,
    rateLimits: pipelineRateLimitPolicy,
  });
  const registry = createPipelineProviderRegistry({ executor, clock, timer });
  const port = registry.get('task_management', 'jira-cloud').create({
    integrationId: INTEGRATION_ID,
    config: {
      site_url: 'https://acme-example.atlassian.net',
      user_email: 'agentic-bot@example.test',
      project_keys: ['ACME'],
    },
    secrets: { api_token: 'FAKE-jira-api-token-0550' },
    redactor: noSecretsRedactor(),
  });
  const integrations: PipelineIntegrations = {
    executor,
    git: null,
    // The loader's shape: the pipeline's ref **is** the adapter's (`loader.ts`).
    taskManagement: { port, ref: port.ref, redactor: noSecretsRedactor() },
    communication: null,
  };
  return { integrations, audit, timer, requests };
};

describe('a pipeline call through the shipped Jira registration (backlog 550)', () => {
  it('maxConcurrent + 1 concurrent reads on one binding all settle, one slot and one token each', async () => {
    const { integrations, audit, timer, requests } = composeJira();
    const callers = JIRA_CLOUD_RATE_LIMIT_POLICY.maxConcurrent + 1;
    // Within the burst only if each read spends one token: two each would sleep for a refill.
    expect(callers).toBeLessThanOrEqual(JIRA_CLOUD_RATE_LIMIT_POLICY.capacity);

    const settled = await settledWithin(
      Promise.all(
        Array.from({ length: callers }, () =>
          ticketReads(integrations).selfIdentity({ projectId: null, taskId: null }),
        ),
      ),
    );

    expect(settled, 'every read settles').not.toBe('deadlocked');
    expect(settled).toEqual(
      Array.from({ length: callers }, () => expect.objectContaining({ external_id: SELF })),
    );
    expect(requests).toHaveLength(callers);
    expect(timer.sleeps, 'no read waited for a token').toEqual([]);
    // The audit is what it was: the pipeline's row and the adapter's, both `ok`, per read.
    expect(audit.entriesFor('self_identity').map((entry) => entry.status)).toEqual(
      Array.from({ length: callers * 2 }, () => 'ok'),
    );
  });

  it('gives Jira Cloud its own policy and every other provider the default', () => {
    const ref = { integrationId: INTEGRATION_ID, type: 'task_management', host: null } as const;
    expect(pipelineRateLimitPolicy({ ...ref, provider: 'jira-cloud' })).toBe(
      JIRA_CLOUD_RATE_LIMIT_POLICY,
    );
    expect(pipelineRateLimitPolicy({ ...ref, provider: 'gitlab', type: 'git' })).toBe(
      DEFAULT_RATE_LIMIT_POLICY,
    );
  });
});
