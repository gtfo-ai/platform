/**
 * The run-lease sweep: what it ends, what it refuses to end, and what it never writes (WP-47).
 *
 * Driven against the **real** in-memory pipeline store and the real event log rather than against
 * doubles for them, because the three things this sweep has to get right are all facts about rows:
 * the run really becomes terminal with the named reason, the task really becomes `needs_human`, and
 * the run's cost columns are really still empty — a `{ usd: 0 }` there would be published as a free
 * run (standing rule 16). Only the *query* is a double, because its predicates are SQL and
 * `test/integration/recovery/run-lease-sweep.integration.test.ts` is where they are exercised.
 *
 * The negative case is the one the whole mechanism turns on (criterion 2, standing rule 42): a run
 * whose lease was renewed between the pass's read and the ending's transaction is **not** ended, and
 * the assertion is that nothing at all moved — not the run, not the task, not the log.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { StoredTask } from '../pipeline/store.js';
import { INITIAL_TASK_VERSION } from '../pipeline/store.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import type { ExpiredRunLease, ExpiredRunQuery } from './run-lease.js';
import { sweepExpiredRunLeases } from './run-lease.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000d1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000e1' as Id;
const NOW = '2026-09-15T10:00:00.000Z' as IsoDateTime;
const STARTED = '2026-09-15T09:00:00.000Z' as IsoDateTime;
const LEASE_GONE = '2026-09-15T09:50:00.000Z' as IsoDateTime;
const GRACE_MS = 60_000;
const WALL_CLOCK_MS = 60 * 60_000;

const task = (state: StoredTask['task']['state'] = 'active'): StoredTask => ({
  task: {
    id: TASK,
    projectId: PROJECT,
    ticket: { provider: 'fake-jira', key: 'ACME-9', url: 'https://jira.test/ACME-9' },
    template: 'feature',
    mode: 'normal',
    state,
    currentStage: 'implementation',
    stageAttempts: { implementation: 1 },
    iterationCounters: {},
    limits: {
      code_review: 3,
      business_review: 2,
      ci_fix: 3,
      human_rounds: 3,
      refinement_questions: 2,
      architecture_revisions: 2,
      rebase: 2,
      rebase_rechecks: 10,
      dependency_policy: 2,
    },
    sequence: 1,
  },
  template: FEATURE_TEMPLATE,
  priorityRank: 2,
  createdAt: '2026-09-15T08:00:00.000Z' as IsoDateTime,
  branch: null,
  mr: null,
  workpad: null,
  costActualUsd: 0,
  estimateUsd: null,
  estimateBasis: null,
  estimateSamples: null,
  ticketSnapshot: null,
  reviewSubject: null,
  historySample: null,
  riskClasses: [],
  coverage: null,
  dependencies: null,
  requiredReviewers: null,
  requestedByUserId: null,
  ticketSnapshotAt: null,
  version: INITIAL_TASK_VERSION,
});

const expired: ExpiredRunLease = {
  runId: RUN,
  taskId: TASK,
  projectId: PROJECT,
  stage: 'implementation',
  attempt: 1,
  leaseOwner: 'server-1:0f0f0f0f',
  leaseExpiresAt: LEASE_GONE,
  startedAt: STARTED,
};

const sweep = async (options: {
  readonly claim: boolean;
  readonly taskState?: 'active' | 'done';
}) => {
  const store = createMemoryPipelineStore();
  const eventing = new MemoryEventing();
  const asked: ExpiredRunQuery[] = [];

  await eventing.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, task(options.taskState ?? 'active'));
    await store.tasks.recordStageEntered(scope.tx, {
      taskId: TASK,
      stage: 'implementation',
      attempt: 1,
      causedByEventId: null,
    });
    await store.runs.insert(scope.tx, {
      id: RUN,
      taskId: TASK,
      projectId: PROJECT,
      stage: 'implementation',
      role: 'developer',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'developer@1',
      systemPrompt: null,
      userPrompt: null,
      redactionCount: 0,
      status: 'running',
      terminalReason: null,
      sessionId: 'session-1',
      numTurns: 3,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: STARTED,
      startedAt: STARTED,
    });
  });

  const report = await sweepExpiredRunLeases({
    store: {
      expiredRuns: async (_tx, query) => {
        asked.push(query);
        return [expired];
      },
      claimExpiredRun: async () => options.claim,
    },
    pipeline: store,
    unitOfWork: eventing,
    eventStore: eventing.store,
    context: (correlationId) => ({
      ids: { next: () => '00000000-0000-4000-8000-0000000000f1' as Id },
      actor: { kind: 'system', component: 'pipeline.run-lease.sweep' },
      clock: { now: () => NOW },
      correlationId,
      causeEventId: null,
    }),
    clock: { now: () => NOW },
    graceMs: GRACE_MS,
    wallClockMs: WALL_CLOCK_MS,
    limit: 50,
  });

  const [run, stored] = await eventing.transaction(async (scope) => [
    await store.runs.load(scope.tx, RUN),
    await store.tasks.load(scope.tx, TASK),
  ]);
  return { asked, report, run, stored, eventing, store };
};

describe('the run-lease sweep', () => {
  it('asks for both halves of the bound: the lease past its grace, and the wall clock as backstop', async () => {
    const { asked } = await sweep({ claim: true });

    expect(asked).toHaveLength(1);
    // `now - grace` and `now - (wallClock + grace)`: the lease is the primary signal and the wall
    // clock is only for rows that never held one, which is why the two instants are an hour apart
    // at the shipped defaults rather than equal.
    expect(asked[0]?.leaseExpiredBefore).toBe('2026-09-15T09:59:00.000Z');
    expect(asked[0]?.startedBefore).toBe('2026-09-15T08:59:00.000Z');
  });

  it('ends the run as failed with the named reason, and escalates its task', async () => {
    const { report, run, stored } = await sweep({ claim: true });

    expect(report).toEqual({ found: 1, ended: 1, skipped: 0 });
    expect(run?.status).toBe('failed');
    // Never `cancelled` and never `crash`: a missing heartbeat is a fact about the platform, not
    // about the session or about a human.
    expect(run?.terminalReason).toBe('lease_expired');
    expect(stored?.task.state).toBe('needs_human');
  });

  it('records no cost at all, because nobody measured this run (standing rule 16)', async () => {
    const { run, eventing } = await sweep({ claim: true });

    // The row keeps **no** figure: `usd: 0` here is what the cap would read as "this run was free",
    // and the pending term's `coalesce(usd_reported, usd_estimated, 0)` reaches the same 0 from an
    // honest absence instead of from an invented measurement.
    expect(run?.cost).toBeNull();
    const failed = eventing.log.find((row) => row.event.type === 'run.failed')?.event;
    if (failed === undefined) {
      throw new Error('the sweep appended no `run.failed`');
    }
    // The payload the cost ledger reads: both nullish, which is its `no_usage_and_no_cost` branch
    // and therefore no `cost_entries` row, no rollup delta and no budget movement.
    expect((failed.payload as { usage: unknown }).usage).toBeNull();
    expect((failed.payload as { cost: unknown }).cost).toBeNull();
  });

  it('writes nothing when the lease was renewed between the read and the write (rule 42)', async () => {
    const { report, run, stored, eventing } = await sweep({ claim: false });

    expect(report).toEqual({ found: 1, ended: 0, skipped: 1 });
    // All three, because "the row moved" and "the task moved" and "the log grew" are three
    // different ways this could have written something it must not have.
    expect(run?.status).toBe('running');
    expect(stored?.task.state).toBe('active');
    expect(eventing.log.filter((row) => row.event.stream_type === 'run')).toHaveLength(0);
  });

  it('still ends the run when its task cannot be escalated, because the reservation is the point', async () => {
    // A task that has finished has no edge to `needs_human`. The run is the thing holding the
    // budget, so it is ended anyway — escalating a `done` task would be a second wrong answer.
    const { report, run, stored } = await sweep({ claim: true, taskState: 'done' });

    expect(report.ended).toBe(1);
    expect(run?.status).toBe('failed');
    expect(stored?.task.state).toBe('done');
  });
});
