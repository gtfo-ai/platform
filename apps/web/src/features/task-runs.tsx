/**
 * The task page's **Runs** tab (S-23.9b): every run of the task — one agent working one stage — as
 * a list box with a status icon, the stage and role, the model, what it cost and how long it took,
 * each leading to its run page. A run nobody measured says *not measured*, never `$0.00` (WP-119),
 * and a run whose unfinished work was pushed says so (backlog 467). A run that ended badly says why
 * beside its status — *Failed · Lost its worker*, *Failed · Did not start* (S-25.19).
 */
import type { RunRecord, RunStatus } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { RUN_STATUS_LABEL, runEndedShort, runSubject } from '../ui/humanize.js';
import { Badge, EmptyState, formatElapsed, formatRunCost } from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { rowLink } from '../ui/row-link.js';
import { type Status, StatusIcon } from '../ui/status.js';
import { UntrustedText } from '../ui/untrusted.js';
import { COST_UNREPORTED_SHORT } from '../ui/words/terminal-reasons.js';

const RUN_STATUS: Readonly<Record<RunStatus, Status>> = {
  created: 'queued',
  // WP-275b: `starting` is live too — claimed, its CLI not yet asked for.
  starting: 'running',
  running: 'running',
  completed: 'success',
  failed: 'failure',
  cancelled: 'cancelled',
  budget_exceeded: 'failure',
  timed_out: 'failure',
  stalled: 'failure',
};

/**
 * The row's status words: the status, and the reason's short form when it adds something
 * (`runEndedShort`) and is not the status said again (*Timed out* ended *Timed out*) — and a run
 * stopped for an unmeasured cost says only that, never *Over budget* (S-25.22).
 */
export const runStatusWords = (
  run: Pick<RunRecord, 'status' | 'terminal_reason' | 'start_failure' | 'stop_reason'>,
): string => {
  const status = RUN_STATUS_LABEL[run.status];
  const short = runEndedShort(run);
  // S-25.22 (BACKLOG 1394): such a run's status is `budget_exceeded` (*Over budget*), which is
  // untrue of a run nobody measured — the fault is said alone.
  if (short === COST_UNREPORTED_SHORT) {
    return short;
  }
  return short === null || short.toLowerCase() === status.toLowerCase()
    ? status
    : `${status} · ${short}`;
};

/** How long a run took — start to end, or to now while it is live; `—` before it started. */
export const runDuration = (
  run: Pick<RunRecord, 'started_at' | 'ended_at'>,
  nowMs: number,
): string => {
  const end =
    run.ended_at === null || run.ended_at === undefined ? nowMs : Date.parse(run.ended_at);
  return formatElapsed(run.started_at, Number.isNaN(end) ? nowMs : end);
};

export const TaskRuns = ({
  runs,
  nowMs,
}: {
  readonly runs: readonly RunRecord[];
  readonly nowMs: number;
}): ReactElement =>
  runs.length === 0 ? (
    <EmptyState
      title="No runs yet"
      hint="A run is one agent working one stage. Open one to watch its transcript live."
    />
  ) : (
    <ListBox
      label="Runs"
      header={
        <ListBoxHeader>
          <span className="font-semibold">
            {runs.length === 1 ? '1 run' : `${runs.length} runs`}
          </span>
        </ListBoxHeader>
      }
    >
      {runs.map((run) => (
        <ListRow
          key={run.id}
          leading={<StatusIcon status={RUN_STATUS[run.status]} label={runStatusWords(run)} />}
          title={
            <Link to="/runs/$runId" params={{ runId: run.id }} {...rowLink('hover:underline')}>
              {runSubject(run)}
            </Link>
          }
          meta={
            <span className="flex flex-wrap items-center gap-2">
              <span data-run-status="">{runStatusWords(run)}</span>
              <UntrustedText value={run.model} />
              {/* Backlog 467: the run's unfinished work is on the task's branch. */}
              {run.saved_work?.pushed === true ? (
                <Badge tone="warning">work saved to branch</Badge>
              ) : null}
            </span>
          }
          trailing={
            <span>
              {formatRunCost(run.cost)} · {runDuration(run, nowMs)}
            </span>
          }
        />
      ))}
    </ListBox>
  );
