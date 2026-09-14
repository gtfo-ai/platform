/**
 * Where an HTTP request finds the **live** run it wants to steer or take over (WP-27).
 *
 * technical/04 § "Streaming and steering": *"the run's input is an async queue; a `run.steered`
 * command pushes an `SDKUserMessage`"*. That queue belongs to a `RunHandle`, the handle belongs to
 * whoever called `ClaudeRunner.start`, and a `POST /api/runs/:id/steer` arrives somewhere else
 * entirely — in this build, on the same process's HTTP thread; in a deployment with a separate API
 * container, in a different process. This is the seam that closes the first gap and **states** the
 * second rather than pretending it is closed.
 *
 * ## It wraps the runner; nothing calls `register`
 *
 * The shape is `RunStopReasons`' (`./stop-reasons.ts`), and for the same reason: a composition root
 * wraps its collaborator once and everything downstream is unchanged. `observe(runner)` returns a
 * `ClaudeRunner` whose `start` records the handle and drops it the moment the run's outcome settles
 * — whichever way it settled, including a rejection, because a handle whose run has crashed is a
 * handle whose `steer` would be a silent no-op (`claude-runner.ts` returns early once its input
 * queue is closed).
 *
 * The stage executor therefore needs no new option and no new line: it is the runner it was given
 * that keeps the register. A process that composes no pipeline (the API-only role) wraps nothing,
 * and every steer it is asked for answers {@link RunNotReachableError} by name.
 *
 * ## What "not here" means, and why it is a refusal rather than a wait
 *
 * `forRun` and `forTask` answer `null` for three different situations, and the caller may not tell them
 * apart: the run ended a moment ago, the run is live **in another process** (Q52's out-of-process
 * transport, deliberately unbuilt), or the cap below evicted it. All three mean *this process
 * cannot deliver a user turn into that session*, and the honest answer to a mutation it cannot
 * perform is to refuse it (standing rule 20) — never to accept the request and drop the message,
 * which is what an in-memory queue "for when the run comes back" would do.
 *
 * ## What it costs
 *
 * Two map entries per run this process has in flight — by run id and by task id — removed by the
 * run's own outcome. BD-010's default `max_parallel_runs` is **4** per organisation and
 * `PipelineRuntimeOptions.stageConcurrency` ships as **1**, so {@link MAX_LIVE_RUNS} is **64×** the
 * number of runs a shipped instance can hold at once — the ratio is asserted rather than described
 * (standing rule 39, and the first version of this sentence said "two orders of magnitude", which
 * 256 is not). It exists so that a leak — an outcome promise that never settles — is bounded rather
 * than unbounded. Eviction is oldest-first and makes both lookups answer `null`, which is the
 * fail-closed direction: a steer is refused rather than delivered to the wrong run.
 */
import type { Id } from '@platform/contracts';
import type { ClaudeRunner, RunHandle } from '../ports/runner.js';

/** See the module note: a bound on a leak, not a budget for concurrency. */
export const MAX_LIVE_RUNS = 256;

/** One run this process is executing, as the two commands that reach for it need it. */
export interface LiveRun {
  readonly runId: Id;
  readonly taskId: Id;
  readonly handle: RunHandle;
}

export interface LiveRuns {
  /**
   * Wraps a runner so that every run it starts is findable while it lasts. Everything else about
   * the runner is unchanged: the same handle is returned to the caller.
   */
  observe(runner: ClaudeRunner): ClaudeRunner;
  /** The live run with this id **in this process**, or `null`. See the module note. */
  forRun(runId: Id): LiveRun | null;
  /**
   * The live run of this task, or `null`.
   *
   * A second index rather than a scan, and a legitimate one: technical/02 allows a task **one**
   * active run (`assertSingleActiveRun`), so "the task's live run" is a single value rather than a
   * choice. A take-over names a task and has no run id, which is the whole reason this exists.
   */
  forTask(taskId: Id): LiveRun | null;
  forget(runId: Id): void;
  readonly size: number;
}

export const createLiveRuns = (maxEntries: number = MAX_LIVE_RUNS): LiveRuns => {
  // Insertion-ordered, which is what makes "evict the oldest" a `keys().next()`.
  const byRun = new Map<Id, LiveRun>();
  const byTask = new Map<Id, Id>();

  const drop = (runId: Id): void => {
    const entry = byRun.get(runId);
    if (entry === undefined) {
      return;
    }
    byRun.delete(runId);
    // Only when it is still *this* run: a task whose next stage started before the previous run's
    // outcome settled would otherwise have its live entry deleted by the dead run's `finally`.
    if (byTask.get(entry.taskId) === runId) {
      byTask.delete(entry.taskId);
    }
  };

  const remember = (entry: LiveRun): void => {
    if (byRun.size >= maxEntries && !byRun.has(entry.runId)) {
      const oldest = byRun.keys().next();
      if (!oldest.done) {
        drop(oldest.value);
      }
    }
    byRun.set(entry.runId, entry);
    byTask.set(entry.taskId, entry.runId);
  };

  return {
    observe: (runner) => ({
      start: (spec) => {
        const handle = runner.start(spec);
        remember({ runId: spec.runId, taskId: spec.taskId, handle });
        // `finally` on the outcome, not on a status: a rejected outcome is a run that crashed, and
        // its handle is as dead as a completed one's. The `catch` is not optional — an unhandled
        // rejection ends the process in Node 24 — and the runners already attach one of their own,
        // so this one only covers the promise **this** line creates.
        handle.outcome
          .finally(() => {
            drop(spec.runId);
          })
          .catch(() => undefined);
        return handle;
      },
    }),
    forRun: (runId) => byRun.get(runId) ?? null,
    forTask: (taskId) => {
      const runId = byTask.get(taskId);
      return runId === undefined ? null : (byRun.get(runId) ?? null);
    },
    forget: drop,
    get size() {
      return byRun.size;
    },
  };
};
