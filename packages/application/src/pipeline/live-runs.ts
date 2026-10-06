/**
 * The runs this process is executing, by run id and by task id (WP-27) — and, since WP-85, the one
 * place a recorded steer or take-over stop is **applied** to a live session.
 *
 * technical/04 § "Streaming and steering": *"the run's input is an async queue; a `run.steered`
 * command pushes an `SDKUserMessage`"*. That queue belongs to a `RunHandle`, and the handle belongs
 * to whoever called `ClaudeRunner.start` — the process holding the run's lease. A
 * `POST /api/runs/:id/steer` arrives somewhere else: on the shipped topology, always in another
 * process. Until WP-85 the command looked the run up here, in the answering process, and so every
 * steer on the shipped topology was refused (PROGRESS backlog 134). TD-028 decision 9 moved the
 * crossing into the database: the command records a `run_commands` row and wakes the lease holder,
 * and the holder's inbox (`./run-commands.ts`) finds the handle **here** and delivers.
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
 * that keeps the register. A process that runs no agent wraps nothing and composes no inbox, and
 * nothing that serves the API reads this register at all.
 *
 * ## What "not here" means
 *
 * `forRun` and `forTask` answer `null` for three different situations, and the inbox may not tell
 * them apart: the run's handle is not registered **yet** (the run row is leased from the
 * transaction that created it, a moment before `runner.start`), the run ended a moment ago, or the
 * cap below evicted it. The inbox's answer to each is in `./run-commands.ts` (decision 3): a miss on
 * a wake-up waits, a miss on the heartbeat is refused `register_miss`, and a run that ended closes
 * its commands `run_ended` — never a message accepted and dropped.
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
 *
 * **What eviction costs a stop, and how far it reaches** (WP-119, PROGRESS backlog 336, option
 * (b)). A cancel or a take-over whose run was evicted is refused `register_miss` by the heartbeat
 * (`./run-commands.ts` decision 3), and the session it was meant to stop runs on — on a paused task,
 * spending until its own wall clock or budget ends it (BD-010), and then recorded with what it
 * measured. That refusal is logged at `error` when the run still reads `running` and leased here.
 * **The reach, read off the tree and not measured:** a handle leaves this register only when its
 * outcome settles or by this eviction, and nothing calls `forget` outside this module; so a register
 * miss for a session that is still running needs **more than {@link MAX_LIVE_RUNS} handles whose
 * outcomes never settled** in one process — a leak 64× a shipped instance's whole capacity. No other
 * route to a miss on a live session was found. (A session whose outcome settled during the drain
 * that looked also misses, and has nothing left to stop; the error line names that case too.)
 */
import type { Id } from '@platform/contracts';
import type { ClaudeRunner, RunHandle, RunStop } from '../ports/runner.js';

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
  /**
   * **The process is stopping: hand every run back** (WP-144, PROGRESS backlog 432).
   *
   * Sends `stop` to every run registered here, and **closes** the register: a run whose `start` is
   * called afterwards — a job taken in the moment between the worker's stop and this call — is
   * stopped the instant it registers, so no session outlives the process's stop. Answers how many
   * runs were stopped now. Never awaits the outcomes: the job that started each run awaits its own
   * and records the ending (`stage-executor.ts`, `ask/executor.ts`), and the composition root
   * awaits those jobs (`PipelineRuntime.stop`). A stop that rejects is logged by its caller's
   * outcome, never thrown here — one session closing badly must not keep the others running.
   */
  stopAll(stop: RunStop): number;
  /** `true` once {@link LiveRuns.stopAll} has been called. */
  readonly closed: boolean;
}

export const createLiveRuns = (maxEntries: number = MAX_LIVE_RUNS): LiveRuns => {
  // Insertion-ordered, which is what makes "evict the oldest" a `keys().next()`.
  const byRun = new Map<Id, LiveRun>();
  const byTask = new Map<Id, Id>();
  /** Set by `stopAll`; a run registered after it is stopped as it registers (WP-144). */
  let closedWith: RunStop | null = null;
  const stopQuietly = (handle: RunHandle, stop: RunStop): void => {
    handle.stop(stop).catch(() => undefined);
  };

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
      start: (spec, hooks) => {
        const handle = runner.start(spec, hooks);
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
        if (closedWith !== null) {
          stopQuietly(handle, closedWith);
        }
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
    stopAll: (stop) => {
      closedWith = stop;
      const live = [...byRun.values()];
      for (const entry of live) {
        stopQuietly(entry.handle, stop);
      }
      return live.length;
    },
    get closed() {
      return closedWith !== null;
    },
  };
};
