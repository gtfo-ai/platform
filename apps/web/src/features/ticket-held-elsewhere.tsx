/**
 * **A task whose ticket someone else holds** (S-25.14, product/10's Task detail amendment of
 * 2026-11-07): the needs-you callout's body for the stop `ticket_assigned_elsewhere`. It says whose
 * ticket it is (`./ticket-held-words.ts`) and offers the ways out **in the box**, each only to a
 * reader who may use it:
 *
 * - *Take it* / *Assign…* — the header's **one** owner control (`./task-owner.tsx`), passed in, so
 *   *Take it*'s confirmation (the `take_writes_back` wording) and *Assign…*'s picker (each
 *   candidate's `writes_back`) open once, whichever button opened them. Offered on the read's
 *   `can_take` / `can_assign`, while nobody owns the task — and then **only here**: the header's
 *   owner line draws no button of its own (S-25.15 part B, {@link heldElsewhereOwnerSteps}), so the
 *   page has one *Take it*;
 * - *Link account…* — Settings → Linked accounts, for a reader who may open it (an administrator),
 *   and only when the person is not linked;
 * - *Open in Jira* — the ticket's own page, through `ExternalLink` (`safeHref`);
 * - *Give it back to the agent* — once an owner is set, the existing `resume` command
 *   (`can_resume`): the task re-enters the stage it stopped at. Since TD-031 item 5 (#117) the
 *   claim keeps the ticket for an owner set on the platform even while the tracker still names
 *   somebody else, so it is offered whatever `unlinked_assignee` says; the box says what the
 *   tracker shows while that is still somebody else (`heldElsewhereOwnedWords`). It is this page's
 *   word for product/10's *Hand back*; the take-over's hand-back is a different command that needs
 *   a take-over in force;
 * - *Cancel task…* — the existing cancel confirmation (`can_cancel`).
 *
 * **One amber primary** (`./page-primary.ts`, the page's one decision, passed in as `primary`):
 * *Take it*, when the reader may take it and nothing else on the page is the primary; otherwise
 * none — the header's *Resume* gives way to it, because resuming before somebody owns the task
 * only stops it again. The escalation's brief is kept under a collapsed *Details*, as for every
 * structured stop (the review of #111).
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import type { useTaskCommands } from '../app/queries.js';
import { buttonClassName } from '../ui/button.js';
import { Button } from '../ui/kit.js';
import { ExternalLink, UntrustedProse } from '../ui/untrusted.js';
import { OWNER_WORDS, trackerName } from '../ui/words/owners.js';
import type { TaskPrimaryAction } from './page-primary.js';
import { isOrgSectionFor } from './settings-sections.js';
import type { TaskDialog } from './task-dialogs.js';
import type { OwnerAction, OwnerControl } from './task-owner.js';
import { ownerName } from './task-owner.js';
import {
  HELD_ELSEWHERE_WORDS,
  heldElsewhereOwnedWords,
  heldElsewhereStop,
  heldElsewhereWords,
  ticketHolder,
} from './ticket-held-words.js';
import { WaitingWords } from './waiting-words.js';

const STEP = buttonClassName('default', 'sm');

/** The owner actions the box offers; *Unassign* would not move the task. */
const BOX_ACTIONS: readonly OwnerAction[] = ['take', 'assign'];

/**
 * The owner buttons the box draws for this reader (S-25.15 part B): *Take it* / *Assign…* while
 * nobody owns a task stopped because its ticket is somebody else's. Non-empty, the header's owner
 * line draws neither (nor *Link account…*, which the box offers too) — one *Take it* per page —
 * and its `···` menu keeps every owner item.
 */
export const heldElsewhereOwnerSteps = (
  detail: TaskDetailResponse,
  offers: readonly OwnerAction[],
): readonly OwnerAction[] =>
  heldElsewhereStop(detail) && (detail.task.owner ?? null) === null
    ? offers.filter((action) => BOX_ACTIONS.includes(action))
    : [];

export const HeldElsewhere = ({
  detail,
  owner,
  commands,
  onOpen,
  primary,
}: {
  readonly detail: TaskDetailResponse;
  /** The header's owner control; without it no owner action is offered. */
  readonly owner: OwnerControl | undefined;
  /** The page's one primary (`taskPagePrimary`): `take` draws *Take it* amber. */
  readonly primary: TaskPrimaryAction;
  readonly commands: ReturnType<typeof useTaskCommands>;
  readonly onOpen: (dialog: TaskDialog) => void;
}): ReactElement => {
  const { task, escalation } = detail;
  const tracker = trackerName(task.ticket.provider);
  const holder = ticketHolder(task);
  const words = heldElsewhereWords(task.ticket.key, tracker, holder);
  const taskOwner = task.owner ?? null;
  const owned = taskOwner !== null;
  const afterOwner =
    taskOwner === null
      ? null
      : heldElsewhereOwnedWords({
          tracker,
          ownerName: ownerName(taskOwner),
          holder,
          unlinkedAssignee: (task.unlinked_assignee ?? null) !== null,
          ownerWritesBack: task.owner_writes_back,
        });
  const offers = heldElsewhereOwnerSteps(detail, owner?.offers ?? []);
  const takeLeads = owner !== undefined && primary === 'take';
  const mayLink = holder.unlinked && isOrgSectionFor('identities', owner?.viewer?.role);
  // TD-031 item 5: the claim keeps the ticket for the owner, so an owner is all it takes.
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
      {afterOwner === null ? null : (
        <p data-held-owned={afterOwner.kind}>
          <WaitingWords parts={afterOwner.words} />
        </p>
      )}
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
