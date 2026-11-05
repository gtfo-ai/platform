/**
 * The server's claimant loop (WP-276): it claims an offer the job left, runs it from the stored plan
 * on its own runner, and settles it through the offer's kind — and it **stops** a run whose lease it
 * lost (TD-031 §2): an answered `lease_lost` interrupts the session at once and the settle is still
 * asked (it answers `lease_lost` or the stored ending), while self-termination pushes nothing more.
 *
 * The offers come from a harness composed with **no** claimant (`runsAgents: false`), so the job
 * ends at the offer exactly as on a core with no launcher; the claimant under test is built here
 * over the same store, with a runner and settles this file controls.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { DEFAULT_WIP_LIMITS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { BlockingBudget } from '../cost/guard.js';
import type { ClaudeRunner, RunHandle, RunOutcome, RunStartHooks } from '../ports/runner.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { createTestRunPlanSealer } from '../testing/run-plans.js';
import { createClaimAdmission } from './claim-admission.js';
import { createRunClaimant } from './claimant.js';
import type { RunLeaseLoss } from './lease.js';
import type { SettleRunRequest } from './settle.js';
import { createRunStopReasons } from './stop-reasons.js';
import { LeaseLostError } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000002b1';

const ticketMatched = (key: string, seq: number): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: `00000000-0000-4000-9000-0000000002${String(seq).padStart(2, '0')}`,
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: seq,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

const outcomeOf = (runId: Id, status: RunOutcome['status']): RunOutcome => ({
  runId,
  status,
  terminalReason: status === 'cancelled' ? 'cancelled' : 'success',
  sessionId: null,
  numTurns: 1,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  modelUsage: [],
  cost: { usd: 0.01, is_estimate: false, price_list_id: null },
  wallMs: 10,
  structuredOutput: null,
  error: null,
  redactionCount: 0,
});

/** A runner whose sessions this file ends: by `finish(runId)`, or by the claimant's own stop. */
const controlledRunner = () => {
  const sessions = new Map<Id, { finish: (outcome: RunOutcome) => void; stops: string[] }>();
  const runner: ClaudeRunner = {
    start: (spec, hooks: RunStartHooks): RunHandle => {
      let finish: (outcome: RunOutcome) => void = () => {};
      const outcome = new Promise<RunOutcome>((resolve) => {
        finish = resolve;
      });
      const stops: string[] = [];
      sessions.set(spec.runId, { finish, stops });
      void hooks.beforeCliSpawn();
      return {
        runId: spec.runId,
        sessionId: null,
        outcome,
        steer: async () => {},
        stop: async (stop) => {
          stops.push(stop.reason);
          finish(outcomeOf(spec.runId, 'cancelled'));
        },
      };
    },
  };
  return { runner, sessions };
};

