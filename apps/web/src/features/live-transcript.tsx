/**
 * The running stage's transcript **on the task page** (WP-154 (c), PROGRESS backlog 455 item (4)).
 *
 * The run page's own pieces, not a second renderer: `TranscriptView` over the same transcript store,
 * fed the same two ways — history from `useRunMessages` (one page, merged into the store by `seq`)
 * and live frames from the `run:<id>` topic, which `LiveStagePanel` already retains while it is
 * mounted and which the realtime provider writes into that store. So a frame the run page would
 * show appears here too, and a frame replayed on reconnect changes nothing.
 *
 * **Bounded to the last {@link TASK_PAGE_TRANSCRIPT_BLOCKS} blocks**, with *Open the full run*: the
 * task page answers "is anything happening?", and the run page is where the whole session is read,
 * searched and steered.
 *
 * **Loaded lazily** (`live-stage.tsx`), like the run route (`routes/tree.tsx`): the transcript
 * renderer is the largest component in the app and TD-013's budget is about the initial graph, so a
 * person on the board does not pay for it, and the task page pays only while a stage is running.
 *
 * Everything rendered is untrusted (BD-022) and goes through `TranscriptView`'s renderers, which
 * render through `ui/untrusted.tsx`.
 */
import { Link } from '@tanstack/react-router';
import { type ReactElement, useSyncExternalStore } from 'react';
import { useRunMessages } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { TranscriptView } from '../transcript/view.js';
import { formatInteger } from '../ui/kit.js';

/** How many of the newest transcript blocks the task page shows (WP-154 ruling (c)). */
export const TASK_PAGE_TRANSCRIPT_BLOCKS = 30;

export const LiveTranscript = ({ runId }: { readonly runId: string }): ReactElement => {
  const { transcripts } = useServices();
  const messages = useRunMessages(runId);
  const snapshot = useSyncExternalStore(
    (listener) => transcripts.subscribe(runId, listener),
    () => transcripts.snapshot(runId),
    () => transcripts.snapshot(runId),
  );
  const total = snapshot.blocks.length;
  const shown = snapshot.blocks.slice(-TASK_PAGE_TRANSCRIPT_BLOCKS);
  return (
    <div data-testid="live-transcript" className="flex max-h-[32rem] min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span>
          {total > shown.length
            ? `The last ${formatInteger(shown.length)} of ${formatInteger(total)} blocks.`
            : 'The whole transcript so far.'}
        </span>
        <Link
          to="/runs/$runId"
          params={{ runId }}
          className="ml-auto text-xs text-accent underline"
        >
          Open the full run
        </Link>
      </div>
      {messages.isError ? (
        <p className="text-xs text-fg-muted">
          What the run wrote before this page opened could not be loaded; new entries still arrive
          live.
        </p>
      ) : null}
      <TranscriptView
        blocks={shown}
        emptyHint="Nothing yet. Entries appear here as the agent works — the stream is live."
      />
    </div>
  );
};
