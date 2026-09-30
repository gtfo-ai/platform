/**
 * **WP-90's review-thread refresh, driven from its `mr.updated` signal** (WP-96, PROGRESS backlog
 * 306).
 *
 * The refresh re-counts a waiting task's human review threads when the provider says their
 * resolution changed. Until WP-96 the fake git provider could not send the flag
 * (`mr.updated.blocking_threads_resolved`), so the only tier that exercised the path was the unit
 * tier's in-memory store: the webhook route, the dispatcher, the `pipeline.outbound` job, the
 * executor's `listDiscussions` and `saveReviewThreads` on PostgreSQL were never joined. The fake
 * sends it on request now (its divergence 20), and this walks one task through both values.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;
afterAll(async () => {
  await harness?.stop();
  harness = undefined;
});

describe('the review-thread refresh on an mr.updated resolution signal (backlog 306)', () => {
  it('re-counts the threads once per signal, open and then resolved', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'threads-refresh',
      tickets: TICKETS,
    });
    harness = pipeline;
    await pipeline.publish([
      inboundEvent('ticket.matched', {
        project_id: pipeline.projectId,
        ticket: {
          provider: 'fake-task-management',
          key: 'ACME-1',
          url: 'https://tickets.example.test/browse/ACME-1',
        },
        rule: 'label:agentic',
        priority: 'High',
        issue_type: 'Story',
        epic: null,
        links: [],
      }),
    ]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    const iid = pipeline.world.mr.iid;
    const threads = async () =>
      (
        await pipeline.query<{ review_threads: { open: number; resolved: number } | null }>(
          'select review_threads from tasks where project_id = $1',
          [pipeline.projectId],
        )
      )[0]?.review_threads ?? null;
    const reads = () =>
      pipeline.gitCalls().filter((call) => call.method === 'listDiscussions').length;

    // Two reviewers open threads on the provider while the task waits.
    const opened = ['ada', 'grace'].map((author) =>
      pipeline.git.addHumanDiscussion({
        project: GIT_PROJECT,
        iid,
        authorId: author,
        text: `${author} would like a bound on the retry helper`,
      }),
    );

    const deliver = async (resolved: boolean) => {
      const delivery = pipeline.git.emitMergeRequestEvent({
        event: 'mr.updated',
        project: GIT_PROJECT,
        iid,
        blockingThreadsResolved: resolved,
      });
      expect((await pipeline.deliverGit(delivery)).status).toBe(202);
    };

    // `false`: the threads are not all resolved — a signal all the same, so the count is re-read.
    const beforeFirst = reads();
    await deliver(false);
    await pipeline.waitFor('the refresh to count two open threads', async () => {
      const counted = await threads();
      return counted?.open === 2;
    });
    expect(reads() - beforeFirst).toBe(1);

    // Resolved on the provider, then the flag the provider sends for the last resolution.
    for (const discussion of opened) {
      await pipeline.git.resolveDiscussion(
        { project_path: GIT_PROJECT, iid, url: pipeline.world.mr.url },
        discussion.id,
      );
    }
    const beforeSecond = reads();
    await deliver(true);
    await pipeline.waitFor('the refresh to count the threads resolved', async () => {
      const counted = await threads();
      return counted?.open === 0 && counted.resolved === 2;
    });
    expect(reads() - beforeSecond).toBe(1);
    // A count, never a transition: the task still waits where it was.
    expect((await pipeline.task()).state).toBe('ready_for_merge');
  });
});
