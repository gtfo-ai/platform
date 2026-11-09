/**
 * **Why a run ended**, in words (TD-033 decision 6) — the one table every surface reads (S-25.19).
 *
 * Three columns, each a `Record` over the contract's `runTerminalReasonSchema`, so a reason added to
 * the contract fails the build here until it is worded (and `terminal-reasons.test.ts` holds every
 * entry to its shape):
 *
 * - {@link TERMINAL_REASON_LABEL} — the run page's *Ended because* and the transcript's end row;
 * - {@link TERMINAL_REASON_SHORT} — the short form beside *Failed* or *Cancelled* where a run is
 *   listed: the task's Runs tab, the board card's activity, Home and the Agents rows
 *   ({@link runEndedShort});
 * - {@link TERMINAL_REASON_MEANING} — one sentence of what the ending means, for the run page's
 *   *Ended* panel and, with its own wording for the schema failure, the ask thread's
 *   (`features/ask-thread.tsx`'s `ASK_ENDED_BECAUSE`, which overrides two entries and keeps the
 *   rest). Each sentence is true of any run, a stage run or an ask: it says what the platform
 *   knows, never more — a lost lease says nobody renewed it, not that the agent failed.
 *
 * A module of its own, re-exported unchanged by `ui/humanize.ts` (the screens import it from there):
 * the worker's local page imports **this** module and never `humanize.ts`, so its 120 kB entry
 * carries only the words it shows — `worker/import-graph.test.ts` holds that (BACKLOG 1455).
 */
import type { RunStatus, RunTerminalReason } from '@platform/contracts';

export const TERMINAL_REASON_LABEL: Readonly<Record<RunTerminalReason, string>> = {
  success: 'Succeeded',
  error_max_turns: 'Ran out of turns',
  error_max_budget_usd: 'Hit its budget',
  error_max_structured_output_retries: 'Could not produce a valid result',
  error_during_execution: 'Failed while running',
  permission_denied: 'Permission denied',
  cancelled: 'Cancelled',
  stalled: 'Stalled',
  timed_out: 'Timed out',
  crash: 'Crashed',
  lease_expired: 'Lost its worker',
  shutdown: 'Handed back on shutdown',
  rate_limited: 'Hit a usage limit',
};

/**
 * The short form, as it reads after *Failed ·* — never repeating the status word, so
 * `error_during_execution` is *Error while running* rather than *Failed while running*.
 */
export const TERMINAL_REASON_SHORT: Readonly<Record<RunTerminalReason, string>> = {
  success: 'Succeeded',
  error_max_turns: 'Ran out of turns',
  error_max_budget_usd: 'Hit its budget',
  error_max_structured_output_retries: 'No valid result',
  error_during_execution: 'Error while running',
  permission_denied: 'Permission denied',
  cancelled: 'Cancelled',
  stalled: 'Stalled',
  timed_out: 'Timed out',
  crash: 'Crashed',
  lease_expired: 'Lost its worker',
  shutdown: 'Handed back on shutdown',
  rate_limited: 'Hit a usage limit',
};

/** What a run whose workspace was never created says where it is listed. */
export const DID_NOT_START = 'Did not start';

/** One sentence of what the ending means, true of a stage run and of an ask alike. */
export const TERMINAL_REASON_MEANING: Readonly<Record<RunTerminalReason, string>> = {
  success: 'The run finished and reported its result.',
  error_max_turns: 'The agent used every turn it was allowed before it finished.',
  error_max_budget_usd: 'The run reached its budget cap before it finished.',
  error_max_structured_output_retries:
    'The agent could not produce its result in the expected shape, even after retrying.',
  error_during_execution: 'The agent’s session ended with an error before it finished.',
  permission_denied:
    'The agent was refused a tool its settings do not allow, and its session ended with an error.',
  cancelled: 'The run was stopped before it finished — a person cancelled it or took the work.',
  stalled: 'The agent stopped producing anything for too long, so the platform stopped the run.',
  timed_out: 'The run went past its time limit, so the platform stopped it.',
  crash: 'The agent’s process ended unexpectedly, without reporting a result.',
  lease_expired:
    'The machine running it stopped checking in, so the platform ended the run. That says nothing about whether the agent itself failed.',
  shutdown:
    'The runner it was on was shutting down, so the run was handed back before it finished.',
  rate_limited:
    'The Claude account it ran on reached a usage limit, so the run was handed back before it finished.',
};

const LIVE: ReadonlySet<RunStatus> = new Set(['created', 'starting', 'running']);

/** What a listed run carries that decides its short form — every list's run record has these. */
export interface EndedRun {
  readonly status: RunStatus;
  readonly terminal_reason?: RunTerminalReason | null;
  /** A run whose workspace was never created (or that was stopped before its CLI started). */
  readonly start_failure?: object | null;
}

/**
 * The short form beside a listed run's status, or `null` when it would add nothing: a live run, a
 * success, a run with no recorded reason, and a cancel that says *Cancelled* already. A run whose
 * workspace never started is {@link DID_NOT_START} — unless a person or a shutdown stopped it
 * first, which is its own ending and not a failure.
 */
export const runEndedShort = (run: EndedRun): string | null => {
  if (LIVE.has(run.status)) {
    return null;
  }
  const reason = run.terminal_reason ?? null;
  if (
    run.start_failure !== null &&
    run.start_failure !== undefined &&
    run.status !== 'cancelled' &&
    reason !== 'shutdown'
  ) {
    return DID_NOT_START;
  }
  if (reason === null || reason === 'success') {
    return null;
  }
  if (run.status === 'cancelled' && reason === 'cancelled') {
    return null;
  }
  return TERMINAL_REASON_SHORT[reason];
};
