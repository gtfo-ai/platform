/**
 * "This run did not start" — what the run page shows **instead of an empty transcript** when the
 * run's workspace could not be created (PROGRESS backlog 453).
 *
 * Before it, a run whose launcher `create` failed (a helper container that exited non-zero, a
 * Docker timeout, a permissions error on the control volume) opened on an empty transcript, and the
 * only place its reason existed was the runner's log. `RunRecord.start_failure` now carries it:
 *
 *  - `diagnosis` is platform text — the closed-vocabulary sentence the escalation also carries;
 *  - `detail` is the launcher's message and the failing step's output tail, **untrusted** (BD-022):
 *    a clone's stderr quotes text the repository controls. It is rendered through
 *    `ui/untrusted.tsx`'s `TerminalText` — a text node, ANSI stripped, never markup.
 *
 * The cut is the server's and is announced here from `truncated`, never inferred from the text.
 *
 * **A run that was stopped before it started** (WP-154 (b′), PROGRESS backlog 502) has the same
 * record — a person's cancel, or a hand-back at shutdown, that landed before the CLI spawn marker —
 * and the same panel, with its own sentence: nothing failed, somebody (or the platform's own
 * restart) stopped it first, and no launcher said anything. `stopped` is the run's own status, so
 * the panel never tells a person who cancelled a run that its workspace could not be created.
 */

import type { RunRecord, RunStartFailure } from '@platform/contracts';
import type { ReactElement } from 'react';
import { TerminalText, UntrustedText } from '../ui/untrusted.js';

/** Did a stop end this run — a person's cancel, or a hand-back at shutdown — rather than a failure? */
export const isStoppedRun = (run: Pick<RunRecord, 'status' | 'terminal_reason'>): boolean =>
  run.status === 'cancelled' || run.terminal_reason === 'shutdown';

export const RunNotStartedPanel = ({
  failure,
  stopped = false,
}: {
  readonly failure: RunStartFailure;
  /** The run was stopped before its CLI was asked for, rather than refused by its workspace. */
  readonly stopped?: boolean;
}): ReactElement => (
  <section
    aria-label="This run did not start"
    className={
      stopped
        ? 'flex flex-col gap-2 rounded-lg border border-line bg-bg-subtle p-4 text-sm'
        : 'flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm'
    }
  >
    <h2 className="font-medium">This run did not start</h2>
    {stopped ? (
      <p className="text-fg-muted">
        It was stopped before its CLI was asked to start, so no agent ran, nothing was spent and
        there is no transcript.
        {failure.retryable ? ' The stage was queued to try again.' : ''}
      </p>
    ) : (
      <p className="text-fg-muted">
        Its workspace could not be created, so no agent ran and there is no transcript. Attempt{' '}
        {failure.attempt}
        {failure.retryable
          ? ' — the stage was queued to try again.'
          : ' — the task was handed to a person.'}
      </p>
    )}
    <p className="font-mono text-xs">
      <UntrustedText value={failure.diagnosis} />
    </p>
    {stopped && failure.detail === null ? null : failure.detail === null ? (
      <p className="text-fg-muted">
        The launcher gave no reason of its own; the runner’s log has the error under this run’s id.
      </p>
    ) : (
      <>
        <p className="text-fg-muted">
          {failure.truncated
            ? 'What the launcher reported (shortened by the platform):'
            : 'What the launcher reported:'}
        </p>
        <TerminalText value={failure.detail} />
      </>
    )}
  </section>
);
