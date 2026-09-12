/**
 * "Singleton per project", asked of a `Jobs` implementation that has queue policies — WP-18a.
 *
 * It lives here rather than beside `index-job.ts` because the application ring may not import an
 * adapter, and the only `Jobs` double that ring has (`recordingJobs`) records every enqueue and
 * applies **no** policy: it would answer "two runs" whatever the queue was declared as, which is
 * standing rule 1's kindness sitting exactly on top of an acceptance criterion. The in-memory
 * adapter reproduces pg-boss's admission rules (its divergence register says where it is stricter),
 * and `test/integration/knowledge/git-vault-index.integration.test.ts` asks pg-boss itself, because
 * a fake agreeing with a fake is not evidence.
 *
 * The criterion, in its own words: *two triggers while one run is in flight produce one run*.
 */
import {
  declareKnowledgeQueues,
  enqueueKnowledgeIndex,
  JOB_QUEUES,
  knowledgeIndexKey,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createInMemoryJobs } from './in-memory-jobs.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const OTHER = '00000000-0000-4000-8000-0000000000a2' as Id;

describe('the knowledge.index queue', () => {
  it('collapses two triggers that arrive while a run is in flight onto one further run', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await declareKnowledgeQueues(runtime.jobs);

    const ran: string[] = [];
    await runtime.jobs.work<{ readonly project_id: string; readonly reason: string }>({
      queue: JOB_QUEUES.knowledgeIndex,
      handler: async (context) => {
        ran.push(context.data.reason);
        if (ran.length === 1) {
          // Two more triggers *while this run is active* — a merge and a task start, say.
          await enqueueKnowledgeIndex(runtime.jobs, { projectId: PROJECT, reason: 'merged' });
          await enqueueKnowledgeIndex(runtime.jobs, { projectId: PROJECT, reason: 'task_started' });
        }
      },
    });

    await enqueueKnowledgeIndex(runtime.jobs, { projectId: PROJECT, reason: 'task_started' });
    await runtime.drain();

    // One trailing run, not two and not none: `stately` admits one queued job per key, and the
    // trailing run re-reads the branch head, so the second trigger is not lost — it is *folded*.
    expect(ran).toEqual(['task_started', 'merged']);
    await runtime.stop();
  });

  it('reports the trigger it folded as a success rather than an error', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await declareKnowledgeQueues(runtime.jobs);

    const first = await runtime.jobs.enqueue({
      queue: JOB_QUEUES.knowledgeIndex,
      singletonKey: knowledgeIndexKey(PROJECT),
      data: { project_id: PROJECT, reason: 'merged' },
    });
    const second = await runtime.jobs.enqueue({
      queue: JOB_QUEUES.knowledgeIndex,
      singletonKey: knowledgeIndexKey(PROJECT),
      data: { project_id: PROJECT, reason: 'task_started' },
    });

    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('coalesced');
    await runtime.stop();
  });

  it('never lets one project’s index run block another’s', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await declareKnowledgeQueues(runtime.jobs);

    // Both through `enqueueKnowledgeIndex`, which is what makes this the test that holds the
    // singleton **key**: with the key removed, the two projects share pg-boss's null key and the
    // second project's index would be refused because the first project had one queued. The policy
    // tests above cannot see that — one project collapses onto one job either way.
    const first = await enqueueKnowledgeIndex(runtime.jobs, {
      projectId: PROJECT,
      reason: 'merged',
    });
    const other = await enqueueKnowledgeIndex(runtime.jobs, {
      projectId: OTHER,
      reason: 'merged',
    });

    expect([first.status, other.status]).toEqual(['enqueued', 'enqueued']);
    expect(runtime.snapshot()).toHaveLength(2);
    expect(knowledgeIndexKey(PROJECT)).not.toBe(knowledgeIndexKey(OTHER));
    await runtime.stop();
  });
});
