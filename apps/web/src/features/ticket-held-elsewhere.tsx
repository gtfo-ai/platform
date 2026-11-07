/**
 * **A task whose ticket someone else holds** (S-25.14, product/10's Task detail amendment of
 * 2026-11-07): the needs-you callout's body for the stop `ticket_assigned_elsewhere`. It says whose
 * ticket it is (`./ticket-held-words.ts`) and offers the ways out **in the box**, each only to a
 * reader who may use it:
 *
 * - *Take it* / *Assign…* — the header's **one** owner control (`./task-owner.tsx`), passed in, so
 *   *Take it*'s confirmation (the `take_writes_back` wording) and *Assign…*'s picker (each
 *   candidate's `writes_back`) open once, whichever button opened them. Offered on the read's
 *   `can_take` / `can_assign`, while nobody owns the task;
 * - *Link account…* — Settings → Linked accounts, for a reader who may open it (an administrator),
 *   and only when the person is not linked;
 * - *Open in Jira* — the ticket's own page, through `ExternalLink` (`safeHref`);
 * - *Give it back to the agent* — once an owner is set, the existing `resume` command (`can_resume`):
 *   the task re-enters the stage it stopped at. It is this page's word for product/10's *Hand
 *   back*; the take-over's hand-back is a different command that needs a take-over in force;
 * - *Cancel task…* — the existing cancel confirmation (`can_cancel`).
 *
 * **One amber primary** ({@link heldElsewhereTakeLeads}): *Take it*, when the reader may take it and
 * nothing else on the page is the primary; otherwise none — the header's *Resume* gives way to it
 * (`taskPrimaryAction`'s `heldElsewhere`), because resuming before somebody owns the task only
 * stops it again. The escalation's brief is kept under a collapsed *Details*, as for every
 * structured stop (the review of #111).
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import type { useTaskCommands } from '../app/queries.js';
import { buttonClassName } from '../ui/button.js';
import { OWNER_WORDS, trackerName } from '../ui/humanize.js';
import { Button } from '../ui/kit.js';
import { ExternalLink, UntrustedProse } from '../ui/untrusted.js';
import { isOrgSectionFor } from './settings-sections.js';
import type { TaskDialog } from './task-dialogs.js';
import type { OwnerAction, OwnerControl } from './task-owner.js';
import { HELD_ELSEWHERE_WORDS, heldElsewhereWords, ticketHolder } from './ticket-held-words.js';
import { WaitingWords } from './waiting-words.js';

const STEP = buttonClassName('default', 'sm');

/** The owner actions the box offers; *Unassign* would not move the task. */
const BOX_ACTIONS: readonly OwnerAction[] = ['take', 'assign'];

/**
 * Whether the box's *Take it* is the page's one amber primary: nobody owns the task, the reader
 * may take it, and nothing the header would put first applies — a take-over to hand back, an open
 * question, an approval the reader may decide.
 */
export const heldElsewhereTakeLeads = (
  detail: TaskDetailResponse,
  offers: readonly OwnerAction[],
): boolean =>
  (detail.task.owner ?? null) === null &&
  offers.includes('take') &&
  (detail.taken_over === null || detail.taken_over.hand_back_stages.length === 0) &&
  !detail.questions.some((question) => question.status === 'open') &&
  !(
    detail.can_decide_approval && detail.approvals.some((approval) => approval.status === 'pending')
  );

export const HeldElsewhere = ({
  detail,
  owner,
  commands,
  onOpen,
}: {
  readonly detail: TaskDetailResponse;
  /** The header's owner control; without it no owner action is offered. */
  readonly owner: OwnerControl | undefined;
  readonly commands: ReturnType<typeof useTaskCommands>;
  readonly onOpen: (dialog: TaskDialog) => void;
}): ReactElement => {
  const { task, escalation } = detail;
  const tracker = trackerName(task.ticket.provider);
  const holder = ticketHolder(task);
  const words = heldElsewhereWords(task.ticket.key, tracker, holder);
  const owned = (task.owner ?? null) !== null;
  const offers = owned
    ? []
    : (owner?.offers ?? []).filter((action) => BOX_ACTIONS.includes(action));
  const takeLeads = owner !== undefined && heldElsewhereTakeLeads(detail, offers);
  const mayLink = holder.unlinked && isOrgSectionFor('identities', owner?.viewer?.role);
  const mayHandBack = owned && detail.can_resume;
  const pending = owner?.command.isPending === true;
  return (
    <div
      className="flex flex-col gap-2"
      data-held-elsewhere={
        holder.name === null ? 'nameless' : holder.unlinked ? 'unlinked' : 'linked'
      }
    >
      <p data-held-sentence="">
        <WaitingWords parts={words.sentence} />
        {words.unlinked === null ? null : (
          <>
            {' '}
            <span data-held-unlinked="">
              <WaitingWords parts={words.unlinked} />
            </span>
          </>
        )}
      </p>
      {owned ? <p data-held-owned="">{HELD_ELSEWHERE_WORDS.owned}</p> : null}
      <div className="flex flex-wrap items-center gap-2" data-held-steps="">
        {offers.map((action) => (
          <Button
            key={action}
            size="sm"
            tone={action === 'take' && takeLeads ? 'primary' : 'default'}
            data-held-action={action}
            disabled={pending}
            onClick={() => {
              owner?.run(action);
            }}
          >
            {action === 'take'
              ? OWNER_WORDS['owner.action.take']
              : OWNER_WORDS['owner.action.assign']}
          </Button>
        ))}
        {mayHandBack ? (
          <Button
            size="sm"
            data-held-action="hand_back"
            disabled={commands.resume.isPending}
            onClick={() => {
              commands.resume.mutate('resumed from the UI');
            }}
          >
            {HELD_ELSEWHERE_WORDS.handBack}
          </Button>
        ) : null}
        {mayLink ? (
          <Link
            to="/settings/$section"
            params={{ section: 'identities' }}
            className={STEP}
            data-held-step="link"
          >
            {OWNER_WORDS['owner.action.link']}
          </Link>
        ) : null}
        <ExternalLink
          url={task.ticket.url}
          label={HELD_ELSEWHERE_WORDS.open(tracker)}
          className={STEP}
        />
        {detail.can_cancel ? (
          <Button
            size="sm"
            tone="danger"
            data-held-action="cancel"
            onClick={() => {
              onOpen('cancel');
            }}
          >
            {HELD_ELSEWHERE_WORDS.cancel}
          </Button>
        ) : null}
      </div>
      {escalation === null ? null : (
        <details data-escalation-details="">
          <summary className="cursor-pointer text-sm">{HELD_ELSEWHERE_WORDS.details}</summary>
          <div className="pt-1">
            {/* Platform words that may quote a provider (BD-022). */}
            <UntrustedProse value={escalation.brief} />
            {escalation.brief_original_chars === null ? null : (
              <p className="text-sm">(shortened)</p>
            )}
          </div>
        </details>
      )}
    </div>
  );
};
