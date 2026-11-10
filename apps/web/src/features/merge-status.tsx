/**
 * **Who merges, said on the task page** (S-28.15, TD-038 decision 7 and amendment A). The task
 * read's `merge` block says who merges this task at Ready and what the platform's merge waits for,
 * and its last attempt; this box says it in the product's words, before and after:
 *
 * - *A person merges: this project's setting.* (or the provider cannot merge, or a shadow run);
 * - *Merging automatically when GitLab reports it mergeable — now: 2 threads are unresolved.* —
 *   the provider's own reason, from the S-28.13 check, or what the platform waits for;
 * - *The platform's merge was refused: GitLab said the branch moved (409) — merge it yourself or
 *   Send back.*, a failure after 3 tries, a rebase that changed the change;
 * - *Merged by the platform at 14:02, commit abc1234 — plan approved by Jana Nováková* (or
 *   *approved by the platform as low-risk*, *no plan approval required*).
 *
 * Every value is a platform code or a sha; the approver's name is a platform user's (React text).
 */
import type { TaskDetailResponse } from '@platform/contracts';
import type { ReactElement } from 'react';
import { Flash } from '../ui/flash.js';
import { ExternalLink } from '../ui/untrusted.js';
import { mergeBlockedWhy } from '../ui/words/merge-blockers.js';
import { mergeAttemptSentence, mergeWaitSentence } from '../ui/words/merge-status.js';
import { providerName } from './gate-wait.js';

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `14:02` in the reader's own zone. */
const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The lines this box says, in order, with the tone — exported for the test. */
export const mergeStatusLines = (
  detail: TaskDetailResponse,
): { readonly tone: 'info' | 'warning' | 'success'; readonly lines: readonly string[] } | null => {
  const merge = detail.merge ?? null;
  if (merge === null) {
    return null;
  }
  const provider = capitalised(providerName(detail.task.mr_ref?.provider));
  const attempt = merge.last_attempt;
  if (attempt !== null && attempt.outcome !== 'rebased') {
    return {
      tone: attempt.outcome === 'merged' ? 'success' : 'warning',
      lines: [mergeAttemptSentence(attempt, provider, clock(attempt.attempted_at))],
    };
  }
  if (detail.task.state !== 'ready_for_merge') {
    return null;
  }
  const blocked = (detail.provider_sync ?? []).find(
    (row) => row.subject === 'merge_request_blocked',
  );
  const blockedNow =
    merge.by === 'platform' &&
    blocked !== undefined &&
    (merge.waiting_for === null || merge.waiting_for === 'provider_blocked')
      ? mergeBlockedWhy(blocked.reason_code, blocked.observed, blocked.unresolved_threads ?? null)
      : null;
  const lines = [mergeWaitSentence(merge.by, merge.waiting_for, provider, blockedNow)];
  if (attempt !== null) {
    lines.push(mergeAttemptSentence(attempt, provider, clock(attempt.attempted_at)));
  }
  return { tone: 'info', lines };
};

export const MergeStatusNotice = ({
  detail,
}: {
  readonly detail: TaskDetailResponse;
}): ReactElement | null => {
  const said = mergeStatusLines(detail);
  if (said === null) {
    return null;
  }
  const mr = detail.task.mr_ref;
  return (
    <section aria-label="Who merges" data-testid="merge-status">
      <Flash
        tone={said.tone}
        title={
          detail.merge?.by === 'platform' ? 'The platform merges this' : 'A person merges this'
        }
      >
        <div className="flex flex-col gap-2 pt-1">
          {said.lines.map((line) => (
            <p key={line} data-merge-status="">
              {line}
            </p>
          ))}
          {mr === null || mr === undefined ? null : (
            <div>
              <ExternalLink
                url={mr.url}
                label={`Open the merge request on ${providerName(mr.provider)}`}
              />
            </div>
          )}
        </div>
      </Flash>
    </section>
  );
};
