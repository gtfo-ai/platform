/**
 * **The claim and the QA stage on the task page** — WP-182 ruling (c), BD-031 rulings 3 and 5.
 *
 * The task DTO carries `ticket_claim` (WP-181, off `tasks.ticket_claim`) and `qa_stage` (frozen at the
 * task's creation from the binding's `lifecycle.qa`). This renders both beside the task's state:
 *
 *  - **confirmed** — the platform assigned the ticket to its own account and the re-read found it
 *    there;
 *  - **shadow** — the writes were recorded as *would have* (shadow mode) and nothing was assigned;
 *  - **released** — the claim was given back (a cancel, a rework, or a task that stopped between the
 *    assign and its record), whichever of the two it was before;
 *  - `null` — the task never claimed (no lifecycle on the binding, no ticket, a row older than the
 *    column), and nothing is rendered: absence is not a state worth a badge.
 *
 * Every word here is platform text; the only values are two timestamps.
 */
import type { TaskRecord } from '@platform/contracts';
import type { ReactElement } from 'react';
import { Badge, type BadgeTone, formatDateTime } from '../ui/kit.js';

/** The claim's one-word state, as the badge says it. */
export type ClaimState = 'confirmed' | 'shadow' | 'released';

export const claimStateOf = (claim: NonNullable<TaskRecord['ticket_claim']>): ClaimState =>
  claim.released_at !== null ? 'released' : claim.status;

const CLAIM_BADGE: Readonly<Record<ClaimState, { label: string; tone: BadgeTone }>> = {
  confirmed: { label: 'ticket claimed', tone: 'success' },
  shadow: { label: 'claim (shadow)', tone: 'warning' },
  released: { label: 'claim released', tone: 'neutral' },
};

/** The sentence beside the badge: when, and what it means. */
export const claimSentence = (claim: NonNullable<TaskRecord['ticket_claim']>): string => {
  const claimed = formatDateTime(claim.claimed_at);
  if (claim.released_at !== null) {
    return `Claimed ${claimed}${claim.status === 'shadow' ? ' in shadow mode' : ''}; given back ${formatDateTime(claim.released_at)} — the ticket is no longer assigned to the platform.`;
  }
  return claim.status === 'shadow'
    ? `Shadow mode, ${claimed}: the platform would have assigned the ticket to itself, and assigned nothing.`
    : `Assigned to the platform’s own account ${claimed}, and confirmed on the tracker.`;
};

/** The claim and the QA stage, as badges for the task header and one line under it. */
export const TicketClaimAndQa = ({
  task,
}: {
  readonly task: Pick<TaskRecord, 'ticket_claim' | 'qa_stage'>;
}): ReactElement | null => {
  const claim = task.ticket_claim;
  if (claim === null && !task.qa_stage) {
    return null;
  }
  const state = claim === null ? null : claimStateOf(claim);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-ticket-claim={state ?? 'none'}>
      {state === null || claim === null ? null : (
        <>
          <Badge tone={CLAIM_BADGE[state].tone}>{CLAIM_BADGE[state].label}</Badge>
          <span className="text-fg-muted">{claimSentence(claim)}</span>
        </>
      )}
      {task.qa_stage ? (
        <span data-qa-stage="true" className="flex items-center gap-2">
          <Badge tone="accent">QA stage</Badge>
          <span className="text-fg-muted">
            A person tests this task before Ready for merge (the project maps a QA status).
          </span>
        </span>
      ) : null}
    </div>
  );
};
