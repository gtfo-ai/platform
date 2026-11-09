/**
 * **Why a run ended**, in words (TD-033 decision 6) — the one table every surface reads (S-25.19).
 *
 * Three columns (two here, one beside it), each a `Record` over the contract's `runTerminalReasonSchema`, so a reason added to
 * the contract fails the build here until it is worded (and `terminal-reasons.test.ts` holds every
 * entry to its shape):
 *
 * - {@link TERMINAL_REASON_LABEL} — the run page's *Ended because* and the transcript's end row;
 * - {@link TERMINAL_REASON_SHORT} — the short form beside *Failed* or *Cancelled* where a run is
 *   listed: the task's Runs tab, the board card's activity, Home and the Agents rows
 *   ({@link runEndedShort});
 * - `TERMINAL_REASON_MEANING` — **in `./terminal-reason-meanings.ts`**, a module of its own so the
 *   worker page (which imports this one through `ui/activity.ts`) never carries the sentences — one
 *   sentence of what the ending means, for the run page's
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

/**
 * What a run the platform stopped because its cost could not be measured says where it is listed
 * (S-25.22, BACKLOG 1394): its terminal reason is `error_max_budget_usd`, the budget's, but it is a
 * fault and not an overspend — the run page's *Ended* panel says the same from the transcript. The
 * short form reads after *Failed:* (the board card, Home, the Agents rows); the Runs tab, whose
 * *Over budget* status would be untrue, says {@link COST_UNREPORTED_STATUS} alone.
 */
export const COST_UNREPORTED_SHORT = 'Did not report its cost';
export const COST_UNREPORTED_STATUS = 'Stopped: the run did not report its cost';

const LIVE: ReadonlySet<RunStatus> = new Set(['created', 'starting', 'running']);

/** What a listed run carries that decides its short form — every list's run record has these. */
export interface EndedRun {
  readonly status: RunStatus;
  readonly terminal_reason?: RunTerminalReason | null;
  /** A run whose workspace was never created (or that was stopped before its CLI started). */
  readonly start_failure?: object | null;
  /** Why the platform stopped it (`RunRecord.stop_reason`), when it did. */
  readonly stop_reason?: string | null;
}

/**
 * The short form beside a listed run's status, or `null` when it would add nothing: a live run, a
 * success, a run with no recorded reason, and a cancel that says *Cancelled* already. A run whose
 * workspace never started is {@link DID_NOT_START} — unless a person or a shutdown stopped it
 * first, which is its own ending and not a failure — and one stopped for an unmeasured cost is
 * {@link COST_UNREPORTED_SHORT}, never *Hit its budget*.
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
  if (reason === 'error_max_budget_usd' && run.stop_reason === 'cost_unreported') {
    return COST_UNREPORTED_SHORT;
  }
  return TERMINAL_REASON_SHORT[reason];
};
