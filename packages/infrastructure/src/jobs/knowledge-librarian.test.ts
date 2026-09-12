/**
 * The Librarian's two queue policies, asked of a `Jobs` implementation that has them — WP-18b.
 *
 * Here rather than beside `apply.ts` and `hygiene.ts` for the reason `knowledge-index.test.ts`
 * states: the application ring may not import an adapter, and `recordingJobs` — the only `Jobs`
 * double that ring has — applies **no** policy at all, so it would answer "two runs" whatever the
 * queue was declared as. The in-memory adapter reproduces pg-boss's admission rules; pg-boss itself
 * is asked by `test/integration/knowledge/librarian.integration.test.ts`, because a fake agreeing
 * with a fake is not evidence.
 *
 * Two claims, and they are different claims:
 *
 *  - **the apply queue is singleton per project** (BD-012: "knowledge commits are serialised per
 *    repository"), so a burst of decisions folds onto one run plus one trailing run — and the
 *    trailing one re-reads `listAwaitingApply`, which is why the decision made during the first is
 *    not lost;
 *  - **the nightly hygiene schedule is one schedule**, whatever number of worker processes register
 *    it, because every one of them registers the same queue and key.
 */
import {
  declareKnowledgeApplyQueue,
  declareKnowledgeHygieneQueue,
  enqueueKnowledgeApply,
  JOB_QUEUES,
  KNOWLEDGE_HYGIENE_CRON,
  KNOWLEDGE_HYGIENE_CRON_KEY,
  knowledgeApplyKey,
  knowledgeHygieneSchedule,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createInMemoryJobs } from './in-memory-jobs.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const OTHER = '00000000-0000-4000-8000-0000000000b2' as Id;

describe('the knowledge.apply queue', () => {
  it('collapses decisions that arrive while a commit is in flight onto one further run', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await declareKnowledgeApplyQueue(runtime.jobs);

    const ran: string[] = [];
    await runtime.jobs.work<{ readonly project_id: string; readonly reason: string }>({
      queue: JOB_QUEUES.knowledgeApply,
      handler: async (context) => {
        ran.push(context.data.reason);
        if (ran.length === 1) {
          // Two maintainers approving while the first commit is being pushed.
          await enqueueKnowledgeApply(runtime.jobs, { projectId: PROJECT, reason: 'decision' });
          await enqueueKnowledgeApply(runtime.jobs, { projectId: PROJECT, reason: 'decision' });
        }
      },
    });

    await enqueueKnowledgeApply(runtime.jobs, { projectId: PROJECT, reason: 'auto_apply' });
    await runtime.drain();

    // One trailing run rather than two — and rather than none: the trailing run re-reads what is
    // waiting, so both decisions are applied by it.
    expect(ran).toEqual(['auto_apply', 'decision']);
    await runtime.stop();
  });

  it('reports the decision it folded as a success rather than an error', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await declareKnowledgeApplyQueue(runtime.jobs);

    const first = await enqueueKnowledgeApply(runtime.jobs, {
      projectId: PROJECT,
      reason: 'auto_apply',
    });
    const second = await enqueueKnowledgeApply(runtime.jobs, {
      projectId: PROJECT,
      reason: 'decision',
    });

    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('coalesced');
    await runtime.stop();
  });

  it('never lets one project’s knowledge commit block another’s', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await declareKnowledgeApplyQueue(runtime.jobs);

    // Both through `enqueueKnowledgeApply`, which is what holds the singleton **key**: without it
    // the two projects would share pg-boss's null key and the second would be refused.
    const first = await enqueueKnowledgeApply(runtime.jobs, {
      projectId: PROJECT,
      reason: 'decision',
    });
    const other = await enqueueKnowledgeApply(runtime.jobs, {
      projectId: OTHER,
      reason: 'decision',
    });

    expect([first.status, other.status]).toEqual(['enqueued', 'enqueued']);
    expect(runtime.snapshot()).toHaveLength(2);
    expect(knowledgeApplyKey(PROJECT)).not.toBe(knowledgeApplyKey(OTHER));
    await runtime.stop();
  });
});

describe('the nightly hygiene schedule', () => {
  it('is one schedule however many processes register it', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await declareKnowledgeHygieneQueue(runtime.jobs);

    // Three worker processes, each registering at start-up — the port's contract says scheduling
    // the same cron twice is safe, and this is what that has to mean.
    for (let process = 0; process < 3; process += 1) {
      await runtime.jobs.scheduleCron(knowledgeHygieneSchedule('Europe/Prague'));
    }

    const schedules = await runtime.jobs.listCronSchedules(JOB_QUEUES.knowledgeHygiene);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cron).toBe(KNOWLEDGE_HYGIENE_CRON);
    expect(schedules[0]?.key).toBe(KNOWLEDGE_HYGIENE_CRON_KEY);
    // The zone travels with it: a schedule that means 03:15 has to say whose (TD-004).
    expect(schedules[0]?.timezone).toBe('Europe/Prague');
    await runtime.stop();
  });

  it('is a five-field expression at a time nothing else runs', () => {
    expect(KNOWLEDGE_HYGIENE_CRON.split(' ')).toHaveLength(5);
    expect(KNOWLEDGE_HYGIENE_CRON.startsWith('15 3 ')).toBe(true);
  });
});
