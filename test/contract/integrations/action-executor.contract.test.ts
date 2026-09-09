/**
 * The five fakes driven **through** `IntegrationActionExecutor` (technical/06 § "Outbound:
 * actions", technical/10 contract tier).
 *
 * Why this file exists. Every fake's divergence register justifies "no quota unless a test scripts
 * one" by pointing at the executor's 429 branch — and until WP-07's review round 1 nothing
 * anywhere composed a fake with the executor. The executor's own unit tests drive lambdas, so five
 * registers were justifying a kindness with a test that did not exist. The rule that cost:
 * **a register entry that justifies a kindness by pointing at a test elsewhere must name a test
 * that exists.**
 *
 * Two things are asserted per provider, both positively:
 *
 *  - a scripted 429 is retried after the provider's `Retry-After` and the *fake* is entered twice
 *    (`core.calls`), so the assertion cannot pass against a harness that never reached the fake;
 *  - a mutating action in shadow mode writes a `would_have` row and the fake is entered **zero**
 *    times — the shadow guard proven end to end, through a provider, rather than against a lambda.
 *
 * No wall clock: backoff runs on `createVirtualTimer`, and the assertion is on the delay that was
 * asked for.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  type IntegrationActionRequest,
  IntegrationRateLimitedError,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  type VirtualTimer,
} from '@platform/application';
import type { JsonObject, TaskMode } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import {
  createFakeCommunication,
  createFakeGitProvider,
  createFakeObservabilityErrors,
  createFakeObservabilityLogs,
  createFakeTaskManagement,
  type FakeCore,
} from '@platform/integrations';
import { beforeEach, describe, expect, it } from 'vitest';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a7';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b7';
const TASK_ID = '00000000-0000-4000-8000-0000000000c7';

/** One provider, one action, and what calling it through the executor looks like. */
interface ExecutorCase {
  readonly name: string;
  /** The audit action name, which is also the name the fake's failure script is keyed by. */
  readonly action: string;
  readonly mutating: boolean;
  create(): Promise<{ readonly core: FakeCore; perform(): Promise<JsonObject> }>;
}

const cases: readonly ExecutorCase[] = [
  {
    name: 'task management — add_comment',
    action: 'add_comment',
    mutating: true,
    create: async () => {
      const port = createFakeTaskManagement({
        integrationId: INTEGRATION_ID,
        tickets: [{ key: 'FAKE-1', title: 'Totals are wrong', status: 'Ready for agent' }],
      });
      const ref = {
        provider: port.ref.provider,
        key: 'FAKE-1',
        url: 'https://tickets.example.test/browse/FAKE-1',
      };
      return {
        core: port.core,
        perform: async () => ({ comment_id: (await port.addComment(ref, 'hello')).comment_id }),
      };
    },
  },
  {
    name: 'git — open_merge_request',
    action: 'open_merge_request',
    mutating: true,
    create: async () => {
      const port = createFakeGitProvider({
        integrationId: INTEGRATION_ID,
        projects: [{ path: 'acme/api', defaultBranch: 'main' }],
      });
      return {
        core: port.core,
        perform: async () => ({
          iid: (
            await port.openMergeRequest({
              project: 'acme/api',
              branch: 'agentic/task-1',
              target: 'main',
              title: 'Draft: fix the totals',
              description: '',
              draft: true,
              labels: [],
              reviewers: [],
              remove_source_branch: true,
            })
          ).ref.iid,
        }),
      };
    },
  },
  {
    name: 'communication — post_task_thread',
    action: 'post_task_thread',
    mutating: true,
    create: async () => {
      const port = createFakeCommunication({
        integrationId: INTEGRATION_ID,
        channels: ['#agentic'],
      });
      return {
        core: port.core,
        perform: async () => ({
          thread_id: (
            await port.postTaskThread({
              channel: '#agentic',
              taskId: TASK_ID,
              body: { markdown: 'Task started.' },
            })
          ).thread_id,
        }),
      };
    },
  },
  {
    name: 'errors — comment',
    action: 'comment',
    mutating: true,
    create: async () => {
      const port = createFakeObservabilityErrors({
        integrationId: INTEGRATION_ID,
        issues: [{ id: 'issue-1', project: 'api', title: 'TypeError: totals' }],
      });
      return {
        core: port.core,
        perform: async () => ({ id: (await port.comment({ id: 'issue-1' }, 'Fixed by !7')).id }),
      };
    },
  },
  {
    name: 'logs — query_range (a read)',
    action: 'query_range',
    mutating: false,
    create: async () => {
      const port = createFakeObservabilityLogs({
        integrationId: INTEGRATION_ID,
        streams: [
          {
            labels: { app: 'api' },
            lines: [{ timestamp: '2026-06-01T09:10:00.000Z', line: 'GET /invoices/42 200' }],
          },
        ],
      });
      return {
        core: port.core,
        perform: async () => ({
          line_count: (
            await port.queryRange({
              selector: '{app="api"}',
              from: '2026-06-01T09:00:00.000Z',
              to: '2026-06-01T10:00:00.000Z',
              limit: 10,
            })
          ).line_count,
        }),
      };
    },
  },
];

