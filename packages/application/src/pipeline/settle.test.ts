/**
 * `settleRun` — transaction 2 as a command (WP-275, TD-031 decision 3).
 *
 * The behaviour transaction 2 already had is held where it always was: `stage-executor.test.ts`
 * drives every ending through the `stage.execute` job, which now calls this command, and those cases
 * are unchanged. What is here is what the command adds, and the one block that tested a moved pure
 * function directly:
 *
 * - **(2) a second settle of a settled run** answers the stored result and appends nothing;
 * - **(3) a settle with a stale fence** is `lease_lost` and changes nothing, live or ended;
 * - **(4) any interleaving of two settles of one run** appends exactly one terminal event — a
 *   fast-check scheduler orders every store call and transaction of the two;
 * - the platform's record on a review verdict, moved from `stage-executor.test.ts` with
 *   `withPlatformReviewRecord`, assertions unchanged.
 *
 * Every settle here is the **production request**: `settleRun` is wrapped (never replaced) at its
 * module, so the job's own call is captured with the deps and request it really built, and a test
 * settles the same run again with exactly those. Building a request by hand would test a request
 * nobody sends.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../ports/logger.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import { PROCEEDING_REFINED_SPEC } from '../testing/artifact-fixtures.js';
import {
  cannotStart,
  createPipelineHarness,
  type HarnessScript,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import {
  NotAStageRunError,
  type SettleRunDeps,
  type SettleRunRequest,
  type SettleRunResult,
  type settleRun,
  withPlatformReviewRecord,
} from './settle.js';
import { LeaseLostError } from './store.js';

type Settle = typeof settleRun;

/** What the job's call is routed through while a test sets it; `null` is the real command alone. */
const hook = vi.hoisted(() => ({
  around: null as
    | null
    | ((real: Settle, deps: SettleRunDeps, request: SettleRunRequest) => Promise<SettleRunResult>),
}));

vi.mock('./settle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settle.js')>();
  return {
    ...actual,
    settleRun: (deps: SettleRunDeps, request: SettleRunRequest) =>
      hook.around === null
        ? actual.settleRun(deps, request)
        : hook.around(actual.settleRun, deps, request),
  };
});

afterEach(() => {
  hook.around = null;
});

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

/** One script per ending of transaction 2: completed, failed, overspent, handed back. */
const ENDINGS: Readonly<Record<string, HarnessScript>> = {
  completed: {
    status: 'completed',
    terminalReason: 'success',
    costUsd: 0.4,
    structuredOutput: PROCEEDING_REFINED_SPEC,
  },
  failed: {
    status: 'failed',
    terminalReason: 'error_during_execution',
    costUsd: 0.2,
    error: 'the CLI exited with 1',
  },
  overspent: {
    status: 'budget_exceeded',
    terminalReason: 'error_max_budget_usd',
    costUsd: 2.5,
    error: 'the platform stopped the run: budget_exceeded',
  },
  handed_back: {
    status: 'failed',
    terminalReason: 'shutdown',
    costUsd: 0.3,
    error: 'the platform stopped the run: shutdown',
    stopReason: 'shutdown',
  },
};

/**
 * The case is the refinement run; a completed one walks on to `architecture`, which is declared not
 * to start, so the walk ends there without a second settle. The other endings stop at refinement.
 */
const harnessWith = (script: HarnessScript): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    runs:
      'status' in script && script.status === 'completed'
        ? {
            refinement: script,
            architecture: cannotStart(
              'the case is the refinement run; nothing after it is settled',
            ),
          }
        : { refinement: script },
  });

const TERMINAL = new Set(['run.finished', 'run.failed']);

/** The run's terminal events in the committed log. */
const terminalEventsOf = (harness: PipelineHarness, runId: Id): readonly DomainEvent[] =>
  harness
    .events()
    .filter(
      (event) =>
        TERMINAL.has(event.type) &&
        (event.payload as { readonly run_id?: string }).run_id === runId,
    );

/** What a settle could change, read back: the run row's ending and the task's spend. */
const stateOf = async (harness: PipelineHarness, runId: Id) => {
  const row = await harness.memory.transaction(async (scope) =>
    harness.store.runs.lockSettlement(scope.tx, runId),
  );
  const [task] = harness.store.snapshot();
  return { row, costActualUsd: task?.costActualUsd, version: task?.version };
};

/**
 * The deps with every `scope.events.append` recorded — so "appends nothing" is read off the calls the
 * settle made, not off a log other handlers are writing to at the same time.
 */
