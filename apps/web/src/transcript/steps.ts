/**
 * A tool call as a **log step** (research/19 § 5.2 "Run", S-23.10): the run page draws each call
 * the way GitHub Actions draws a job's step — chevron, status icon, the tool, a one-line argument
 * summary, the duration right-aligned — collapsed until somebody opens it, and the existing renderer
 * (`renderers.tsx`) is what opening it shows.
 *
 * Pure, so what a step says is held by the unit tier without a DOM.
 *
 * **What is platform text and what is not.** {@link stepTitle} is the vocabulary's phrase for one of
 * the platform's own tools ("Searching the knowledge base") and otherwise the tool's name — the
 * run's text, filtered and bounded by `toolWords` (`ui/activity.ts`) and rendered as React text.
 * The argument summary is `argumentSummary` (`viz/flow/activity-rows.ts`, the stage dialog's log
 * line, reused rather than written twice): the model's words, one line, bounded, untrusted.
 */
import { PLATFORM_TOOL_LABEL, PLATFORM_TOOL_PREFIX, toolWords } from '../ui/activity.js';
import type { Status } from '../ui/status.js';
import { argumentSummary } from '../viz/flow/activity-rows.js';
import type { ToolBlock } from './blocks.js';

/** The platform tool's phrase, or the tool's own name (filtered and bounded). */
export const stepTitle = (toolName: string): string => {
  if (toolName.startsWith(PLATFORM_TOOL_PREFIX)) {
    const name = toolName.slice(PLATFORM_TOOL_PREFIX.length);
    if (Object.hasOwn(PLATFORM_TOOL_LABEL, name)) {
      return PLATFORM_TOOL_LABEL[name as keyof typeof PLATFORM_TOOL_LABEL];
    }
  }
  return toolWords(toolName);
};

/** The call's one-line argument summary — the run's text. */
export const stepSummary = (block: Pick<ToolBlock, 'input'>): string =>
  argumentSummary(block.input);

/** Running until a result arrives; failed when the result says so. */
export const stepStatus = (block: Pick<ToolBlock, 'result'>): Status =>
  block.result === null ? 'running' : block.result.isError ? 'failure' : 'success';

/**
 * How long the call took, in milliseconds: from its own row to the row of its result. `null` while
 * it is running, or when either instant cannot be read.
 */
export const stepDurationMs = (block: Pick<ToolBlock, 'result' | 'startedAt' | 'at'>) => {
  if (block.result === null) {
    return null;
  }
  const from = Date.parse(block.startedAt);
  const to = Date.parse(block.at);
  return Number.isNaN(from) || Number.isNaN(to) ? null : Math.max(0, to - from);
};

/** "0.2s", "12s", "1m 04s", "1h 02m" — the step's right-aligned figure. */
export const formatStepDuration = (ms: number): string => {
  if (ms < 10_000) {
    return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

/** The step's right-aligned text: its duration, `running`, or nothing when it cannot be said. */
export const stepTiming = (block: Pick<ToolBlock, 'result' | 'startedAt' | 'at'>): string => {
  if (block.result === null) {
    return 'running';
  }
  const ms = stepDurationMs(block);
  return ms === null ? '' : formatStepDuration(ms);
};

/**
 * Open on arrival when it is what the agent is doing now (no result yet) or when it failed — as an
 * Actions job opens its running and its failed step — and collapsed otherwise.
 */
export const stepOpenByDefault = (block: Pick<ToolBlock, 'result'>): boolean =>
  block.result === null || block.result.isError;
