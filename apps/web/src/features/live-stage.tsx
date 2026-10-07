/**
 * The task page's answer to "is anything happening?" (PROGRESS backlog 455 (1), backlog 496).
 *
 * While a stage's run is live the task page shows one panel above everything else: a live
 * indicator, the stage and role, how long the run has been going, and the **latest progress line**
 * the agent reported through `report_progress`. The line comes from two places, exactly as the run
 * page's transcript does: the run record's `latest_progress` — the newest `progress` row when the
 * page was read — and the `run:<id>` stream this panel subscribes to while it is mounted, whose
 * frames land in the shared transcript store. The newer `seq` wins, so a line reported after the
 * page loaded replaces the one it loaded with, and a frame replayed on reconnect changes nothing.
 *
 * The elapsed time is re-read on every render, and the subscription re-renders the panel on every
 * frame the run writes — so the clock moves while the agent works and stops when it is silent,
 * which is itself an answer to the question.
 *
 * The summary is the model's words (BD-022): a text node through `UntrustedText`, never markup.
 *
 * **Below the line, the run's transcript as it happens** (WP-154 (c), backlog 455 item (4)): the
 * run page's `TranscriptView` over the same store and the same `run:<id>` subscription this panel
 * already holds, bounded to the newest blocks (`live-transcript.tsx`). It is loaded lazily, so the
 * transcript renderer stays out of the initial bundle (TD-013).
 */
import type { RunLatestProgress, RunRecord, TranscriptEvent } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { lazy, type ReactElement, Suspense, useSyncExternalStore } from 'react';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { Badge, Card, formatElapsed, formatInteger } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The bounded live transcript, in its own chunk (see the module note). */
const LiveTranscript = lazy(async () => ({
  default: (await import('./live-transcript.js')).LiveTranscript,
}));

/** A run that has not ended (`ACTIVE_RUN_STATUSES` in `@platform/domain`). */
const LIVE_STATUSES: readonly RunRecord['status'][] = ['created', 'starting', 'running'];

/**
 * The run the task page calls *live*: the newest stage run that has not ended. An ask run (no
 * stage) answers a person beside the pipeline and has its own thread, so it is not the stage's.
 */
export const liveStageRun = (runs: readonly RunRecord[]): RunRecord | null =>
  runs.reduce<RunRecord | null>(
    (newest, run) => (run.stage !== null && LIVE_STATUSES.includes(run.status) ? run : newest),
    null,
  );

/** The newer of the record's line and the newest `progress` frame the stream delivered. */
export const latestProgressOf = (
  recorded: RunLatestProgress | null,
  events: readonly TranscriptEvent[],
): RunLatestProgress | null => {
  let latest = recorded;
  for (const event of events) {
    if (event.kind === 'progress' && (latest === null || event.seq > latest.seq)) {
      latest = {
        seq: event.seq,
        at: event.created_at,
        summary: event.summary,
        percent_complete: event.percent_complete ?? null,
      };
    }
  }
  return latest;
};

export const LiveStagePanel = ({ run }: { readonly run: RunRecord }): ReactElement => {
  useTopics([`run:${run.id}`]);
  const { transcripts, now } = useServices();
  const snapshot = useSyncExternalStore(
    (listener) => transcripts.subscribe(run.id, listener),
    () => transcripts.snapshot(run.id),
    () => transcripts.snapshot(run.id),
  );
  const progress = latestProgressOf(run.latest_progress, snapshot.events);
  // Read on every render: a frame re-renders only this panel, so it reads its own clock.
  const current = now();
  return (
    <section data-testid="live-stage" aria-label="Running now">
      <Card className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-full bg-accent motion-safe:animate-pulse"
          />
          <span className="text-sm font-medium">
            {run.stage} · {run.role}
          </span>
          <Badge tone="accent">{run.status}</Badge>
          <span className="text-xs text-fg-muted">
            {run.started_at === null || run.started_at === undefined
              ? 'not started yet'
              : `for ${formatElapsed(run.started_at, current)}`}
          </span>
          <Link
            to="/runs/$runId"
            params={{ runId: run.id }}
            className="ml-auto text-xs text-accent underline"
          >
            Watch the run
          </Link>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm" role="status" aria-live="polite">
          {progress === null ? (
            <span className="text-fg-muted">
              No progress reported yet. The agent reports a line as it finishes each step.
            </span>
          ) : (
            <>
              {progress.percent_complete === null ? null : (
                <Badge tone="accent">{`${formatInteger(progress.percent_complete)}%`}</Badge>
              )}
              <span data-testid="live-stage-progress">
                <UntrustedText value={progress.summary} />
              </span>
              <span className="text-xs text-fg-muted">
                {`${formatElapsed(progress.at, current)} ago`}
              </span>
            </>
          )}
        </p>
        <Suspense fallback={<p className="text-xs text-fg-muted">Loading the transcript…</p>}>
          <LiveTranscript runId={run.id} />
        </Suspense>
      </Card>
    </section>
  );
};
