/**
 * **Why this run ended** — the run page's *Ended* panel (S-25.19, product/10 § "Run detail").
 *
 * The summary strip said *Ended because: Lost its worker* and stopped there: no meaning, no word on
 * what the platform did about it, no next step. The never-started panel (`./run-not-started.tsx`)
 * already answered those for a run whose workspace was never created; this panel gives every run
 * that **started** and did not succeed the same shape:
 *
 * 1. **What it means** — one sentence per terminal reason, from the one word table
 *    (`ui/words/terminal-reasons.ts`'s `TERMINAL_REASON_MEANING`). Two readings are the transcript's,
 *    because the reason alone does not carry them: a budget stop whose `run_stopped` row says
 *    `cost_unreported` is the fault, not an overspend (`stop-reasons.ts` in the application ring),
 *    and a `permission_denied` run names the tool it was refused when the transcript recorded it.
 * 2. **What the platform did next** ({@link endedFollowUp}) — read off the task, never assumed from
 *    the reason: a newer run of the same stage (linked — a higher attempt, or the **same** attempt
 *    started again, which is how a hand-back and a usage limit are re-run), the task stopped for a
 *    person, paused, ended — or nothing yet, said as such, with the stage named when the task has
 *    moved on from this run's. *Re-run* is not offered while that newer run is live.
 * 3. **The next step** — *Re-run as configured*, *Work on it yourself…* and *Open the task*, each
 *    only for a reader who may ({@link runCallerMay}); *See the run’s settings* for a refused
 *    tool; and *Jump to the last lines*, which opens the transcript at its end.
 *
 * **Not shown** for a live run, a success, a run with no recorded reason, a run whose workspace never
 * started (the never-started panel stands in its place) and a run that **completed** past its budget
 * cap — that run delivered its result and the header's *budget cap crossed* badge says the rest.
 *
 * Every button is a secondary: the header's *Re-run* stays the page's one primary (S-23.23).
 * Everything the run wrote is untrusted (BD-022) — the tool name is filtered and bounded by
 * `toolWords` and rendered as React text.
 */
import type { RunRecord, RunTerminalReason, TaskDetailResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import type { TranscriptBlock } from '../transcript/blocks.js';
import { toolWords } from '../ui/activity.js';
import { Button } from '../ui/button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import {
  RUN_STATUS_LABEL,
  stageLabel,
  TERMINAL_REASON_LABEL,
  TERMINAL_REASON_MEANING,
} from '../ui/humanize.js';
import { UntrustedText } from '../ui/untrusted.js';
import { isLiveRun } from './run-jobs.js';

/** Endings nothing went wrong in: a person's stop, a shutdown, a usage limit — a neutral panel. */
const HANDED_BACK: ReadonlySet<RunTerminalReason> = new Set([
  'cancelled',
  'shutdown',
  'rate_limited',
]);

/**
 * The reason the run page's *Ended* panel words, or `null` when it shows none (the docblock lists
 * what it skips).
 */
export const endedPanelReason = (
  run: Pick<RunRecord, 'status' | 'terminal_reason' | 'start_failure'>,
): RunTerminalReason | null => {
  const reason = run.terminal_reason ?? null;
  return isLiveRun(run.status) ||
    run.start_failure !== null ||
    reason === null ||
    reason === 'success' ||
    run.status === 'completed'
    ? null
    : reason;
};

/**
 * What the reader may do from a run that ended (S-25.21, BACKLOG 1393): *Re-run* is `run.retry`
 * (`can_retry_run`) and *Work on it yourself…* is `task.take_over` (`can_take_over`) — each the task
 * read's fact for the command route's own permission, never a proxy for it. Both `false` until the
 * task read answers.
 */
export const runCallerMay = (
  detail: Pick<TaskDetailResponse, 'can_retry_run' | 'can_take_over'> | undefined,
): { readonly rerun: boolean; readonly takeOver: boolean } => ({
  rerun: detail?.can_retry_run === true,
  takeOver: detail?.can_take_over === true,
});

const flatten = (blocks: readonly TranscriptBlock[], into: TranscriptBlock[] = []) => {
  for (const block of blocks) {
    into.push(block);
    if (block.kind === 'tool') {
      flatten(block.children, into);
    }
  }
  return into;
};

/**
 * The tool the run was refused last, as the transcript recorded it — the CLI's `permission_denied`
 * row or a hook's `deny` — filtered and bounded; `null` when nothing recorded one.
 */
export const deniedToolOf = (blocks: readonly TranscriptBlock[]): string | null => {
  let name: string | null = null;
  for (const block of flatten(blocks)) {
    if (block.kind === 'system' && block.subtype === 'permission_denied') {
      const value = Object.hasOwn(block.data, 'tool_name') ? block.data['tool_name'] : undefined;
      if (typeof value === 'string' && value.trim() !== '') {
        name = value;
      }
    } else if (block.kind === 'hook' && block.decision === 'deny' && block.toolName !== null) {
      name = block.toolName;
    }
  }
  return name === null ? null : toolWords(name);
};