describe('IntegrationActionExecutor composed with the provider fakes', () => {
  let auditLog: MemoryIntegrationAuditLog;
  let timer: VirtualTimer;

  beforeEach(() => {
    auditLog = createMemoryAuditLog();
    timer = createVirtualTimer({ autoAdvance: true });
  });

  const executor = () =>
    createIntegrationActionExecutor({
      auditLog,
      // These fakes are given no credential at all, so there is nothing to redact — said out loud
      // rather than by passing a hand-rolled no-op (TD-012).
      redactor: noSecretsRedactor(),
      timer,
      clock: fixedClock('2026-06-01T09:00:00.000Z', 1000),
      rateLimits: { capacity: 100, refillPerSecond: 100, maxConcurrent: 4 },
    });

  const request = (
    testCase: ExecutorCase,
    prepared: { readonly core: FakeCore; perform(): Promise<JsonObject> },
    mode: TaskMode,
  ): IntegrationActionRequest<JsonObject> =>
    testCase.mutating
      ? {
          integration: prepared.core.ref,
          action: testCase.action,
          mutating: true,
          mode,
          payload: { probe: testCase.action },
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          perform: async () => prepared.perform(),
          shadowResult: () => ({ would_have: testCase.action }),
          describeResult: (result) => result,
        }
      : {
          integration: prepared.core.ref,
          action: testCase.action,
          mutating: false,
          mode,
          payload: { probe: testCase.action },
          projectId: PROJECT_ID,
          perform: async () => prepared.perform(),
          describeResult: (result) => result,
        };

  const entered = (core: FakeCore, action: string): number =>
    core.calls.filter((call) => call.action === action).length;

  describe.each(cases)('$name', (testCase) => {
    it('retries the provider’s 429 after its Retry-After and records both attempts', async () => {
      const prepared = await testCase.create();
      prepared.core.script.failNext(
        testCase.action,
        new IntegrationRateLimitedError(prepared.core.ref.provider, 'slow down', {
          retryAfterMs: 1500,
        }),
      );

      const outcome = await executor().execute(request(testCase, prepared, 'normal'));

      expect(outcome.status, 'the retry succeeded').toBe('ok');
      expect(outcome.attempts, 'one refusal plus one success').toBe(2);
      expect(timer.sleeps, 'waited exactly what the provider asked for').toEqual([1500]);
      expect(
        entered(prepared.core, testCase.action),
        'the fake itself was entered twice, so the 429 came from a provider and not a lambda',
      ).toBe(2);
      expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok']);
      expect(auditLog.entries[0]?.attempts).toBe(2);
    });

    it('consumes the whole failure script, so no test arms an action it never calls', async () => {
      const prepared = await testCase.create();
      prepared.core.script.failNext(
        testCase.action,
        new IntegrationRateLimitedError(prepared.core.ref.provider, 'slow down', {
          retryAfterMs: 500,
        }),
      );

      await executor().execute(request(testCase, prepared, 'normal'));

      expect(prepared.core.script.unconsumed()).toEqual([]);
    });
  });

  describe.each(cases.filter((testCase) => testCase.mutating))(
    '$name in shadow mode',
    (testCase) => {
      it('records would_have, emits no event and never enters the provider', async () => {
        const prepared = await testCase.create();

        const outcome = await executor().execute(request(testCase, prepared, 'shadow'));

        expect(outcome.status, 'a mutating action in shadow mode is never performed').toBe(
          'would_have',
        );
        expect(auditLog.entries.map((entry) => entry.status)).toEqual(['would_have']);
        expect(auditLog.events, 'a shadow task performs nothing, so it announces nothing').toEqual(
          [],
        );
        expect(
          entered(prepared.core, testCase.action),
          'the provider was never called at all',
        ).toBe(0);
      });
    },
  );
});
