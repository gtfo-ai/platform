/**
 * The stage executor's endings.
 *
 * The happy one is asserted by `saga.test.ts`, which walks a whole template through it. These are
 * the ones a template never reaches by itself: a run that overspends, a run whose cost the platform
 * could not read, a run that produced no artifact, and a job that arrives after the task has moved.
 */
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { RunStartError } from '../ports/runner.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import { RUN_START_RETRY_MS } from './jobs.js';
import {
  COST_UNREPORTED,
  MAX_RUN_START_ATTEMPTS,
  runBudgetUsd,
  taskBudgetExhausted,
} from './stage-executor.js';
import { TaskConcurrentModificationError } from './store.js';
import { MAX_TASK_CONFLICT_ATTEMPTS } from './task-conflict.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-1',
        url: 'https://jira.example.test/browse/ACME-1',
      },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

const harnessWith = (options: HarnessOptions): PipelineHarness =>
  createPipelineHarness({ projectId: PROJECT, ...options });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const escalationOf = (harness: PipelineHarness) =>
  harness.events().find((entry) => entry.type === 'task.escalated') as
    | Extract<DomainEvent, { type: 'task.escalated' }>
    | undefined;

describe('a run the platform stopped', () => {
  it('pauses the task when the run really did overspend', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 2.5,
          error: 'the platform stopped the run: budget_exceeded',
        },
      },
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('paused');
    expect(harness.types()).toContain('task.paused');
    // The spend is real, so it is counted.
    expect(task.costActualUsd).toBeCloseTo(2.5, 6);
    expect(escalationOf(harness)).toBeUndefined();
  });

  it('escalates when the platform could not tell what the run cost', async () => {
    // WP-12 publishes this fault *as* `budget_exceeded` / `error_max_budget_usd`, because the
    // terminal-reason enum has no name for it. Branching on the status alone would pause the task
    // and tell a human to raise a cap that was never reached.
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 0,
          stopReason: COST_UNREPORTED,
          error: 'the platform stopped the run: cost_unreported — …',
        },
      },
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('needs_human');
    expect(harness.types()).not.toContain('task.paused');
    const escalation = escalationOf(harness);
    expect(escalation?.payload.reason).toContain('could not tell what the run cost');
  });

  it('tells the two apart by the transcript row, not by the status', async () => {
    // Rule 10 as an experiment: the only difference between these two harnesses is the
    // `run_stopped` row, and the endings differ.
    const spec = {
      status: 'budget_exceeded' as const,
      terminalReason: 'error_max_budget_usd' as const,
      costUsd: 1,
    };
    const overspent = harnessWith({ runs: { refinement: spec } });
    const blind = harnessWith({ runs: { refinement: { ...spec, stopReason: COST_UNREPORTED } } });
    await overspent.publish([ticketMatched()]);
    await blind.publish([ticketMatched()]);
    expect(taskOf(overspent).task.state).toBe('paused');
    expect(taskOf(blind).task.state).toBe('needs_human');
  });

  it('escalates a run that failed, and does not retry it', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'failed',
          terminalReason: 'error_during_execution',
          error: 'the CLI exited with 1',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(harness.specs).toHaveLength(1);
    expect(harness.types()).toContain('run.failed');
  });

  it('escalates a completed run that produced no artifact', async () => {
    const harness = harnessWith({
      runs: {
        refinement: { status: 'completed', terminalReason: 'success', structuredOutput: null },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(escalationOf(harness)?.payload.reason).toContain('produced no artifact');
  });

  it('escalates a completed run whose artifact carries no verdict the platform knows', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: { decision: 'ship it' },
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(escalationOf(harness)?.payload.reason).toContain('"ship it"');
  });
});

