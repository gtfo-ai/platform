/**
 * WP-15d: **what the platform can still do while a provider it called is slow.**
 *
 * The defect this file measures was not a crash — it was a shape. Three pipeline handlers called a
 * provider while the dispatcher's transaction and their own were both open, so a pooled connection
 * and the single dispatch slot (`APP_DISPATCH_MAX_CONCURRENCY` ships as **1**) were held for the
 * length of somebody else's HTTP round trip. Nothing fails; everything waits. That is exactly the
 * kind of defect a functional test cannot see, because every assertion still passes — eventually.
 *
 * So the assertion here is a **liveness** one and not a duration (standing rule 2): the intake's
 * git read is held open by a promise this test resolves, and while it is in flight an event that
 * has nothing to do with it is appended. Either the dispatcher gets to it — which is what the
 * transaction / no transaction / transaction shape buys — or it sits in `event_dispatch` until the
 * provider answers, which is the defect, stated as a boolean rather than as a millisecond count.
 *
 * `APP_DB_POOL_MAX` is the **shipped default** here, not the harness's 16, because a measurement
 * quoted as evidence has to reproduce from the values a deployment actually runs (standing rule
 * 39).
 */
import { JOB_QUEUES } from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;
let release: (() => void) | undefined;

afterEach(async () => {
  // Before the instance stops: a handler parked on a promise nobody resolves would hold shutdown.
  release?.();
  release = undefined;
  await harness?.stop();
  harness = undefined;
});

/** How long the unrelated event is given. It is a bound on the *wait*, never on the assertion. */
const DISPATCH_BUDGET_MS = 20_000;

const pollUntil = async (budgetMs: number, ready: () => Promise<boolean>): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await ready()) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('while a provider call the pipeline made is still in flight', () => {
  it('dispatches an unrelated event instead of holding the dispatcher inside a handler', async () => {
    let entered: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'outbound-shape',
      tickets: TICKETS,
      gitReadLatency: async () => {
        entered?.();
        await answered;
      },
      // The shipped default (`.env.example`), so the number this test produces is a number about a
      // deployment rather than about the harness.
      env: { APP_DB_POOL_MAX: '13' },
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
    // The intake's default-branch read has been entered and will not return until this test says so.
    await firstRead;

    const unrelated = inboundEvent('default_branch.moved', {
      project_id: pipeline.projectId,
      branch: 'main',
      new_head: 'd'.repeat(40),
    });
    await pipeline.publish([unrelated]);

    const dispatchedWhileTheProviderWasBlocked = await pollUntil(
      DISPATCH_BUDGET_MS,
      async () => !(await pipeline.awaitingDispatch(unrelated.id)),
    );

    release?.();
    release = undefined;

    // The named assertion, so a regression reads as what it is rather than as a timeout: with the
    // provider call back inside the handler's transaction this is `false`, because the one dispatch
    // slot is inside `pipeline.intake` waiting for an HTTP response.
    expect(dispatchedWhileTheProviderWasBlocked).toBe(true);

    // And the intake still finishes once the provider answers — the call moved, it did not vanish.
    await pipeline.settle('the task the held-up intake created', (task) => task.state !== 'queued');
  });
});

describe('when the same wake-up is delivered twice', () => {
  it('replays the ticket write out of the idempotency store this instance composed', async () => {
    // Standing rule 35, and the assertion PROGRESS's WP-15b entry says this work package owes:
    // `composePipeline` builds a `createPostgresIdempotencyStore` from its own pool and **no caller
    // may supply one** — but until a pipeline action carried an `IdempotencyPlan`, deleting that
    // line left every tier green. Now the two ticket writes carry one, keyed by the event that
    // caused the wake-up, so a re-delivered job is answerable from the store. This test re-delivers
    // one and asks the production audit log what happened.
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'outbound-replay',
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
    // Quiescent first, and for the same reason the workpad test waits: the count below is only a
    // measurement if nothing else is still rendering. `ready_for_merge` is where the pipeline stops
    // until a human merges, and the render of *that* state is the last outbound job it enqueues.
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    await pipeline.waitFor(
      'the workpad rendered for ready_for_merge',
      async () =>
        pipeline.tickets
          .peek('ACME-1')
          ?.comments[0]?.body.startsWith('**ACME-1** — ready_for_merge') === true,
    );

    // The wake-up the workpad handler enqueued for `task.created`, rebuilt from the event log
    // rather than from pg-boss's own tables: the same duty, the same task, the same cause. That is
    // what a lease expiry re-delivers.
    const created = (await pipeline.events()).find((event) => event.type === 'task.created');
    const payload = created?.payload as { task_id: string; project_id: string };

    await pipeline.instance.runtime.jobs?.enqueue({
      queue: JOB_QUEUES.pipelineOutbound,
      data: {
        duty: 'workpad',
        project_id: payload.project_id,
        task_id: payload.task_id,
        cause_event_id: created?.id as string,
      },
    });

    // The wait *is* the assertion's other half: with no idempotency store composed, the second
    // delivery would simply post again and no `replayed` row would ever appear — the failure is
    // then this named wait, not a count taken against a queue that is still draining.
    await pipeline.waitFor('the re-delivered wake-up was audited as a replay', async () =>
      (await pipeline.auditRows()).some((row) => row.status === 'replayed'),
    );

    const replayed = (await pipeline.auditRows()).filter((row) => row.status === 'replayed');
    expect(replayed.map((row) => row.action)).toEqual(['upsert_workpad']);
    // `attempts: 0` is the audit log's own statement that nothing was sent — a performed call
    // records at least 1, which the row above it in this file asserts.
    expect(replayed[0]?.attempts).toBe(0);
    // And BD-023 still holds: one sticky comment, however many wake-ups arrived.
    expect(pipeline.tickets.peek('ACME-1')?.comments).toHaveLength(1);
  });
});
