/**
 * The index job's triggers and its handler — WP-18a.
 *
 * Two halves, and the split is deliberate. **Here**: which event enqueues what, and what the job
 * does when it fires, against `recordingJobs`. **Not here**: whether two triggers really produce one
 * run, because `recordingJobs` records every enqueue and applies no queue policy at all — it would
 * answer "two" whatever the queue was declared as, which is standing rule 1's kindness in the exact
 * place the acceptance criterion lives. That question is asked of the in-memory adapter
 * (`packages/infrastructure/src/jobs/knowledge-index.test.ts`, which this ring may not import) and
 * of pg-boss (`test/integration/knowledge/git-vault-index.integration.test.ts`).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../events/handler.js';
import type { EnqueueRequest, JobContext } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import {
  type KnowledgeIndexData,
  type KnowledgeIndexProject,
  knowledgeIndexHandler,
  knowledgeIndexKey,
  knowledgeTriggerHandlers,
} from './index-job.js';
import type { IndexReport, IndexRequest } from './indexer.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000f2' as Id;

const event = (type: DomainEvent['type'], payload: Record<string, unknown>): DomainEvent =>
  ({
    id: '00000000-0000-4000-8000-0000000000ff',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    actor: { kind: 'system', component: 'test' },
    occurred_at: '2026-01-01T00:00:00.000Z',
    type,
    payload,
  }) as unknown as DomainEvent;

/** Drives one handler and runs its `afterCommit` callbacks, as the dispatcher does after a commit. */
const dispatch = async (
  handlers: readonly {
    readonly eventTypes: readonly string[] | 'all';
    handle: (context: HandlerContext) => Promise<void>;
  }[],
  domainEvent: DomainEvent,
): Promise<void> => {
  const callbacks: (() => Promise<void> | void)[] = [];
  const context = {
    scope: {} as HandlerContext['scope'],
    event: { position: 1, causeEventPosition: null, event: domainEvent },
    emit: async () => [],
    stop: () => {},
    afterCommit: (callback: () => Promise<void> | void) => {
      callbacks.push(callback);
    },
  } satisfies HandlerContext;

  for (const handler of handlers) {
    if (handler.eventTypes === 'all' || handler.eventTypes.includes(domainEvent.type)) {
      await handler.handle(context);
    }
  }
  for (const callback of callbacks) {
    await callback();
  }
};

const enqueuedIndexJobs = (jobs: ReturnType<typeof recordingJobs>): readonly EnqueueRequest[] =>
  jobs.enqueued.filter((request) => request.queue === JOB_QUEUES.knowledgeIndex);

describe('the index triggers', () => {
  it('asks for one index run when a task starts', async () => {
    const jobs = recordingJobs();
    await dispatch(
      knowledgeTriggerHandlers({ jobs }),
      event('task.created', {
        project_id: PROJECT,
        task_id: TASK,
        ticket: {
          provider: 'jira-cloud',
          key: 'ACME-1',
          url: 'https://tickets.example.test/ACME-1',
        },
        template: 'feature',
        mode: 'normal',
      }),
    );

    expect(enqueuedIndexJobs(jobs)).toEqual([
      {
        queue: JOB_QUEUES.knowledgeIndex,
        singletonKey: knowledgeIndexKey(PROJECT),
        data: { project_id: PROJECT, reason: 'task_started' },
      },
    ]);
  });

  it('asks for one unpinned run when a merge request is merged', async () => {
    const jobs = recordingJobs();
    await dispatch(
      knowledgeTriggerHandlers({ jobs }),
      event('mr.merged', {
        project_id: PROJECT,
        mr: { iid: 7, url: 'https://git.example.test/acme/api/-/merge_requests/7' },
        draft: false,
        head_sha: 'abc1234',
        merge_commit_sha: 'def5678',
      }),
    );

    const [request] = enqueuedIndexJobs(jobs);
    // Unpinned on purpose: `mr.merged` does not say which branch the merge landed on, and pinning
    // the merge commit would make every feature-branch merge fail the ancestry guard.
    expect(request?.data).toEqual({ project_id: PROJECT, reason: 'merged' });
  });

  it('pins the new head when the default branch moves', async () => {
    const jobs = recordingJobs();
    await dispatch(
      knowledgeTriggerHandlers({ jobs }),
      event('default_branch.moved', { project_id: PROJECT, branch: 'main', new_head: 'beef123' }),
    );

    expect(enqueuedIndexJobs(jobs)[0]?.data).toEqual({
      project_id: PROJECT,
      reason: 'default_branch_moved',
      commit_sha: 'beef123',
    });
  });

  it('enqueues nothing until the handler’s transaction has committed', async () => {
    const jobs = recordingJobs();
    const handlers = knowledgeTriggerHandlers({ jobs });
    const deferred: (() => Promise<void> | void)[] = [];
    const context = {
      scope: {} as HandlerContext['scope'],
      event: {
        position: 1,
        causeEventPosition: null,
        event: event('default_branch.moved', {
          project_id: PROJECT,
          branch: 'main',
          new_head: 'beef123',
        }),
      },
      emit: async () => [],
      stop: () => {},
      afterCommit: (callback: () => Promise<void> | void) => {
        deferred.push(callback);
      },
    } satisfies HandlerContext;

    for (const handler of handlers) {
      await handler.handle(context);
    }
    // `Jobs.enqueue` does not join the handler's transaction (TD-004), so a handler that rolled back
    // must leave no job behind.
    expect(enqueuedIndexJobs(jobs)).toEqual([]);
    expect(deferred).toHaveLength(1);
  });

  it('ignores an event of a type it did not ask for', async () => {
    const jobs = recordingJobs();
    await dispatch(
      knowledgeTriggerHandlers({ jobs }),
      event('mr.closed', {
        project_id: PROJECT,
        mr: { iid: 7, url: 'https://git.example.test/acme/api/-/merge_requests/7' },
        draft: false,
        head_sha: 'abc1234',
      }),
    );
    expect(enqueuedIndexJobs(jobs)).toEqual([]);
  });
});

