/**
 * Re-emitting a `ticket.matched` whose task was never created — PROGRESS backlog **20**.
 *
 * The *query* — matched tickets with no task row, excluding the ones this component already
 * re-emitted — is SQL, and it is asserted against a real database in
 * `test/integration/pipeline/intake-reconcile.integration.test.ts`. What is here is everything the
 * application ring decides: the grace period it asks for, the envelope it builds, the actor that
 * marks a re-emission as one, and the timer that keeps the pass coming back.
 */
import type { Actor, DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { EnqueueRequest, JobContext, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import {
  INTAKE_RECONCILE_KEY,
  INTAKE_RECONCILER_COMPONENT,
  type IntakeReconciliationStore,
  intakeReconcileHandler,
  runIntakeReconciliation,
  startIntakeReconciliation,
  type UnstartedMatch,
} from './intake-reconcile.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const LOST_EVENT = '00000000-0000-4000-9000-000000000001' as Id;
const NOW = '2026-06-01T10:30:00.000Z' as IsoDateTime;

const matchPayload = () => ({
  project_id: PROJECT,
  ticket: {
    provider: 'jira-cloud',
    key: 'ACME-1',
    url: 'https://acme.atlassian.net/browse/ACME-1',
  },
  rule: 'label = "agentic"',
  priority: null,
  issue_type: 'Story',
  epic: null,
  links: [],
});

const unstarted = (): UnstartedMatch => ({
  eventId: LOST_EVENT,
  projectId: PROJECT,
  payload: matchPayload(),
});

interface Harness {
  readonly appended: DomainEvent[];
  readonly asked: Parameters<IntakeReconciliationStore['findUnstartedMatches']>[0][];
  readonly enqueued: EnqueueRequest[];
  readonly jobs: Jobs;
  readonly store: IntakeReconciliationStore;
  readonly unitOfWork: UnitOfWork;
}

const harnessFor = (matches: readonly UnstartedMatch[] = [unstarted()]): Harness => {
  const appended: DomainEvent[] = [];
  const asked: Harness['asked'] = [];
  const enqueued: EnqueueRequest[] = [];
  return {
    appended,
    asked,
    enqueued,
    jobs: {
      defineQueue: async () => {},
      enqueue: async (request) => {
        enqueued.push(request as EnqueueRequest);
        return { status: 'enqueued', jobId: 'j-1' };
      },
      scheduleCron: async () => {},
      unscheduleCron: async () => {},
      listCronSchedules: async () => [],
      work: async (request): Promise<JobWorker> => ({
        queue: request.queue,
        stop: async () => {},
      }),
    },
    store: {
      findUnstartedMatches: async (input) => {
        asked.push(input);
        return matches;
      },
    },
    unitOfWork: {
      transaction: async (fn) =>
        fn({
          events: {
            append: async (events: readonly DomainEvent[]) => {
              appended.push(...events);
              return [];
            },
          },
        } as unknown as TransactionScope),
    },
  };
};

const optionsFor = (harness: Harness, graceMs = 60_000) => ({
  store: harness.store,
  unitOfWork: harness.unitOfWork,
  eventStore: { nextStreamSequence: async () => 12 },
  ids: { next: () => '00000000-0000-4000-9000-000000000099' as Id },
  clock: { now: () => NOW },
  graceMs,
});

describe('one reconciliation pass', () => {
  it('appends a NEW ticket.matched for a match with no task row', async () => {
    const harness = harnessFor();

    const report = await runIntakeReconciliation(optionsFor(harness));

    expect(report).toEqual({ found: 1, reEmitted: 1 });
    expect(harness.appended).toHaveLength(1);
    const event = harness.appended[0] as Extract<DomainEvent, { type: 'ticket.matched' }>;
    expect(event.type).toBe('ticket.matched');
    // A **new** event, not a replay of the old one: `handlerExecutions.claim`/`complete` commit in
    // the handler's own transaction, so re-dispatching the original position is skipped by design.
    expect(event.id).not.toBe(LOST_EVENT);
    expect(event.cause_event_id).toBe(LOST_EVENT);
    expect(event.stream_type).toBe('project');
    expect(event.stream_id).toBe(PROJECT);
    expect(event.stream_seq).toBe(12);
    expect(event.payload).toEqual(matchPayload());
  });

  it('marks the re-emission with a system actor, which is what bounds it to one attempt', async () => {
    const harness = harnessFor();

    await runIntakeReconciliation(optionsFor(harness));

    const actor = (harness.appended[0] as DomainEvent).actor as Actor;
    expect(actor).toEqual({ kind: 'system', component: INTAKE_RECONCILER_COMPONENT });
    // The same name the query excludes on, so the mark and the filter cannot drift apart.
    expect(harness.asked[0]?.reconcilerComponent).toBe(INTAKE_RECONCILER_COMPONENT);
  });

  it('asks only for matches older than the grace period', async () => {
    const harness = harnessFor();

    await runIntakeReconciliation(optionsFor(harness, 90_000));

    // A match younger than this still has its own `intake_check` job in flight.
    expect(harness.asked[0]?.olderThan).toBe('2026-06-01T10:28:30.000Z');
  });

  it('does nothing, loudly or otherwise, when every matched ticket has a task', async () => {
    const harness = harnessFor([]);
    expect(await runIntakeReconciliation(optionsFor(harness))).toEqual({ found: 0, reEmitted: 0 });
    expect(harness.appended).toEqual([]);
  });

  it('re-emits each ticket in its own transaction, so one failure does not roll back the rest', async () => {
    const harness = harnessFor([
      unstarted(),
      { ...unstarted(), eventId: '00000000-0000-4000-9000-000000000002' as Id },
    ]);
    let transactions = 0;
    const counting: UnitOfWork = {
      transaction: async (fn) => {
        transactions += 1;
        return harness.unitOfWork.transaction(fn);
      },
    };

    await runIntakeReconciliation({ ...optionsFor(harness), unitOfWork: counting });

    expect(transactions).toBe(2);
    expect(harness.appended).toHaveLength(2);
  });
});

describe('the timer that keeps the pass coming back', () => {
  it('schedules the next pass after the interval', async () => {
    const harness = harnessFor();

    await intakeReconcileHandler({
      ...optionsFor(harness),
      jobs: harness.jobs,
      intervalMs: 45_000,
    })({} as JobContext);

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({
      queue: JOB_QUEUES.intakeReconcile,
      singletonKey: INTAKE_RECONCILE_KEY,
    });
    expect(harness.enqueued[0]?.startAfter?.toISOString()).toBe('2026-06-01T10:30:45.000Z');
  });

  it('uses the interval as the grace period too — one knob, not two', async () => {
    const harness = harnessFor();

    await intakeReconcileHandler({
      ...optionsFor(harness),
      jobs: harness.jobs,
      intervalMs: 45_000,
    })({} as JobContext);

    expect(harness.asked[0]?.olderThan).toBe('2026-06-01T10:29:15.000Z');
  });

  it('schedules the next pass even when this one threw, or the chain dies on one bad query', async () => {
    const harness = harnessFor();
    const failing: IntakeReconciliationStore = {
      findUnstartedMatches: async () => {
        throw new Error('the query failed');
      },
    };

    await expect(
      intakeReconcileHandler({
        ...optionsFor(harness),
        store: failing,
        jobs: harness.jobs,
        intervalMs: 45_000,
      })({} as JobContext),
    ).rejects.toThrow('the query failed');

    expect(
      harness.enqueued,
      'the failure is the job’s; the schedule is the deployment’s',
    ).toHaveLength(1);
  });
});

describe('starting the recovery', () => {
  it('declares the queue, starts one worker and puts the first pass on it', async () => {
    const harness = harnessFor();

    const worker = await startIntakeReconciliation({
      ...optionsFor(harness),
      jobs: harness.jobs,
      intervalMs: 60_000,
    });

    expect(worker?.queue).toBe(JOB_QUEUES.intakeReconcile);
    // The boot enqueue is what re-establishes the chain after a crash between a pass and its own
    // re-enqueue; `stately` plus the singleton key collapses every replica's onto one job.
    expect(harness.enqueued).toEqual([
      { queue: JOB_QUEUES.intakeReconcile, singletonKey: INTAKE_RECONCILE_KEY },
    ]);
  });

  it('starts nothing at all when the interval is zero, so "off" is a state and not a silence', async () => {
    const harness = harnessFor();

    const worker = await startIntakeReconciliation({
      ...optionsFor(harness),
      jobs: harness.jobs,
      intervalMs: 0,
    });

    expect(worker).toBeNull();
    expect(harness.enqueued).toEqual([]);
  });
});