/** A harness that offers and never claims, plus a claimant over its store with the given lease. */
const world = async (options: {
  readonly settle?: (request: SettleRunRequest) => Promise<{ kind: 'settled' }>;
  readonly concurrency?: number;
  readonly tickets?: number;
  /** WP-278: what to set on the store before the first ticket is offered. */
  readonly before?: (harness: PipelineHarness) => void;
  /** Backlog 744: the budget the claim's admission re-check asks; absent, no re-check. */
  readonly budgetAtClaim?: () => BlockingBudget | null;
  /** Backlog 744: the task cap the re-check reads (the offer was admitted under the default). */
  readonly taskBudgetAtClaim?: () => number | undefined;
}) => {
  const harness: PipelineHarness = createPipelineHarness({
    projectId: PROJECT,
    runsAgents: false,
    // Room for every ticket a case files, so each gets its own offer.
    settings: { wip: { ...DEFAULT_WIP_LIMITS, maxParallelTasks: 10, maxParallelRuns: 10 } },
  });
  options.before?.(harness);
  for (let index = 1; index <= (options.tickets ?? 1); index += 1) {
    await harness.publish([ticketMatched(`ACME-${index}`, index)]);
  }
  const { runner, sessions } = controlledRunner();
  const settled: SettleRunRequest[] = [];
  let lose: ((loss: RunLeaseLoss) => void) | undefined;
  const claimant = createRunClaimant({
    unitOfWork: harness.memory,
    store: harness.store,
    runner,
    stopReasons: createRunStopReasons(),
    context: harness.commands.context,
    clock: { now: () => harness.clock.now() },
    runPlans: createTestRunPlanSealer(),
    eventStore: harness.memory.store,
    lease: {
      owner: 'server:claimant-test',
      schedule: () => () => {},
      timer: () => () => {},
    },
    settle: {
      stage: async (request) => {
        settled.push(request);
        return (await options.settle?.(request)) ?? { kind: 'settled' };
      },
      ask: async (request) => {
        settled.push(request);
        return { kind: 'settled' };
      },
    },
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.budgetAtClaim === undefined && options.taskBudgetAtClaim === undefined
      ? {}
      : {
          admission: createClaimAdmission({
            store: harness.store,
            settings: async () => {
              const cap = options.taskBudgetAtClaim?.();
              return cap === undefined
                ? harness.settings
                : { ...harness.settings, taskBudgetUsd: cap };
            },
            budgets: { blockingFor: async () => options.budgetAtClaim?.() ?? null },
            eventStore: harness.memory.store,
            context: harness.commands.context,
          }),
        }),
  });
  return {
    harness,
    claimant,
    sessions,
    settled,
    setLose: (fn: (loss: RunLeaseLoss) => void) => {
      lose = fn;
    },
    lose: (loss: RunLeaseLoss) => lose?.(loss),
  };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the server claimant (WP-276)', () => {
  it('finds the job ended at an open offer, claims it under its owner, and settles with the claim’s fence', async () => {
    const { harness, claimant, sessions, settled } = await world({});
    const [offer] = harness.store.offerRows();
    expect(offer?.state).toBe('open');
    expect(harness.specs).toEqual([]); // the job ran no session

    const drained = claimant.drain();
    await tick();
    await tick();
    const runId = offer?.runId as Id;
    expect(harness.store.offerRows()[0]?.state).toBe('claimed');
    sessions.get(runId)?.finish(outcomeOf(runId, 'completed'));
    expect(await drained).toBe(1);

    expect(settled).toHaveLength(1);
    expect(settled[0]?.runId).toBe(runId);
    expect(settled[0]?.fence).toEqual({ epoch: 1, owner: 'server:claimant-test' });
    expect(harness.types()).toContain('run.claimed');
    // Backlog 709: `run.started` carries the pack read back from the stored rows.
    const started = harness.events().find((event) => event.type === 'run.started');
    expect(started?.payload).toMatchObject({ context_pack: { tier0: expect.any(Array) } });
  });

  it('claims at most APP_RUNNER_CONCURRENCY runs at once', async () => {
    const { harness, claimant, sessions } = await world({ concurrency: 1, tickets: 2 });
    expect(harness.store.offerRows().filter((row) => row.state === 'open')).toHaveLength(2);
    const drained = claimant.drain();
    await tick();
    await tick();
    expect(claimant.active).toBe(1);
    expect(harness.store.offerRows().filter((row) => row.state === 'claimed')).toHaveLength(1);
    for (const [runId, session] of sessions) session.finish(outcomeOf(runId, 'completed'));
    await tick();
    await tick();
    for (const [runId, session] of sessions) session.finish(outcomeOf(runId, 'completed'));
    expect(await drained).toBe(2);
  });

  it('settles a run whose plan cannot be read back as not started, never re-planning it', async () => {
    const { harness, claimant, settled } = await world({});
    const runId = harness.store.offerRows()[0]?.runId as Id;
    // An `APP_SECRET_KEY` rotated without its previous generation: the seal does not open.
    const other = createRunClaimant({
      unitOfWork: harness.memory,
      store: harness.store,
      runner: {
        start: () => {
          throw new Error('a run whose plan is unreadable must not start');
        },
      },
      stopReasons: createRunStopReasons(),
      context: harness.commands.context,
      clock: { now: () => harness.clock.now() },
      runPlans: createTestRunPlanSealer('another-key'),
      eventStore: harness.memory.store,
      settle: {
        stage: async (request) => {
          settled.push(request);
          return { kind: 'settled' };
        },
        ask: async () => ({ kind: 'settled' }),
      },
    });
    expect(await other.drain()).toBe(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.runId).toBe(runId);
    expect(settled[0]?.outcome).toMatchObject({ kind: 'not_started', transient: false });
    expect(claimant.active).toBe(0);
  });

  it('ends quietly on task_gone: the session is over (its workspace released) and nothing is written', async () => {
    const { harness, claimant, sessions, settled } = await world({
      settle: async () => ({ kind: 'task_gone' }) as never,
    });
    const runId = harness.store.offerRows()[0]?.runId as Id;
    const drained = claimant.drain();
    await tick();
    await tick();
    sessions.get(runId)?.finish(outcomeOf(runId, 'completed'));
    await expect(drained).resolves.toBe(1);
    expect(settled).toHaveLength(1);
    expect(claimant.active).toBe(0);
  });

  it('logs a lease_lost settle and writes nothing more, without throwing out of the loop', async () => {
    const { harness, claimant, sessions } = await world({
      settle: async (request) => {
        throw new LeaseLostError(request.runId, request.fence);
      },
    });
    const runId = harness.store.offerRows()[0]?.runId as Id;
    const drained = claimant.drain();
    await tick();
    await tick();
    sessions.get(runId)?.finish(outcomeOf(runId, 'completed'));
    await expect(drained).resolves.toBe(1);
  });
});

