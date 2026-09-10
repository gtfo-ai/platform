/**
 * Where the pipeline learns *why* the platform stopped a run.
 *
 * WP-12 stops a run whose result carried no usable `total_cost_usd` with status `budget_exceeded`
 * and terminal reason `error_max_budget_usd` — `RunTerminalReason` is a closed contract and a
 * PostgreSQL enum, and it has no name for the fault. The distinction is carried in two places
 * instead: the human-readable `RunOutcome.error`, and the `run_stopped` transcript row's
 * `data.reason`, which is the structured one. The stage executor must branch on it, because a
 * blind stop is a fault that escalates while a real overspend pauses the task for a human to raise
 * the cap.
 *
 * The runner takes **one** sink for every run it drives (`ClaudeRunnerDependencies.sink`), so the
 * executor cannot wrap a sink per run. This is the seam that solves it: the composition root wraps
 * its real sink once, and the executor asks by run id afterwards.
 *
 * ## What it costs, stated rather than assumed
 *
 * One entry per stopped run, `runId → reason`, and only for runs the platform stopped — a run that
 * ends by itself writes no `run_stopped` row and takes no space. `forget` is called by the reader,
 * so the normal path leaves nothing behind; a reader that never comes back (a crash between the
 * run ending and its transaction) leaves one entry, and the map is capped at
 * {@link MAX_REMEMBERED_STOPS} with the oldest evicted first. The cap is a memory bound, not a
 * correctness one: evicting an entry makes the executor read `null`, which is the same answer it
 * gets for a run that stopped for a reason with no name — and that path escalates, which is the
 * fail-closed direction.
 */
import type { Id, TranscriptEvent } from '@platform/contracts';
import type { RunTranscriptSink } from '../ports/runner.js';

/**
 * Enough for every run a busy instance has in flight, and small enough to be uninteresting.
 *
 * BD-010's default `max_parallel_runs` is **4** per organisation, so 256 is 64× the number of runs
 * that can be stopping at once — and an entry is only made for a run the *platform* stopped, and
 * only until its executor reads it. The ratio is asserted rather than described, because the first
 * version of this sentence said "two orders of magnitude" and 256 is not 400 (standing rule 39).
 */
export const MAX_REMEMBERED_STOPS = 256;

export interface RunStopReasons {
  /** Wraps the composition root's sink. Everything still reaches the inner sink, in order. */
  observe(sink: RunTranscriptSink): RunTranscriptSink;
  /** The `run_stopped` reason of this run, or `null` when the platform did not stop it. */
  reasonFor(runId: Id): string | null;
  forget(runId: Id): void;
  readonly size: number;
}

export const createRunStopReasons = (maxEntries: number = MAX_REMEMBERED_STOPS): RunStopReasons => {
  // Insertion-ordered, which is what makes "evict the oldest" a `keys().next()`.
  const reasons = new Map<Id, string>();

  return {
    observe: (sink) => ({
      append: async (event: TranscriptEvent) => {
        if (event.kind === 'system' && event.subtype === 'run_stopped') {
          const value = event.data.reason;
          if (typeof value === 'string') {
            if (reasons.size >= maxEntries && !reasons.has(event.run_id)) {
              const oldest = reasons.keys().next();
              if (!oldest.done) {
                reasons.delete(oldest.value);
              }
            }
            reasons.set(event.run_id, value);
          }
        }
        await sink.append(event);
      },
    }),
    reasonFor: (runId) => reasons.get(runId) ?? null,
    forget: (runId) => {
      reasons.delete(runId);
    },
    get size() {
      return reasons.size;
    },
  };
};