/** The runner's own word for why it stopped the run (`run_stopped`'s `data.reason`), if it did. */
export const stoppedReasonOf = (blocks: readonly TranscriptBlock[]): string | null => {
  let reason: string | null = null;
  for (const block of flatten(blocks)) {
    if (block.kind === 'system' && block.subtype === 'run_stopped') {
      const value = Object.hasOwn(block.data, 'reason') ? block.data['reason'] : undefined;
      reason = typeof value === 'string' ? value : reason;
    }
  }
  return reason;
};

/** The sentence of meaning, with the transcript's two readings applied. */
export const endedMeaning = (
  reason: RunTerminalReason,
  blocks: readonly TranscriptBlock[],
): string => {
  if (reason === 'error_max_budget_usd' && stoppedReasonOf(blocks) === 'cost_unreported') {
    return 'The run’s cost could not be measured, so the platform stopped it rather than let it spend without a figure.';
  }
  return TERMINAL_REASON_MEANING[reason];
};

/** What the platform did after the run ended, read off the task. */
export type EndedFollowUp =
  | {
      readonly kind: 'ran_again';
      readonly run: RunRecord;
      /** The newer run is the **same** attempt — a hand-back's or a usage limit's re-run. */
      readonly sameAttempt: boolean;
    }
  | {
      readonly kind: 'needs_person' | 'paused' | 'finished' | 'nothing';
      /**
       * The stage the task is at now when it is **not** this run's: the state is the task's today,
       * so a later stop elsewhere is named as there rather than read as this run's consequence.
       */
      readonly movedTo: string | null;
    }
  | { readonly kind: 'ask' };

const timeOf = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) {
    return null;
  }
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
};

/**
 * Is `other` a run of the same stage started **after** `run`? A higher attempt always is. The same
 * attempt is too when it started later — `settleRun` re-runs a hand-back at shutdown and a usage
 * limit's re-plan **as the same attempt** (`enqueueFollowOn`, `attempt: run.attempt`) — or when it
 * has not started yet and is still live (an offer nobody has claimed).
 */
export const startedAfter = (
  run: Pick<RunRecord, 'id' | 'stage' | 'attempt' | 'started_at'>,
  other: Pick<RunRecord, 'id' | 'stage' | 'attempt' | 'started_at' | 'status'>,
): boolean => {
  if (other.id === run.id || other.stage !== run.stage || other.attempt < run.attempt) {
    return false;
  }
  if (other.attempt > run.attempt) {
    return true;
  }
  const mine = timeOf(run.started_at);
  const theirs = timeOf(other.started_at);
  if (theirs === null) {
    return isLiveRun(other.status);
  }
  return mine !== null && theirs > mine;
};

/** Newest first: the higher attempt, then the later start, an unstarted run newest of all. */
const newestFirst = (left: RunRecord, right: RunRecord): number => {
  if (left.attempt !== right.attempt) {
    return right.attempt - left.attempt;
  }
  const l = timeOf(left.started_at);
  const r = timeOf(right.started_at);
  return l === r ? 0 : l === null ? -1 : r === null ? 1 : r - l;
};

/**
 * `null` until the task read answers. A run with no stage is an ask, which runs beside the pipeline
 * and moves nothing. Otherwise: the newest run of the same stage started after this one
 * ({@link startedAfter}), if there is one; else what the task's state says — stopped for a person,
 * paused, finished — else nothing yet, with the stage named when the task is no longer at this one.
 */
export const endedFollowUp = (
  run: Pick<RunRecord, 'id' | 'stage' | 'attempt' | 'started_at'>,
  detail: Pick<TaskDetailResponse, 'runs' | 'task'> | undefined,
): EndedFollowUp | null => {
  if (detail === undefined) {
    return null;
  }
  if (run.stage === null) {
    return { kind: 'ask' };
  }
  const later = detail.runs.filter((entry) => startedAfter(run, entry)).sort(newestFirst)[0];
  if (later !== undefined) {
    return { kind: 'ran_again', run: later, sameAttempt: later.attempt === run.attempt };
  }
  const current = detail.task.current_stage ?? null;
  const movedTo = current === null || current === run.stage ? null : current;
  switch (detail.task.state) {
    case 'needs_human':
      return { kind: 'needs_person', movedTo };
    case 'paused':
      return { kind: 'paused', movedTo };
    case 'done':
    case 'cancelled':
      return { kind: 'finished', movedTo: null };
    default:
      return { kind: 'nothing', movedTo };
  }
};