describe('the task budget', () => {
  it('pauses before the run rather than after it', async () => {
    const harness = harnessWith({
      // Refinement's default cap is 2 USD (product/04's table), so a 1 USD task budget cannot
      // afford it and nothing is spent at all.
      settings: { taskBudgetUsd: 1 },
      runs: {
        refinement: { status: 'completed', terminalReason: 'success', structuredOutput: {} },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('paused');
    expect(harness.specs).toHaveLength(0);
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  it('counts what this run may spend, not only what the task has spent', () => {
    const settings = { config: {}, taskBudgetUsd: 10 } as never;
    const stored = { costActualUsd: 9 } as never;
    // 9 spent + refinement's 2 USD cap is over 10, even though 9 is under it.
    expect(taskBudgetExhausted(stored, settings, 'refinement')).toBe(true);
    expect(taskBudgetExhausted({ costActualUsd: 7 } as never, settings, 'refinement')).toBe(false);
  });

  it('takes the per-run cap from the project when it sets one', () => {
    const withOverride = {
      config: { stages: { refinement: { budget_usd: 0.5 } } },
      taskBudgetUsd: 50,
    } as never;
    expect(runBudgetUsd(withOverride, 'refinement')).toBe(0.5);
    expect(runBudgetUsd({ config: {} } as never, 'refinement')).toBe(2);
    // A stage product/04's table does not name still gets a cap rather than none.
    expect(runBudgetUsd({ config: {} } as never, 'security_scan')).toBe(5);
  });
});

/**
 * **A run that was created and could not be started** — WP-15c's Q52/Q60 decision.
 *
 * The production runner of every build until Q52 is answered throws from `start`
 * (`apps/server/src/pipeline.ts`'s `unavailableClaudeRunner`), and the day a webhook can reach the
 * pipeline is the day a real ticket meets it. Before this branch existed, the throw escaped both of
 * the executor's endings: transaction 1 had already written the `runs` row and emitted
 * `run.created`/`run.started`, so the run stayed `running` for ever, the task sat at its stage, and
 * the `stage.execute` job retried into pg-boss where no screen shows it.
 *
 * The answer is **no new task state**: `escalated` already means *a human must act*, and it is what
 * the executor does for every other run that ends without a usable result.
 */
describe('a run that could not be started', () => {
  class RunnerUnavailableForTest extends Error {
    override readonly name = 'RunnerUnavailableError';
  }

  const harnessThatCannotStart = (): PipelineHarness =>
    harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          throwsOnStart: new RunnerUnavailableForTest(
            'no ClaudeRunner is composed in this build (Q52) — FAKE-PLANTED-secret-0123456789',
          ),
        },
      },
    });

  it('escalates the task instead of leaving it at a stage nothing will move', async () => {
    const harness = harnessThatCannotStart();
    await harness.publish([ticketMatched()]);

    // `needs_human` is the task state `escalateTask` produces (technical/02's state machine); the
    // point of the decision is that it is an **existing** one, not a new "cannot start" state.
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(escalationOf(harness)?.payload.reason).toContain('could not be started');
  });

  it('records the run it had already created as failed, rather than leaving it running', async () => {
    const harness = harnessThatCannotStart();
    await harness.publish([ticketMatched()]);

    const failed = harness.events().find((entry) => entry.type === 'run.failed');
    expect(
      failed,
      'the run row exists because transaction 1 wrote it; its failure is the honest record',
    ).toBeDefined();
    expect((failed as Extract<DomainEvent, { type: 'run.failed' }>).payload.terminal_reason).toBe(
      'error_during_execution',
    );
    // Nothing ran, so nothing was spent — and `is_estimate: false`, because "nothing" is measured.
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  /**
   * The **class name, never the message** (BD-022, TD-012): this string is written to
   * `events.payload` (`run.failed`) and into the escalation's blocker brief, and an error thrown out
   * of a runner may quote a provider, a URL or a credential. The executor holds no redactor, so the
   * only safe thing to carry is the name.
   */
  it('names the error class and carries no word of its message into the event log', async () => {
    const harness = harnessThatCannotStart();
    await harness.publish([ticketMatched()]);

    const serialised = JSON.stringify(harness.events());
    expect(serialised).toContain('RunnerUnavailableError');
    expect(serialised).not.toContain('FAKE-PLANTED-secret-0123456789');
    expect(serialised).not.toContain('no ClaudeRunner is composed');
  });
});

/**
 * **A start that failed for a *transport* reason** — Q59(a), decided on WP-15g.
 *
 * The section above is the terminal case and is unchanged. This is the other half: the runner reaches
 * its workspace over a Unix socket on a shared volume (TD-025 §2), so a launcher restarting is a
 * condition that is over in seconds — while escalation happens on the *first* failure, so a flapping
 * transport would park one task and need one human per flap.
 *
 * Both directions are asserted, because "it retries" and "the retry is bounded" are different claims
 * and a build with only the first is a build that hides a dead launcher (standing rule 42).
 */
describe('a run whose start failed for a transport reason', () => {
  const transportFailure = () =>
    new RunStartError(
      'the run shim did not answer on /run/agentic/ctl/<run>/ctl.sock — FAKE-PLANTED-secret-0123456789',
      { retryable: true },
    );

  const harnessThatFlaps = (): PipelineHarness =>
    harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          throwsOnStart: transportFailure(),
        },
      },
    });

  it('leaves the task at its stage and re-enqueues the stage on a timer', async () => {
    const harness = harnessThatFlaps();
    await harness.publish([ticketMatched()]);

    // Still running, still at refinement, still on attempt 1: exactly the state `revalidate` admits,
    // which is what makes the re-enqueue below a wake-up rather than a no-op.
    expect(taskOf(harness).task.state).toBe('active');
    expect(taskOf(harness).task.currentStage).toBe('refinement');
    expect(escalationOf(harness)).toBeUndefined();
    // The run really was created, so its failure is recorded rather than left `running` (WP-15c).
    expect(harness.types()).toContain('run.failed');

    const queued = harness.jobs.enqueued.filter((request) => request.queue === 'stage.execute');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toMatchObject({ stage: 'refinement', start_attempts: 1 });
    // A delay, not a spin: `drain` ran every job whose timer had come and this one had not.
    expect(queued[0]?.startAfter?.getTime()).toBe(harness.clock.epochMs + RUN_START_RETRY_MS);
  });

  it('escalates once the attempts are spent, and not before', async () => {
    const harness = harnessThatFlaps();
    await harness.publish([ticketMatched()]);

    const attempts: string[] = [taskOf(harness).task.state];
    for (let round = 0; round < MAX_RUN_START_ATTEMPTS; round += 1) {
      harness.clock.advance(RUN_START_RETRY_MS);
      await harness.drain();
      attempts.push(taskOf(harness).task.state);
    }

    // Two retries after the first failure, then the third failure escalates: the bound is
    // `MAX_RUN_START_ATTEMPTS`, and the states show it rather than a single end assertion (rule 10).
    expect(attempts).toEqual(['active', 'active', 'needs_human', 'needs_human']);
    expect(escalationOf(harness)?.payload.reason).toContain('could not be started');
    // One failed `runs` row per flap — the signal an operator reads, and the reason the bound exists.
    expect(harness.types().filter((type) => type === 'run.failed')).toHaveLength(
      MAX_RUN_START_ATTEMPTS,
    );
    // Nothing is queued after the escalation: an unbounded retry would hide the dead launcher.
    expect(
      harness.jobs.enqueued.filter((request) => request.queue === 'stage.execute'),
    ).toHaveLength(0);
  });

  it('treats a failure it cannot classify as terminal, and carries no message into the log', async () => {
    // The fail-closed default: only a `RunStartError` with `retryable: true` retries. A plain error
    // — a programming fault, a bad spec — escalates on the first failure.
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          throwsOnStart: new RunStartError('the launcher refused this spec', { retryable: false }),
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('needs_human');

    const flapping = harnessThatFlaps();
    await flapping.publish([ticketMatched()]);
    const serialised = JSON.stringify(flapping.events());
    expect(serialised).toContain('RunStartError');
    expect(serialised).not.toContain('FAKE-PLANTED-secret-0123456789');
    expect(serialised).not.toContain('ctl.sock');
  });
});

