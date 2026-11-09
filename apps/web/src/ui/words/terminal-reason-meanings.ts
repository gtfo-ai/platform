/**
 * **What a run's ending means**, one sentence per terminal reason (S-25.19) — the third column of
 * `./terminal-reasons.ts`'s table, kept in a module of its own because the worker's local page reads
 * that module (through `ui/activity.ts`) and shows none of these sentences: its 120 kB entry carries
 * only the words it shows (BACKLOG 1455). Re-exported by `ui/humanize.ts`, never named in
 * `worker/import-graph.test.ts`'s `WORKER_WORDS`. Each sentence is true of a stage run and of an ask
 * alike, and says what the platform knows, never more.
 */
import type { RunTerminalReason } from '@platform/contracts';

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
  cancelled: 'The run was stopped before it finished (by a person, or because the task moved on).',
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