/** The follow-up in words, for every kind but a newer run (which links it). */
export const followUpWords = (
  followUp: Exclude<EndedFollowUp, { readonly kind: 'ran_again' }>,
): string => {
  if (followUp.kind === 'ask') {
    return 'This run answered a question about the task, so the task’s pipeline did not move.';
  }
  const there = followUp.movedTo === null ? null : stageLabel(followUp.movedTo);
  switch (followUp.kind) {
    case 'needs_person':
      return there === null
        ? 'The task stopped for a person: it waits on the task page for somebody to decide what happens next.'
        : `The task has since moved on to ${there}, and stopped for a person there.`;
    case 'paused':
      return there === null
        ? 'The task is paused; nothing runs until somebody resumes it.'
        : `The task has since moved on to ${there}, and is paused there.`;
    case 'finished':
      return 'The task has ended since.';
    case 'nothing':
      return there === null
        ? 'Nothing else has happened since: no newer run of this stage, and the task has not stopped for a person.'
        : `The task has since moved on to ${there}.`;
  }
};

/** The newer run, in words: the attempt when it is a new one, *started again* when it is the same. */
export const ranAgainWords = (followUp: Extract<EndedFollowUp, { readonly kind: 'ran_again' }>) => {
  const live = isLiveRun(followUp.run.status);
  if (followUp.sameAttempt) {
    return {
      text: live
        ? 'The stage was started again and is running. '
        : `The stage was started again: ${RUN_STATUS_LABEL[followUp.run.status].toLowerCase()}. `,
      link: 'Open the new run',
    };
  }
  return {
    text: live
      ? `The stage is running again: attempt ${followUp.run.attempt}. `
      : `The stage was run again: attempt ${followUp.run.attempt}, ${RUN_STATUS_LABEL[followUp.run.status].toLowerCase()}. `,
    link: `Open attempt ${followUp.run.attempt}`,
  };
};

const LINK = cx('rounded-sm text-link underline', FOCUS_RING);

export const RunEndedPanel = ({
  record,
  reason,
  detail,
  blocks,
  may,
  takeOverOffered,
  rerunPending,
  openTask,
  onRerun,
  onTakeOver,
  onJump,
  onSettings,
}: {
  readonly record: RunRecord;
  readonly reason: RunTerminalReason;
  readonly detail: TaskDetailResponse | undefined;
  readonly blocks: readonly TranscriptBlock[];
  /** {@link runCallerMay} over the task read. */
  readonly may: { readonly rerun: boolean; readonly takeOver: boolean };
  /** The task is not finished and nobody is working on it already. */
  readonly takeOverOffered: boolean;
  readonly rerunPending: boolean;
  /** *Open the task*, as the run page's own task link (inside its project's frame). */
  readonly openTask: (children: ReactNode, className: string) => ReactElement;
  readonly onRerun: () => void;
  readonly onTakeOver: () => void;
  readonly onJump: () => void;
  readonly onSettings: () => void;
}): ReactElement => {
  const handedBack = HANDED_BACK.has(reason);
  const followUp = endedFollowUp(record, detail);
  const denied = reason === 'permission_denied' ? deniedToolOf(blocks) : null;
  // A newer run of the stage that is still live is the re-run already: offering another would
  // start a second beside it.
  const rerun =
    may.rerun &&
    record.stage !== null &&
    !(followUp?.kind === 'ran_again' && isLiveRun(followUp.run.status));
  const work = may.takeOver && takeOverOffered;
  return (
    <section
      aria-label="Why this run ended"
      data-run-ended={reason}
      className={
        handedBack
          ? 'flex flex-col gap-2 rounded-lg border border-line bg-bg-subtle p-4 text-sm'
          : 'flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm'
      }
    >
      <h2 className="font-medium">{`This run ended: ${TERMINAL_REASON_LABEL[reason]}`}</h2>
      <p>{endedMeaning(reason, blocks)}</p>
      {reason === 'permission_denied' ? (
        <p className="flex flex-wrap items-baseline gap-x-2">
          {denied === null ? (
            <span>The transcript does not record which tool it was.</span>
          ) : (
            <span>
              {'The tool it was refused: '}
              <UntrustedText value={denied} className="font-mono" />.
            </span>
          )}
          <button type="button" className={LINK} onClick={onSettings}>
            See the run’s settings
          </button>
        </p>
      ) : null}
      {followUp === null ? null : (
        <p data-run-ended-next={followUp.kind} className="text-fg-muted">
          {followUp.kind === 'ran_again' ? (
            <>
              {ranAgainWords(followUp).text}
              <Link to="/runs/$runId" params={{ runId: followUp.run.id }} className={LINK}>
                {ranAgainWords(followUp).link}
              </Link>
            </>
          ) : (
            followUpWords(followUp)
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {rerun ? (
          <Button disabled={rerunPending} onClick={onRerun}>
            Re-run as configured
          </Button>
        ) : null}
        {work ? <Button onClick={onTakeOver}>Work on it yourself…</Button> : null}
        {openTask('Open the task', LINK)}
        {blocks.length === 0 ? null : (
          <button type="button" className={LINK} onClick={onJump}>
            Jump to the last lines
          </button>
        )}
      </div>
    </section>
  );
};