/**
 * **A write that lost every race** — WP-15e, criterion 4.
 *
 * `save` refuses a snapshot another transaction has moved, which is the whole of backlog 18's fix,
 * and a refusal with no ending is the same lost update wearing a stack trace. The executor owns its
 * transactions, so it owns the retry; when the bound is spent the task is parked for a human rather
 * than left at a stage whose run has already been paid for.
 *
 * The conflict is planted at the one site that raises `cost_actual` — transaction 2 — because that
 * is the write whose loss was measured (2.40 where 2.80 was owed) and because it leaves the
 * escalation's own save, which reads a task at cost 0, free to succeed.
 */
describe('a stage write that lost every race with another writer', () => {
  const harnessThatAlwaysConflicts = (): { harness: PipelineHarness; conflicts: () => number } => {
    const harness = harnessWith({
      runs: { refinement: { status: 'completed', terminalReason: 'success', costUsd: 0.4 } },
    });
    const repository = harness.store.tasks as {
      save: typeof harness.store.tasks.save;
    };
    const real = repository.save.bind(harness.store.tasks);
    let conflicts = 0;
    repository.save = async (tx, stored) => {
      if (stored.costActualUsd > 0) {
        conflicts += 1;
        throw new TaskConcurrentModificationError(
          stored.task.id,
          stored.version,
          stored.version + 1,
        );
      }
      return real(tx, stored);
    };
    return { harness, conflicts: () => conflicts };
  };

  it('re-reads and re-decides exactly as many times as the bound allows', async () => {
    const { harness, conflicts } = harnessThatAlwaysConflicts();
    await harness.publish([ticketMatched()]);
    expect(conflicts()).toBe(MAX_TASK_CONFLICT_ATTEMPTS);
  });

  it('parks the task for a human instead of dropping the run it could not record', async () => {
    const { harness } = harnessThatAlwaysConflicts();
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(escalationOf(harness)?.payload.reason).toContain('another writer won');
    // Nothing was written from the stale snapshot: the spend the losing transaction carried is not
    // on the row, because its transaction rolled back every time.
    expect(taskOf(harness).costActualUsd).toBe(0);
  });
});
