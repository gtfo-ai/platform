/**
 * `report_progress` — the platform tool that tells a person watching the task what the agent is
 * doing (PROGRESS backlog 496, the product owner's first local test, 2026-10-06).
 *
 * It was granted to nearly every role and refused at runtime for want of a transcript kind, so on
 * Autix agents called it and read an error back. It is now three small parts, split along who holds
 * what:
 *
 *  - **this module** bounds the model's words ({@link boundProgressSummary}), holds the per-run rate
 *    bound as a pure gate over a clock ({@link createProgressGate}) and words the answer the model
 *    reads ({@link progressAcknowledgement});
 *  - **the runner** (`packages/infrastructure/src/runner/claude-runner.ts`) builds the run's
 *    {@link RunProgressRecorder} over its single transcript door, so the row gets the run's `seq`,
 *    its redactor (TD-012) and its sink, and is announced on `run:<id>` like every other entry;
 *  - **the composition** (`apps/server/src/platform-tools.ts`) hands the tool to the platform MCP.
 *
 * **Not a domain event.** Nothing in the pipeline decides anything on progress: it is a line for a
 * person, the transcript is already the run's record, and the transcript is already streamed. A
 * `run.progress` event would be a second copy with no consumer, on a table that is append-only and
 * replayed.
 *
 * **Bounded twice.** Each line is cut to {@link PROGRESS_SUMMARY_MAX_CHARS}, and a run records at most
 * one line every {@link PROGRESS_MIN_INTERVAL_MS} and {@link PROGRESS_MAX_PER_RUN} in all — a model
 * calling it in a loop costs its own turns and no transcript rows. A refused call is answered in one
 * plain sentence and is **not** an error, because there is nothing for the model to fix.
 */
import { PROGRESS_SUMMARY_MAX_CHARS } from '@platform/contracts';
import type {
  PlatformToolContext,
  ReportProgressInput,
  RunProgressReceipt,
  RunProgressReport,
} from '../ports/runner.js';

/**
 * The shortest gap between two recorded lines of one run. A person reads the task page in minutes,
 * and the prompts ask for a line per slice; thirty seconds is far below either and far above a loop.
 */
export const PROGRESS_MIN_INTERVAL_MS = 30_000;

/**
 * The most lines one run records. A line per slice of a 200-turn Developer run is a few dozen; a
 * hundred leaves room for that and bounds the transcript rows a confused model can add.
 */
export const PROGRESS_MAX_PER_RUN = 100;

/**
 * The model's summary, trimmed and cut to {@link PROGRESS_SUMMARY_MAX_CHARS} characters.
 *
 * The cut never splits a surrogate pair: a lone high surrogate at the end is dropped with the rest.
 * `null` for a summary that is only whitespace — there is no line to record.
 */
export const boundProgressSummary = (
  summary: string,
): { readonly summary: string; readonly truncated: boolean } | null => {
  const trimmed = summary.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length <= PROGRESS_SUMMARY_MAX_CHARS) {
    return { summary: trimmed, truncated: false };
  }
  let cut = trimmed.slice(0, PROGRESS_SUMMARY_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return { summary: cut.trimEnd(), truncated: true };
};

export interface ProgressGateOptions {
  /** Milliseconds on the runner's clock (`RunnerClock.now`). */
  readonly now: () => number;
  readonly minIntervalMs?: number;
  readonly maxPerRun?: number;
}

export interface ProgressGate {
  /** Admits one line or says why not. An admitted line counts; a refused one does not. */
  readonly admit: () => RunProgressReceipt;
}

/** The per-run rate bound. One per run, held by the runner beside its `seq`. */
export const createProgressGate = (options: ProgressGateOptions): ProgressGate => {
  const minIntervalMs = options.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  const maxPerRun = options.maxPerRun ?? PROGRESS_MAX_PER_RUN;
  let recorded = 0;
  let lastAt: number | null = null;
  return {
    admit: () => {
      if (recorded >= maxPerRun) {
        return { recorded: false, reason: 'run_limit', limit: maxPerRun };
      }
      const now = options.now();
      if (lastAt !== null && now - lastAt < minIntervalMs) {
        return {
          recorded: false,
          reason: 'too_soon',
          retryAfterMs: minIntervalMs - (now - lastAt),
        };
      }
      recorded += 1;
      lastAt = now;
      return { recorded: true };
    },
  };
};

/** What the model reads back: one short plain sentence, no platform jargon (backlog 476). */
export const progressAcknowledgement = (
  receipt: RunProgressReceipt,
  truncated: boolean,
): string => {
  if (receipt.recorded) {
    return truncated
      ? `Progress recorded, shortened to its first ${PROGRESS_SUMMARY_MAX_CHARS} characters.`
      : 'Progress recorded.';
  }
  if (receipt.reason === 'too_soon') {
    const seconds = Math.max(1, Math.ceil(receipt.retryAfterMs / 1000));
    return `Not recorded: this run reported progress moments ago. Carry on, and report again after your next step (at the earliest in ${seconds} s).`;
  }
  return `Not recorded: this run has already reported progress ${receipt.limit} times, the most it may. Carry on without it.`;
};

/** The run has no progress door — a composition with no runner behind it. */
export class RunProgressUnavailableError extends Error {
  override readonly name = 'RunProgressUnavailableError';

  constructor() {
    super('Progress cannot be recorded for this run. Carry on without it.');
  }
}

/**
 * The tool itself: bound the input, hand it to the run's recorder, answer in a sentence.
 *
 * The run is the context's, never one the model named — the input has no run field.
 */
export const reportProgressTool = async (
  input: ReportProgressInput,
  context: Pick<PlatformToolContext, 'progress'>,
): Promise<string> => {
  if (context.progress === undefined) {
    throw new RunProgressUnavailableError();
  }
  const bounded = boundProgressSummary(input.summary);
  if (bounded === null) {
    return 'Not recorded: the summary is empty. Say in one line what you have just done or are doing.';
  }
  const report: RunProgressReport = {
    summary: bounded.summary,
    percentComplete: input.percent_complete ?? null,
    truncated: bounded.truncated,
  };
  return progressAcknowledgement(await context.progress.record(report), bounded.truncated);
};