/**
 * The lease loss itself, through the heartbeat the claimant composes: a fake monotonic clock and
 * timer, and a store whose renewal the case decides.
 */
describe('a claimant that loses its lease (TD-031 §2)', () => {
  const lossWorld = async (renewal: 'lost' | 'throws') => {
    const harness = createPipelineHarness({ projectId: PROJECT, runsAgents: false });
    await harness.publish([ticketMatched('ACME-1', 1)]);
    const { runner, sessions } = controlledRunner();
    let tickBeat: (() => void) | undefined;
    const timers: (() => void)[] = [];
    const store = {
      ...harness.store,
      runs: {
        ...harness.store.runs,
        renewLease: async () => {
          if (renewal === 'throws') throw new Error('the database is unreachable');
          return false;
        },
      },
    } as typeof harness.store;
    const settled: SettleRunRequest[] = [];
    const claimant = createRunClaimant({
      unitOfWork: harness.memory,
      store,
      runner,
      stopReasons: createRunStopReasons(),
      context: harness.commands.context,
      clock: { now: () => harness.clock.now() },
      runPlans: createTestRunPlanSealer(),
      eventStore: harness.memory.store,
      lease: {
        owner: 'server:claimant-test',
        schedule: (_ms, beat) => {
          tickBeat = beat;
          return () => {};
        },
        monotonicNow: () => 0,
        timer: (_ms, fire) => {
          timers.push(fire);
          return () => {};
        },
      },
      settle: {
        stage: async (request) => {
          settled.push(request);
          return { kind: 'settled' };
        },
        ask: async () => ({ kind: 'settled' }),
      },
    });
    const runId = harness.store.offerRows()[0]?.runId as Id;
    return {
      claimant,
      sessions,
      settled,
      runId,
      beat: () => tickBeat?.(),
      selfStop: () => timers.at(-1)?.(),
    };
  };

  it('stops the session at once on an answered lease_lost, and still asks the settle (which arbitrates)', async () => {
    const { claimant, sessions, settled, runId, beat } = await lossWorld('lost');
    const drained = claimant.drain();
    await tick();
    await tick();
    beat();
    await tick();
    await drained;
    expect(sessions.get(runId)?.stops).toEqual(['cancelled']);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome).toMatchObject({ status: 'cancelled' });
  });

  it('lets a failed beat interrupt nothing', async () => {
    const { claimant, sessions, runId, beat } = await lossWorld('throws');
    const drained = claimant.drain();
    await tick();
    await tick();
    beat();
    await tick();
    expect(sessions.get(runId)?.stops).toEqual([]);
    sessions.get(runId)?.finish(outcomeOf(runId, 'completed'));
    await drained;
  });

  it('self-terminates: stops the session, destroys the workspace and pushes nothing more — no settle', async () => {
    const { claimant, sessions, settled, runId, selfStop } = await lossWorld('throws');
    const drained = claimant.drain();
    await tick();
    await tick();
    selfStop();
    await drained;
    expect(sessions.get(runId)?.stops).toEqual(['cancelled']);
    expect(settled, 'a self-terminated claimant must not settle; the row is the sweep’s').toEqual(
      [],
    );
  });
});