const job = (data: KnowledgeIndexData): JobContext<KnowledgeIndexData> => ({
  id: 'job-1',
  queue: JOB_QUEUES.knowledgeIndex,
  data,
  signal: AbortSignal.abort(),
});

const report = (overrides: Partial<IndexReport> = {}): IndexReport => ({
  status: 'indexed',
  parserVersion: 1,
  commitSha: 'abc1234',
  documents: 3,
  chunks: 9,
  tokens: 120,
  invalid: [],
  removed: [],
  truncated: [],
  reason: null,
  ...overrides,
});

describe('the index job handler', () => {
  const project: KnowledgeIndexProject = {
    projectKey: 'ACME',
    knowledgeDir: '.agentic/knowledge',
  };

  it('re-reads the project when it fires and passes what the indexer needs', async () => {
    const requests: IndexRequest[] = [];
    await knowledgeIndexHandler({
      indexer: {
        index: async (request) => {
          requests.push(request);
          return report();
        },
      },
      project: async () => project,
    })(job({ project_id: PROJECT, reason: 'default_branch_moved', commit_sha: 'beef123' }));

    expect(requests).toEqual([
      {
        projectId: PROJECT,
        projectKey: 'ACME',
        knowledgeDir: '.agentic/knowledge',
        commitSha: 'beef123',
      },
    ]);
  });

  it('leaves the commit out when the wake-up did not name one', async () => {
    const requests: IndexRequest[] = [];
    await knowledgeIndexHandler({
      indexer: {
        index: async (request) => {
          requests.push(request);
          return report();
        },
      },
      project: async () => project,
    })(job({ project_id: PROJECT, reason: 'merged' }));

    expect(requests[0]?.commitSha).toBeUndefined();
  });

  it('indexes nothing when the project no longer has a row, and does not throw', async () => {
    let indexed = 0;
    await expect(
      knowledgeIndexHandler({
        indexer: {
          index: async () => {
            indexed += 1;
            return report();
          },
        },
        project: async () => null,
      })(job({ project_id: PROJECT, reason: 'task_started' })),
    ).resolves.toBeUndefined();
    expect(indexed).toBe(0);
  });

  it('completes a run that could not read the vault instead of failing the job', async () => {
    const logged: { fields: Record<string, unknown>; message: string }[] = [];
    await expect(
      knowledgeIndexHandler({
        indexer: {
          index: async () =>
            report({
              status: 'vault_unavailable',
              commitSha: null,
              documents: 0,
              chunks: 0,
              reason: 'APP_KNOWLEDGE_MIRROR_ROOT is not set',
            }),
        },
        project: async () => project,
        logger: {
          debug: () => {},
          info: () => {},
          warn: (fields, message) => {
            logged.push({ fields: fields as Record<string, unknown>, message });
          },
          error: () => {},
        },
      })(job({ project_id: PROJECT, reason: 'task_started' })),
    ).resolves.toBeUndefined();

    // A retry would re-read a mirror whose remote is down; the reason has to reach a human instead.
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields.reason).toBe('APP_KNOWLEDGE_MIRROR_ROOT is not set');
  });
});
