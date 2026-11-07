/**
 * **Why a run ended**, in words (TD-033 decision 6).
 *
 * A module of its own, re-exported unchanged by `ui/humanize.ts` (the screens import it from there):
 * the worker's local page imports **this** module and never `humanize.ts`, so its 120 kB entry
 * carries only the words it shows — `worker/import-graph.test.ts` holds that (BACKLOG 1455).
 */
import type { RunTerminalReason } from '@platform/contracts';

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
