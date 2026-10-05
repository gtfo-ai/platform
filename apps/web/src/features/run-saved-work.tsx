/**
 * "This run's unfinished work was saved" — the run page's one line about what the platform did with
 * the tree of a run that ended without a result (the product owner's 2026-10-05 decision, PROGRESS
 * backlog 467), read off `RunRecord.saved_work`.
 *
 * Three answers, and each is what the record says rather than what a reader might hope: **pushed**
 * (the branch carries the work and a retry of the stage continues from it), **not pushed** (the
 * platform tried, the push failed, and the work is only in the workspace volume), and **nothing** for
 * every other run — a success, a role whose work is not saved, a tree with no changes — which renders
 * no line at all. The branch is derived from the ticket key, so it is rendered as untrusted text.
 */

import type { RunSavedWork } from '@platform/contracts';
import type { ReactElement } from 'react';
import { UntrustedText } from '../ui/untrusted.js';

export const RunSavedWorkLine = ({
  saved,
}: {
  readonly saved: RunSavedWork | null;
}): ReactElement | null => {
  if (saved === null) {
    return null;
  }
  return (
    <section aria-label="Unfinished work" className="text-xs text-fg-muted">
      {saved.pushed
        ? 'Unfinished work saved: pushed to '
        : 'Unfinished work not saved: the push to '}
      <span className="font-mono">
        <UntrustedText value={saved.branch} />
      </span>
      {saved.pushed
        ? `${saved.commit_sha === null ? '' : ` at ${saved.commit_sha.slice(0, 12)}`}. A retry of this stage continues from that branch.`
        : ' did not succeed, so the work is only in this run’s workspace volume until its retention ends.'}
    </section>
  );
};
