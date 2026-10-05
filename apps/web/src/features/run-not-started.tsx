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
 */

import type { RunStartFailure } from '@platform/contracts';
import type { ReactElement } from 'react';
import { TerminalText, UntrustedText } from '../ui/untrusted.js';

export const RunNotStartedPanel = ({
  failure,
}: {
  readonly failure: RunStartFailure;
}): ReactElement => (
  <section
    aria-label="This run did not start"
    className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm"
  >
    <h2 className="font-medium">This run did not start</h2>
    <p className="text-fg-muted">
      Its workspace could not be created, so no agent ran and there is no transcript. Attempt{' '}
      {failure.attempt}
      {failure.retryable
        ? ' — the stage was queued to try again.'
        : ' — the task was handed to a person.'}
    </p>
    <p className="font-mono text-xs">
      <UntrustedText value={failure.diagnosis} />
    </p>
    {failure.detail === null ? (
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
