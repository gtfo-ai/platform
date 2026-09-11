/**
 * **A matched ticket whose intake wake-up was lost is re-emitted, not merely detected** — PROGRESS
 * backlog **20**, the criterion WP-15d put on WP-15c's row.
 *
 * ## The loss, and why it needs a seam to reproduce
 *
 * Since WP-15d the intake handler writes nothing: `pipeline.intake` checks the 1:1 dedup and
 * enqueues a `pipeline.outbound` job with `duty: 'intake_check'` through `context.afterCommit`, and
 * the **task row is created by that job**. `afterCommit` is at-most-once (TD-004), so a process
 * that dies between the handler's commit and the enqueue leaves a matched ticket with no task row —
 * and nothing re-emits it, nothing retries it and nothing logs it.
 *
 * Killing a process at that microsecond boundary is not a test. Dropping the enqueue is the same
 * loss and is deterministic, which is what `PipelineComposition.jobs` is for: a labelled seam no
 * production path passes. It drops **one** `intake_check` — the first — because the recovery's own
 * re-emission produces a second, and a seam that swallowed every one would be testing that the
 * pipeline cannot work rather than that the recovery does.
 *
 * ## Why the recovery is task-shaped
 *
 * Neither existing mechanism covers this, and the test asserts the *reason* rather than repeating
 * it: a redelivery of the webhook is deduplicated on `inbox(provider, delivery_id)` — asserted
 * below — and a replay of the event position is skipped by its `handler_executions` record, which
 * commits in the handler's own transaction. So the pass finds matched tickets with no task row and
 * appends a **new** `ticket.matched`, leaving the inbox untouched.
 */
import { type EnqueueRequest, JOB_QUEUES, type Jobs } from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const mergedEvent = (pipeline: PipelineE2E) =>
  inboundEvent('mr.merged', {
    project_id: pipeline.projectId,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: pipeline.world.branch,
      head_sha: pipeline.world.mr.headSha,
    },
    draft: false,
    head_sha: pipeline.world.mr.headSha,
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

/**
 * Counts the reconciliation passes that have **completed**.
 *
 * A pass ends by enqueuing the next one (`intakeReconcileHandler`'s `finally`), so the number of
 * `pipeline.intake.reconcile` enqueues is one — the composition root's at boot — plus the number of
 * passes that have finished. That is what lets the "nothing was re-emitted" test bound the silence
 * it is about to assert on a real event rather than on a sleep.
 */
const countReconcilePasses = (passes: { count: number }) => (jobs: Jobs) => ({
  ...jobs,
  enqueue: async <TData extends Record<string, unknown>>(request: {
    queue: string;
    data?: TData;
  }) => {
    if (request.queue === JOB_QUEUES.intakeReconcile) {
      passes.count += 1;
    }
    return jobs.enqueue(request as never);
  },
});

/** Swallows the first `intake_check` enqueue: exactly what a crash after the commit would cost. */
const dropFirstIntakeEnqueue = (dropped: EnqueueRequest[]) => (jobs: Jobs) => ({
  ...jobs,
  enqueue: async <TData extends Record<string, unknown>>(request: {
    queue: string;
    data?: TData;
  }) => {
    const duty = (request.data as { duty?: string } | undefined)?.duty;
    if (duty === 'intake_check' && dropped.length === 0) {
      dropped.push(request as EnqueueRequest);
      return { status: 'enqueued' as const, jobId: 'dropped-on-the-floor' };
    }
    return jobs.enqueue(request as never);
  },
});

describe('a matched ticket whose intake wake-up was lost', () => {
  it('is re-emitted by the reconciliation and still reaches task.completed', async () => {
    const dropped: EnqueueRequest[] = [];
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'intake-recovery',
      tickets: TICKETS,
      jobs: dropFirstIntakeEnqueue(dropped),
      env: {
        // The floor the setting allows. One second is the gap between passes *and* the age a match
        // must reach, which is the whole point of it being one number.
        APP_INTAKE_RECONCILE_INTERVAL_MS: '1000',
      },
    });
    harness = pipeline;

    const delivery = pipeline.tickets.emitTicketMatched({
      ticketKey: 'ACME-1',
      rule: 'label:agentic',
      deliveryId: 'lost-wakeup-1',
    });
    expect((await pipeline.deliver(delivery)).status).toBe(202);

    // The delivery really was performed — the event is in the log — and the wake-up the intake
    // handler asked for was swallowed. Waited for rather than asserted straight off the delivery:
    // the append is the request's, the dispatch that enqueues is the outbox worker's, and a bare
    // assertion here would be reading one thread's effect on another thread's clock.
    await pipeline.waitFor('the intake wake-up to be swallowed', async () => dropped.length === 1);
    expect(await pipeline.taskCount(), 'nothing created the task').toBe(0);

    // …and nothing else can recover it. A redelivery is deduplicated on the very row the ingress
    // wrote, which is why the recovery has to be about the *task* rather than about the delivery.
    const replay = await pipeline.deliver(delivery);
    expect(replay.status).toBe(202);
    expect(await pipeline.inbox()).toHaveLength(1);

    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.template).toBe('feature');

    await pipeline.publish([mergedEvent(pipeline)]);
    const done = await pipeline.settle('done', (task) => task.state === 'done');
    expect(done.state).toBe('done');

    // One task, not two: the re-emitted `ticket.matched` is idempotent on
    // `tasks_project_id_ticket_key_mode`, which is what makes the pass safe to run blind.
    expect(await pipeline.taskCount()).toBe(1);
    const matched = (await pipeline.events()).filter((event) => event.type === 'ticket.matched');
    expect(matched.length, 'the delivery’s event and the re-emission').toBe(2);
    // The mark that bounds the recovery to one attempt per ticket.
    expect(matched[1]?.actor).toEqual({
      kind: 'system',
      component: 'pipeline.intake.reconcile',
    });
    // And the inbox is untouched by the recovery: dedup is about a delivery, recovery about a task.
    expect(await pipeline.inbox()).toHaveLength(1);
  }, 240_000);

  it('does not re-emit anything when every matched ticket has its task', async () => {
    const passes = { count: 0 };
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'intake-recovery-quiet',
      tickets: TICKETS,
      jobs: countReconcilePasses(passes),
      env: { APP_INTAKE_RECONCILE_INTERVAL_MS: '1000' },
    });
    harness = pipeline;

    const delivery = pipeline.tickets.emitTicketMatched({
      ticketKey: 'ACME-1',
      rule: 'label:agentic',
      deliveryId: 'no-loss-1',
    });
    await pipeline.deliver(delivery);
    await pipeline.settle('a task', (task) => task.id.length > 0);

    // **Bound the thing the assertion is about.** This asserts an *absence*, so it has to wait for
    // the passes that could have produced the presence — not for a wall-clock interval, which a
    // starved machine satisfies without running anything (standing rule 2, and rule 76: bound the
    // line you assert). One enqueue is the composition root's at boot and each further one is a
    // pass that finished, so three means two passes have run to completion with the task in place.
    await pipeline.waitFor('two completed reconciliation passes', async () => passes.count >= 3);

    const matched = (await pipeline.events()).filter((event) => event.type === 'ticket.matched');
    expect(
      matched,
      'a pass that re-emits a ticket that already has a task would double every task',
    ).toHaveLength(1);
    expect(await pipeline.taskCount()).toBe(1);
  }, 240_000);
});
