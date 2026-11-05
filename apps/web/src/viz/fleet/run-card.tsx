/**
 * One run as a card — the fleet map's run node (TD-033 decision 8 (b)), the canvas's stage card's
 * sibling: the status dot and word ("● Working"), the project, the ticket key and title, the "Now:
 * Reading files" pill, `PhaseTrack` small — the task's whole pipeline with the current stage named
 * under it (the stage's name alone until the task's read answers) — and the model, how long it has
 * run and what it has cost so far.
 *
 * **The whole card opens the run's dialog**, through one `<button>` whose box is stretched over the
 * card (`after:inset-0`), so `PhaseTrack`'s list — flow content a button may not hold — sits beside
 * the button rather than inside it. The button's name is the run's whole sentence
 * (`runSentence`), opening with the ticket key it shows.
 *
 * The ticket key, the title and the project key are the tracker's and the operator's text (BD-022):
 * React text nodes, sanitised, never markup, never a link (a link would nest in the button).
 */
import type { ReactElement } from 'react';
import { cx, FOCUS_RING } from '../../ui/cx.js';
import { formatElapsed, formatRunCost } from '../../ui/kit.js';
import { PhaseTrack } from '../../ui/phase-track.js';
import { StatusIcon } from '../../ui/status.js';
import { sanitiseUntrusted } from '../../ui/untrusted-text.js';
import { type FleetRun, type FleetSeat, runSentence } from './model.js';

/** The tone's border and glow, per activity tone — literal classes for Tailwind's scanner. */
const TONE_FRAME: Readonly<Record<FleetRun['meta']['tone'], string>> = {
  running: 'border-running shadow-[0_0_0_3px_var(--running-bg)]',
  attention: 'border-attention',
  success: 'border-success',
  danger: 'border-danger',
  muted: 'border-line',
  subtle: 'border-line border-dashed',
};

const TONE_TEXT: Readonly<Record<FleetRun['meta']['tone'], string>> = {
  running: 'text-running',
  attention: 'text-attention',
  success: 'text-success',
  danger: 'text-danger',
  muted: 'text-fg-muted',
  subtle: 'text-fg-subtle',
};

/** "DEMO-1 · Checkout flow" — key and title as one plain string, sanitised. */
export const runHeadline = (run: Pick<FleetRun, 'ticketKey' | 'title'>): string => {
  const key = run.ticketKey === null ? null : sanitiseUntrusted(run.ticketKey);
  const title = run.title === null ? null : sanitiseUntrusted(run.title);
  return key === null ? (title ?? 'Loading the task…') : title === null ? key : `${key} · ${title}`;
};

export const FleetRunCard = ({
  run,
  seat,
  now,
  onOpen,
  className,
}: {
  readonly run: FleetRun;
  readonly seat: FleetSeat | null;
  readonly now: number;
  readonly onOpen: (runId: string) => void;
  readonly className?: string;
}): ReactElement => {
  const live = !run.ended;
  return (
    <article
      data-fleet-run={run.id}
      data-activity={run.activity.activity}
      className={cx(
        'relative flex h-full w-full min-w-0 flex-col gap-1.5 overflow-hidden rounded-lg border bg-subtle px-3 py-2.5 text-left text-fg transition-colors hover:bg-muted',
        TONE_FRAME[run.meta.tone],
        className,
      )}
    >
      <button
        type="button"
        aria-label={runSentence(run, seat)}
        aria-haspopup="dialog"
        onClick={() => {
          onOpen(run.id);
        }}
        className={cx(
          'nodrag nopan flex min-w-0 flex-col gap-1 text-left after:absolute after:inset-0 after:rounded-lg after:content-[""]',
          FOCUS_RING,
        )}
      >
        <span
          className={cx(
            'flex min-w-0 items-center gap-1.5 text-xs font-semibold',
            TONE_TEXT[run.meta.tone],
          )}
        >
          <StatusIcon status={run.meta.icon} decorative size={12} />
          <span className="truncate">
            {run.ended ? `${run.meta.label} just now` : run.meta.label}
          </span>
          {run.projectKey === null ? null : (
            <span className="ml-auto shrink-0 truncate font-mono font-normal text-fg-muted">
              {sanitiseUntrusted(run.projectKey)}
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-sm font-semibold break-words">{runHeadline(run)}</span>
        {run.phases.length === 0 ? (
          // Until the task's read answers there is no strip to name the stage: say it here.
          <span className="truncate text-xs text-fg-muted">{run.stageName}</span>
        ) : null}
        {run.activity.detail === null ? null : (
          <span
            data-fleet-now=""
            className={cx(
              'self-start truncate rounded-full border px-2 py-px text-[11px] font-medium',
              run.meta.tone === 'running'
                ? 'border-running/40 bg-running-bg text-running'
                : 'border-line bg-canvas text-fg-muted',
            )}
          >
            {`Now: ${run.activity.detail}`}
          </span>
        )}
      </button>
      {run.phases.length === 0 ? null : <PhaseTrack stages={run.phases} size="sm" />}
      <span className="mt-auto flex min-w-0 items-center gap-1.5 text-[11px] text-fg-muted">
        <span className="truncate rounded border border-line bg-canvas px-1 font-mono">
          {sanitiseUntrusted(run.run.model)}
        </span>
        <span className="shrink-0 tabular-nums">
          {live
            ? formatElapsed(run.run.started_at, now)
            : formatElapsed(run.run.started_at, Date.parse(run.run.ended_at ?? '') || now)}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {formatRunCost(run.run.cost, { estimate: true })}
        </span>
      </span>
    </article>
  );
};