describe('the server claimant and execution routing (WP-278, TD-031 decision 8)', () => {
  it('takes an offer only from its server_from: a workers-preferred project waits its fallback', async () => {
    const { harness, claimant, sessions } = await world({
      before: (built) =>
        built.store.setExecutionSettings(PROJECT as Id, {
          mode: 'hybrid',
          prefer: 'workers',
          fallbackAfterSeconds: 30,
          assigneeWindowSeconds: 120,
          offerTimeoutSeconds: 86_400,
        }),
    });
    const [offer] = harness.store.offerRows();
    expect(offer?.routing.workersFrom).toBe(offer?.offeredAt);
    expect(Date.parse(offer?.routing.serverFrom ?? '') - Date.parse(offer?.offeredAt ?? '')).toBe(
      30_000,
    );
    expect(await claimant.drain()).toBe(0);
    expect(harness.store.offerRows()[0]?.state).toBe('open');

    harness.clock.advance(30_000);
    const drained = claimant.drain();
    await tick();
    await tick();
    const runId = offer?.runId as Id;
    sessions.get(runId)?.finish(outcomeOf(runId, 'completed'));
    expect(await drained).toBe(1);
  });

  it('never takes a workers_only project’s offer', async () => {
    const { harness, claimant } = await world({
      before: (built) =>
        built.store.setExecutionSettings(PROJECT as Id, {
          mode: 'workers_only',
          prefer: 'server',
          fallbackAfterSeconds: null,
          assigneeWindowSeconds: 120,
          offerTimeoutSeconds: 86_400,
        }),
    });
    expect(harness.store.offerRows()[0]?.routing.serverFrom).toBeNull();
    harness.clock.advance(86_000_000);
    expect(await claimant.drain()).toBe(0);
  });

  it('writes its liveness row when it starts and deletes it when it stops', async () => {
    const { harness, claimant } = await world({ tickets: 0 });
    expect(harness.store.serverClaimantHolders()).toEqual([]);
    await claimant.start();
    expect(harness.store.serverClaimantHolders()).toEqual(['server:claimant-test']);
    await claimant.stop();
    expect(harness.store.serverClaimantHolders()).toEqual([]);
  });
});

/**
 * TD-031 §2 (backlog 744): the admission is asked again at the claim. An offer admitted at the offer
 * can wait while the scope spends; the claim that finds a budget spent takes nothing, withdraws the
 * offer and pauses the task — exactly as the offer-time admission pauses it.
 */
describe('the admission re-check at the claim (backlog 744)', () => {
  const PROJECT_BLOCKER: BlockingBudget = {
    id: '00000000-0000-4000-8000-0000000007a4',
    scope: 'project',
    window: 'month',
    limitUsd: 10,
    spentUsd: 10,
    pendingUsd: 0,
    heldUsd: 0,
    heldRuns: 0,
    reserveUsd: 0,
    windowStart: '2026-06-01T00:00:00.000Z',
  } as BlockingBudget;

  it('claims as before while nothing refuses it', async () => {
    const { harness, claimant, sessions } = await world({ budgetAtClaim: () => null });
    const runId = harness.store.offerRows()[0]?.runId as Id;
    const drained = claimant.drain();
    await tick();
    await tick();
    expect(harness.store.offerRows()[0]?.state).toBe('claimed');
    sessions.get(runId)?.finish(outcomeOf(runId, 'completed'));
    expect(await drained).toBe(1);
  });

  it('a project budget spent since the offer: no claim, the offer withdrawn, the task paused', async () => {
    let blocked = false;
    const { harness, claimant, sessions } = await world({
      budgetAtClaim: () => (blocked ? PROJECT_BLOCKER : null),
    });
    blocked = true;
    expect(await claimant.drain()).toBe(0);
    expect(sessions.size).toBe(0);
    // The claim's transaction threw before `run.claimed` was appended. PostgreSQL rolls the claim
    // statement back with it, so `refuse` finds the offer open and withdraws it; this store keeps a
    // rolled-back write (its divergence 4), so the offer's own state is not asserted here.
    expect(harness.types()).not.toContain('run.claimed');
    const paused = harness.events().find((event) => event.type === 'task.paused');
    expect(paused?.payload).toMatchObject({ reason: 'budget', budget_scope: 'project' });
  });

  it('a task cap the task has reached since the offer: paused with the task scope', async () => {
    let cap: number | undefined;
    const { harness, claimant } = await world({ taskBudgetAtClaim: () => cap });
    cap = 0.01; // below one run's reservation: the task cannot take this run any more
    expect(await claimant.drain()).toBe(0);
    expect(harness.types()).not.toContain('run.claimed');
    const paused = harness.events().find((event) => event.type === 'task.paused');
    expect(paused?.payload).toMatchObject({ reason: 'budget', budget_scope: 'task' });
  });
});
