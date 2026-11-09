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
 *    the reason: a newer attempt of the same stage (linked), the task stopped for a person, paused,
 *    ended — or nothing yet, said as such.
 * 3. **The next step** — *Re-run as configured*, *Work on it yourself…* and *Open the task*, each
 *    only for a reader who may ({@link mayRerunAndWork}); *See the run’s settings* for a refused
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
 * Whether the reader may *Re-run* and *Work on it yourself…*: `run.retry` and `task.take_over` both
 * need `member`, which is what the task read's role-only `can_pause` (`task.pause`) answers — the
 * read has no fact of its own for either, and `run-ended.test.tsx` holds the three requirements
 * equal in `@platform/domain`'s table, so a change to one fails there rather than here. `false`
 * until the task read answers.
 */
export const mayRerunAndWork = (detail: Pick<TaskDetailResponse, 'can_pause'> | undefined) =>
  detail?.can_pause === true;

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
  | { readonly kind: 'ran_again'; readonly run: RunRecord }
  | { readonly kind: 'needs_person' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'finished' }
  | { readonly kind: 'ask' }
  | { readonly kind: 'nothing' };

/**
 * `null` until the task read answers. A run with no stage is an ask, which runs beside the pipeline
 * and moves nothing. Otherwise: the newest **later** attempt of the same stage, if there is one;
 * else what the task's state says — stopped for a person, paused, finished — else nothing yet.
 */
export const endedFollowUp = (
  run: Pick<RunRecord, 'id' | 'stage' | 'attempt'>,
  detail: Pick<TaskDetailResponse, 'runs' | 'task'> | undefined,
): EndedFollowUp | null => {
  if (detail === undefined) {
    return null;
  }
  if (run.stage === null) {
    return { kind: 'ask' };
  }
  const later = detail.runs
    .filter(
      (entry) => entry.id !== run.id && entry.stage === run.stage && entry.attempt > run.attempt,
    )
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (later !== undefined) {
    return { kind: 'ran_again', run: later };
  }
  switch (detail.task.state) {
    case 'needs_human':
      return { kind: 'needs_person' };
    case 'paused':
      return { kind: 'paused' };
    case 'done':
    case 'cancelled':
      return { kind: 'finished' };
    default:
      return { kind: 'nothing' };
  }
};

const FOLLOW_UP_WORDS: Readonly<Record<Exclude<EndedFollowUp['kind'], 'ran_again'>, string>> = {
  needs_person:
    'The task stopped for a person: it waits on the task page for somebody to decide what happens next.',
  paused: 'The task is paused; nothing runs until somebody resumes it.',
  finished: 'The task has ended since.',
  ask: 'This run answered a question about the task, so the task’s pipeline did not move.',
  nothing:
    'Nothing else has happened since: no newer attempt of this stage, and the task has not stopped for a person.',
};

const LINK = cx('rounded-sm text-link underline', FOCUS_RING);

export const RunEndedPanel = ({
  record,
  reason,
  detail,
  blocks,
  mayAct,
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
  /** {@link mayRerunAndWork} over the task read. */
  readonly mayAct: boolean;
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
  const rerun = mayAct && record.stage !== null;
  const work = mayAct && takeOverOffered;
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
              {isLiveRun(followUp.run.status)
                ? `The stage is running again: attempt ${followUp.run.attempt}. `
                : `The stage was run again: attempt ${followUp.run.attempt}, ${RUN_STATUS_LABEL[followUp.run.status].toLowerCase()}. `}
              <Link to="/runs/$runId" params={{ runId: followUp.run.id }} className={LINK}>
                {`Open attempt ${followUp.run.attempt}`}
              </Link>
            </>
          ) : (
            FOLLOW_UP_WORDS[followUp.kind]
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