const recordingAppends = (
  deps: SettleRunDeps,
): { readonly deps: SettleRunDeps; readonly appended: DomainEvent[] } => {
  const appended: DomainEvent[] = [];
  const wrap = (scope: TransactionScope): TransactionScope => ({
    ...scope,
    events: new Proxy(scope.events, {
      get: (target, key, receiver) => {
        if (key === 'append') {
          return async (events: readonly DomainEvent[]) => {
            appended.push(...events);
            return target.append(events);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  });
  return {
    appended,
    deps: {
      ...deps,
      unitOfWork: { transaction: (fn) => deps.unitOfWork.transaction((scope) => fn(wrap(scope))) },
    },
  };
};

describe('a second settle of a settled run (WP-275, criterion 2)', () => {
  it.each(Object.keys(ENDINGS))(
    'answers the stored result and appends nothing — %s',
    async (ending) => {
      const harness = harnessWith(ENDINGS[ending] as HarnessScript);
      const seen: {
        value: {
          readonly first: SettleRunResult;
          readonly second: SettleRunResult;
          readonly appended: readonly DomainEvent[];
          readonly before: Awaited<ReturnType<typeof stateOf>>;
          readonly after: Awaited<ReturnType<typeof stateOf>>;
        } | null;
      } = { value: null };
      hook.around = async (real, deps, request) => {
        hook.around = null; // the refinement run's settle only
        const first = await real(deps, request);
        const before = await stateOf(harness, request.runId);
        const recording = recordingAppends(deps);
        const second = await real(recording.deps, request);
        const after = await stateOf(harness, request.runId);
        seen.value = { first, second, appended: recording.appended, before, after };
        return first;
      };
      await harness.publish([ticketMatched()]);

      if (seen.value === null) throw new Error('the job never settled its run');
      const { first, second, appended, before, after } = seen.value;
      expect(first.kind).toBe('settled');
      expect(second.kind).toBe('already_settled');
      // The stored result: the row's ending, the same answer twice.
      expect(first.ending).not.toBeNull();
      expect(second.ending).toEqual(first.ending);
      expect(first.ending?.epoch).toBe(1);
      expect(first.ending?.status).toBe(before.row?.status);
      expect(first.ending?.terminalReason).toBe(before.row?.terminalReason);
      // Appends nothing, and changes nothing a settle writes.
      expect(appended).toEqual([]);
      expect(after).toEqual(before);
      expect(second.outcome.kind).toBe('skipped');
      const runId = first.ending?.runId as Id;
      expect(terminalEventsOf(harness, runId)).toHaveLength(1);
    },
  );
});

describe('a settle with a stale fence (WP-275, criterion 3)', () => {
  const STALE: ReadonlyArray<
    readonly [string, (fence: SettleRunRequest['fence']) => SettleRunRequest['fence']]
  > = [
    ['an older epoch', (fence) => ({ ...fence, epoch: fence.epoch - 1 })],
    ['a newer epoch', (fence) => ({ ...fence, epoch: fence.epoch + 1 })],
    ['another owner', (fence) => ({ ...fence, owner: 'server:another-process' })],
  ];

  it.each(STALE)('is lease_lost on a live run and changes nothing — %s', async (_name, stale) => {
    const harness = harnessWith(ENDINGS.completed as HarnessScript);
    let refused: unknown = null;
    let unchanged = false;
    let appended: readonly DomainEvent[] = ['not read' as unknown as DomainEvent];
    hook.around = async (real, deps, request) => {
      hook.around = null; // the refinement run's settle only
      const before = await stateOf(harness, request.runId);
      const recording = recordingAppends(deps);
      refused = await real(recording.deps, { ...request, fence: stale(request.fence) }).then(
        () => null,
        (error: unknown) => error,
      );
      appended = recording.appended;
      unchanged =
        JSON.stringify(await stateOf(harness, request.runId)) === JSON.stringify(before) &&
        before.row?.status === 'running';
      return real(deps, request);
    };
    await harness.publish([ticketMatched()]);

    expect(refused).toBeInstanceOf(LeaseLostError);
    expect((refused as LeaseLostError).code).toBe('lease_lost');
    expect(appended).toEqual([]);
    expect(unchanged).toBe(true);
    // And the claim's own settle, after it, is the one that ends the run.
    expect(harness.types()).toContain('run.finished');
  });

  it.each(STALE)(
    'is lease_lost on a run already settled, and takes no late-cost path — %s',
    async (_name, stale) => {
      const harness = harnessWith(ENDINGS.completed as HarnessScript);
      let refused: unknown = null;
      let unchanged = false;
      hook.around = async (real, deps, request) => {
        hook.around = null; // the refinement run's settle only
        const first = await real(deps, request);
        const before = await stateOf(harness, request.runId);
        refused = await real(deps, { ...request, fence: stale(request.fence) }).then(
          () => null,
          (error: unknown) => error,
        );
        unchanged =
          JSON.stringify(await stateOf(harness, request.runId)) === JSON.stringify(before);
        return first;
      };
      await harness.publish([ticketMatched()]);

      expect(refused).toBeInstanceOf(LeaseLostError);
      expect(unchanged).toBe(true);
    },
  );

  it('is a skipped job, as the fenced finish already was — the job writes nothing about the run', async () => {
    const harness = harnessWith(ENDINGS.failed as HarnessScript);
    hook.around = async (real, deps, request) =>
      real(deps, { ...request, fence: { ...request.fence, epoch: request.fence.epoch + 1 } });
    await harness.publish([ticketMatched()]);
    // The run stays live: the only settle was refused, and nothing else ends it here.
    expect(harness.types()).not.toContain('run.failed');
    expect(harness.types()).not.toContain('task.escalated');
    const [task] = harness.store.snapshot();
    expect(task?.costActualUsd).toBe(0);
  });
});

describe('two settles of one run, in any interleaving (WP-275, criterion 4)', () => {
  /**
   * Every store call and every transaction the two settles make waits for the scheduler before it
   * runs, so fast-check chooses the order in which their statements land — the interleavings a
   * second settle (a retried job, a re-sent worker `finish`) can meet. The memory store takes no row
   * lock, so this is the harder case for the property: in PostgreSQL the second settle waits on the
   * first's `for update` and the order is serial.
   */
  const scheduled = (s: fc.Scheduler, deps: SettleRunDeps, who: string): SettleRunDeps => {
    const gate = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      await s.schedule(Promise.resolve(`${who}: ${label}`));
      return run();
    };
    const repository = <R extends object>(target: R, name: string): R =>
      new Proxy(target, {
        get: (inner, key, receiver) => {
          const value = Reflect.get(inner, key, receiver);
          return typeof value === 'function'
            ? (...args: unknown[]) =>
                gate(`${name}.${String(key)}`, async () => value.apply(inner, args))
            : value;
        },
      });
    return {
      ...deps,
      store: {
        ...deps.store,
        runs: repository(deps.store.runs, 'runs'),
        tasks: repository(deps.store.tasks, 'tasks'),
      },
      unitOfWork: {
        transaction: (fn) => gate('transaction', async () => deps.unitOfWork.transaction(fn)),
      },
    };
  };

  it('appends exactly one terminal event, and exactly one of the two is the settle', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom(...Object.keys(ENDINGS)),
        async (s, ending) => {
          const harness = harnessWith(ENDINGS[ending] as HarnessScript);
          let results: readonly SettleRunResult[] = [];
          let runId: Id | null = null;
          hook.around = async (real, deps, request) => {
            hook.around = null; // the refinement run's settle only
            runId = request.runId;
            const both = Promise.all([
              real(scheduled(s, deps, 'a'), request),
              real(scheduled(s, deps, 'b'), request),
            ]);
            results = await s.waitFor(both);
            const settled = results.find((result) => result.kind === 'settled');
            return settled ?? (results[0] as SettleRunResult);
          };
          await harness.publish([ticketMatched()]);

          expect(runId).not.toBeNull();
          expect(terminalEventsOf(harness, runId as unknown as Id)).toHaveLength(1);
          expect(results.map((result) => result.kind).sort()).toEqual([
            'already_settled',
            'settled',
          ]);
          // One stored result, answered to both.
          expect(results[0]?.ending).toEqual(results[1]?.ending);
          expect(results[0]?.ending).not.toBeNull();
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);
});

/**
 * WP-45 criterion 4: *which checklist was applied* is the platform's record, stamped over the
 * model's. The walk through the executor is `review-only.test.ts`; these are the three answers.
 *
 * Moved from `stage-executor.test.ts` with the function (WP-275), assertions unchanged.
 */
describe('the platform’s record on a review verdict', () => {
  const MODEL = { verdict: 'approve', checklists_applied: [{ name: 'forged', item_count: 9 }] };

  it('replaces the model’s claim with what the planner put in the prompt', () => {
    const applied = [
      { name: 'payments', item_count: 2, required_by: ['payments'], truncated: false },
    ];
    expect(withPlatformReviewRecord('ReviewVerdict', MODEL, applied)).toEqual({
      verdict: 'approve',
      checklists_applied: applied,
    });
  });

  it('records "not recorded" as null when the planner said nothing — never the model’s value', () => {
    expect(withPlatformReviewRecord('ReviewVerdict', MODEL, null)).toEqual({
      verdict: 'approve',
      checklists_applied: null,
    });
  });

  it('leaves every other artifact type exactly as the model wrote it', () => {
    expect(withPlatformReviewRecord('AcceptanceVerdict', MODEL, [])).toBe(MODEL);
  });
});

/**
 * **A run with no plan row** (WP-275a criterion 4): planned before the row that writes it, and
 * reachable only through a settle of a run in flight across that upgrade. It settles — with no
 * review checklists, the **live** question timeout read from the project's settings in the settle's
 * own transaction, and a `warn` naming `run_plan_missing`; a run with its plan reads no settings.
 */
describe('a settle of a run with no stored plan (WP-275a)', () => {
  const settleObserved = async (missing: boolean) => {
    const harness = harnessWith(ENDINGS.completed as HarnessScript);
    const seen: {
      result: SettleRunResult | null;
      warnings: string[];
      settingsReads: number;
    } = { result: null, warnings: [], settingsReads: 0 };
    hook.around = async (real, deps, request) => {
      hook.around = null; // the refinement run's settle only
      const observed: SettleRunDeps = {
        ...deps,
        settings: async (projectId, tx) => {
          seen.settingsReads += 1;
          return deps.settings(projectId, tx);
        },
        logger: {
          ...silentLogger,
          warn: (_fields: unknown, message: string) => {
            seen.warnings.push(message);
          },
        } as SettleRunDeps['logger'],
        store: missing
          ? { ...deps.store, runPlans: { ...deps.store.runPlans, load: async () => null } }
          : deps.store,
      };
      seen.result = await real(observed, request);
      return seen.result;
    };
    await harness.publish([ticketMatched()]);
    return seen;
  };

  it('settles with the live question timeout and warns run_plan_missing', async () => {
    const seen = await settleObserved(true);
    expect(seen.result?.kind).toBe('settled');
    expect(seen.result?.outcome.kind).toBe('ran');
    expect(seen.warnings.some((message) => message.startsWith('run_plan_missing'))).toBe(true);
    expect(seen.settingsReads).toBe(1);
  });

  it('reads no settings and warns nothing when the plan is there', async () => {
    const seen = await settleObserved(false);
    expect(seen.result?.kind).toBe('settled');
    expect(seen.warnings.filter((message) => message.startsWith('run_plan_missing'))).toEqual([]);
    expect(seen.settingsReads).toBe(0);
  });
});

/**
 * **A stage-less run is not `settleRun`'s** (TD-031's 2026-11-04 amendment §1): the shared
 * `toRunAggregate` admits one, and the command refuses it as `not_a_stage_run` — an ask's ending is
 * the ask's (decision 13). And a run whose row is gone (its task deleted, the row with it by cascade)
 * is `task_gone`: nothing written, `ending: null`.
 */
describe('the runs settleRun refuses or finds gone (WP-275a)', () => {
  it('refuses a run linked to no stage, and answers task_gone for a run that does not exist', async () => {
    const harness = harnessWith(ENDINGS.completed as HarnessScript);
    let checked = false;
    hook.around = async (real, deps, request) => {
      hook.around = null;
      const gone = await real(deps, {
        ...request,
        runId: '00000000-0000-4000-8000-00000000dead' as Id,
      });
      expect(gone).toMatchObject({ kind: 'task_gone', ending: null });
      const stageless: SettleRunDeps = {
        ...deps,
        store: {
          ...deps.store,
          runs: {
            ...deps.store.runs,
            load: async (tx, runId) => {
              const row = await deps.store.runs.load(tx, runId);
              return row === null ? null : { ...row, stage: null };
            },
          },
        },
      };
      await expect(real(stageless, request)).rejects.toThrow(NotAStageRunError);
      checked = true;
      return real(deps, request);
    };
    await harness.publish([ticketMatched()]);
    expect(checked).toBe(true);
  });
});
