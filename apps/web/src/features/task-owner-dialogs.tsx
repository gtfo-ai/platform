/**
 * The owner control's two dialogs (S-26.8b, the M26 UX spec § 2) — a **lazy chunk**, fetched the
 * first time one opens, so neither is in the initial graph (TD-013's budget).
 *
 * - {@link TakeConfirmDialog}: *Take it* when it costs somebody the task. On a task somebody else
 *   owns it names them — *Take DEMO-1 from Vojtěch?* — says what follows (*Their machine stops
 *   getting it.*, and *also assigns DEMO-1 in Jira* only when the project writes the assignment
 *   back, *replacing Jan Novák* when the tracker shows a person the platform cannot link), and its
 *   act reads *Take it from Vojtěch*. On a task nobody owns that the tracker assigns to such a
 *   person, and only when the assignment is written back: *Take DEMO-2? This also assigns DEMO-2 in
 *   Jira to you, replacing Jan Novák.*, *Take it and assign in Jira*. The tracker's assignee is
 *   provider text, rendered through `UntrustedText`. `ConfirmDialog`'s one shape: a refusal stays
 *   in it, beside the button.
 * - {@link AssignDialog}: *Assign…*, the {@link OwnerPicker} over
 *   `GET /api/projects/:id/owner-candidates?task_id=` — exactly the people the owner command
 *   accepts, each with whether assigning them writes to the tracker (`writes_back`, per candidate
 *   for this task). Choosing somebody says what follows before *Assign* is pressed: *Assign DEMO-1
 *   to Petra?*, *Vojtěch’s machine stops getting it.* when somebody owns it now, *This also assigns
 *   DEMO-1 in Jira to Petra, replacing Jan Novák.* only on that candidate's `writes_back`, and
 *   *Jira still shows Jan Novák.* when it is false and the tracker shows somebody else — read off
 *   the task's `tracker_assignee` (`trackerShowsFor`), so a linked person the tracker still shows
 *   after they gave the task back is named too. An empty list says why; a read that fails says so. The words are
 *   `./owner-assign-words.ts`, never `ui/humanize.ts` (it ships on the worker's page).
 *
 * A ticket key and a person's name are text somebody else wrote: a dialog's title is a string, so
 * both are passed through `sanitiseUntrusted` (the bidi overrides and control characters, as the
 * board's *Cancel ACME-1?* does), and the picker's options are text nodes.
 */
import type { TaskRecord } from '@platform/contracts';
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { useOwnerCandidates } from '../app/queries.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { Dialog } from '../ui/dialog.js';
import { ErrorNotice } from '../ui/kit.js';
import { Select } from '../ui/select.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { OWNER_WORDS } from '../ui/words/owners.js';
import { ASSIGN_WORDS } from './owner-assign-words.js';
import { showsSomeoneElse, type TrackerShows, trackerShowsFor } from './tracker-shows.js';

/**
 * What *Take it* must confirm (`takeConfirmFor` in `./task-owner.tsx`):
 *
 * - `owner` — somebody else owns the task. `replacing` is whom the tracker shows when that is not
 *   the reader (`tracker_assignee`: the owner, or anybody else), said only when the take writes
 *   back.
 * - `held` — nobody owns it, the tracker shows somebody other than the reader (unlinked, or a
 *   linked person who gave the task back), and taking it by this reader writes the assignment back
 *   (`take_writes_back`): taking it reassigns the ticket there (S-26.3).
 */
export type TakeConfirm =
  | { readonly kind: 'owner'; readonly ownerName: string; readonly replacing: TrackerShows }
  | { readonly kind: 'held'; readonly assignee: string | null };

export const TakeConfirmDialog = ({
  open,
  onOpenChange,
  ticketKey,
  confirm,
  writesBack,
  tracker,
  pending,
  error,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly ticketKey: string;
  readonly confirm: TakeConfirm;
  /**
   * `take_writes_back` (S-26.3, per caller): *Take it* by **this reader** also assigns the ticket
   * in the tracker. Not `owner_writes_back`, which is about the current owner.
   */
  readonly writesBack: boolean;
  /** The tracker's name (`trackerName`). */
  readonly tracker: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onConfirm: () => void;
}): ReactElement => {
  const key = sanitiseUntrusted(ticketKey);
  const shown =
    confirm.kind === 'owner'
      ? (() => {
          const words = OWNER_WORDS['owner.take_from'];
          const name = sanitiseUntrusted(confirm.ownerName);
          return {
            title: words.title(key, name),
            consequence: (
              <>
                {words.stops}
                {writesBack ? words.also(key, tracker) : null}
                {writesBack && confirm.replacing !== null ? (
                  <>
                    {words.replacing}
                    {confirm.replacing.name === null ? (
                      OWNER_WORDS['owner.take_held'].nameless
                    ) : (
                      <UntrustedText value={confirm.replacing.name} />
                    )}
                  </>
                ) : null}
                {words.end}
              </>
            ),
            act: words.confirm(name),
          };
        })()
      : (() => {
          const words = OWNER_WORDS['owner.take_held'];
          return {
            title: words.title(key),
            consequence: (
              <>
                {words.before(key, tracker)}
                {confirm.assignee === null ? (
                  words.nameless
                ) : (
                  <UntrustedText value={confirm.assignee} />
                )}
                {words.end}
              </>
            ),
            act: words.confirm(tracker),
          };
        })();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={shown.title}
      consequence={shown.consequence}
      confirmLabel={shown.act}
      keepLabel={OWNER_WORDS['owner.take_from'].keep}
      pending={pending}
      error={error}
      errorTitle={OWNER_WORDS['owner.refused']}
      onConfirm={() => {
        onConfirm();
      }}
    />
  );
};

/** A person the owner command accepts for this task, and whether assigning them writes back. */
export interface OwnerCandidate {
  readonly user_id: string;
  readonly name: string;
  /** Assigning this person also assigns the ticket in the tracker (S-26.3); absent reads false. */
  readonly writes_back?: boolean;
}

/** The task's current owner as the picker names them; `you` when it is the reader. */
export interface PickerOwner {
  readonly user_id: string;
  readonly name: string;
  readonly you: boolean;
}

/** A person's name as a sentence says it; an account with no name is said so, never blank. */
const nameOf = (name: string): string =>
  name.trim() === '' ? OWNER_WORDS['owner.nameless'] : name;

/** What choosing `candidate` does, in sentences — names as text, each sentence one node. */
const assignConsequence = (
  ticketKey: string,
  tracker: string,
  candidate: OwnerCandidate,
  owner: PickerOwner | null,
  shows: TrackerShows,
): ReactNode[] => {
  const name = nameOf(candidate.name);
  const sentences: ReactNode[] = [
    <span key="ask">
      {ASSIGN_WORDS.ask.before(ticketKey)}
      <UntrustedText value={name} />
      {ASSIGN_WORDS.ask.end}
    </span>,
  ];
  if (owner !== null) {
    sentences.push(
      owner.you ? (
        <span key="stops">{ASSIGN_WORDS.stops.you}</span>
      ) : (
        <span key="stops">
          <UntrustedText value={nameOf(owner.name)} />
          {ASSIGN_WORDS.stops.after}
        </span>
      ),
    );
  }
  // Whom the tracker shows, unless it already shows the chosen person.
  const replaced = showsSomeoneElse(shows, candidate.user_id) ? shows : null;
  if (candidate.writes_back === true) {
    const also = ASSIGN_WORDS.also;
    sentences.push(
      <span key="tracker" data-assign-tracker="writes">
        {also.before(ticketKey, tracker)}
        <UntrustedText value={name} />
        {replaced === null ? null : (
          <>
            {also.replacing}
            {replaced.name === null ? also.nameless : <UntrustedText value={replaced.name} />}
          </>
        )}
        {also.end}
      </span>,
    );
  } else if (replaced !== null) {
    const untouched = ASSIGN_WORDS.untouched;
    sentences.push(
      <span key="tracker" data-assign-tracker="untouched">
        {untouched.before(tracker)}
        {replaced.name === null ? untouched.nameless : <UntrustedText value={replaced.name} />}
        {untouched.end}
      </span>,
    );
  }
  return sentences.flatMap((sentence, index) => (index === 0 ? [sentence] : [' ', sentence]));
};

/**
 * The person picker of *Assign…*, over the candidates it is given (`null` while they are read).
 * The current owner is listed, marked, and not choosable (choosing them changes nothing); *Assign*
 * stays disabled until somebody else is chosen, and once somebody is, the consequence is said
 * above it. A refusal of the read or of the command is said in the dialog.
 */
export const OwnerPicker = ({
  open,
  onOpenChange,
  ticketKey,
  tracker,
  candidates,
  readError,
  currentOwner,
  trackerShows,
  pending,
  error,
  onAssign,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly ticketKey: string;
  /** The tracker's name (`trackerName`). */
  readonly tracker: string;
  readonly candidates: readonly OwnerCandidate[] | null;
  /** Why the candidates could not be read, or `null`. */
  readonly readError?: unknown;
  readonly currentOwner: PickerOwner | null;
  readonly trackerShows: TrackerShows;
  readonly pending: boolean;
  readonly error: unknown;
  /** The chosen person's id, and their name for the status line. */
  readonly onAssign: (userId: string, name: string) => void;
}): ReactElement => {
  const words = OWNER_WORDS['owner.picker'];
  const fieldId = useId();
  const [chosen, setChosen] = useState('');
  const currentOwnerId = currentOwner?.user_id ?? null;
  const key = sanitiseUntrusted(ticketKey);
  const listed = candidates ?? [];
  const choosable = listed.filter((candidate) => candidate.user_id !== currentOwnerId);
  const picked = choosable.find((candidate) => candidate.user_id === chosen) ?? null;
  const unreadable = readError !== undefined && readError !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setChosen('');
        }
        onOpenChange(next);
      }}
      title={words.title(key)}
      description={words.description}
      footer={
        <>
          <Button
            onClick={() => {
              setChosen('');
              onOpenChange(false);
            }}
          >
            {OWNER_WORDS['owner.take_from'].keep}
          </Button>
          <Button
            tone="primary"
            data-owner-assign=""
            disabled={pending || picked === null}
            onClick={() => {
              if (picked !== null) {
                onAssign(picked.user_id, nameOf(picked.name));
              }
            }}
          >
            {words.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {unreadable ? (
          <ErrorNotice title={ASSIGN_WORDS.unreadable} error={readError} />
        ) : candidates === null ? (
          <p data-owner-picker-loading="" className="text-sm text-fg-muted">
            {ASSIGN_WORDS.loading}
          </p>
        ) : choosable.length === 0 ? (
          <p data-owner-picker-empty="" className="text-sm text-fg-muted">
            {ASSIGN_WORDS.empty}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor={fieldId} className="text-sm font-medium">
              {words.label}
            </label>
            <Select
              id={fieldId}
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            >
              <option value="" disabled>
                —
              </option>
              {listed.map((candidate) => (
                <option
                  key={candidate.user_id}
                  value={candidate.user_id}
                  disabled={candidate.user_id === currentOwnerId}
                >
                  {`${sanitiseUntrusted(nameOf(candidate.name))}${
                    candidate.user_id === currentOwnerId ? words.current : ''
                  }`}
                </option>
              ))}
            </Select>
          </div>
        )}
        {picked === null ? null : (
          <p data-owner-assign-consequence="" className="text-sm">
            {assignConsequence(ticketKey, tracker, picked, currentOwner, trackerShows)}
          </p>
        )}
        {error === undefined || error === null ? null : (
          <ErrorNotice title={OWNER_WORDS['owner.refused']} error={error} />
        )}
      </div>
    </Dialog>
  );
};

/**
 * *Assign…* on the task page: the picker over `GET /api/projects/:id/owner-candidates?task_id=`,
 * read only while it is open (`useOwnerCandidates`). The current owner, the tracker's assignee and
 * the tracker's name come off the task read.
 */
export const AssignDialog = ({
  open,
  onOpenChange,
  task,
  viewerId,
  tracker,
  pending,
  error,
  onAssign,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly task: Pick<
    TaskRecord,
    'id' | 'project_id' | 'ticket' | 'owner' | 'unlinked_assignee' | 'tracker_assignee'
  >;
  readonly viewerId: string | null;
  readonly tracker: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onAssign: (userId: string, name: string) => void;
}): ReactElement => {
  const read = useOwnerCandidates(task.project_id, task.id, open);
  const owner = task.owner ?? null;
  return (
    <OwnerPicker
      open={open}
      onOpenChange={onOpenChange}
      ticketKey={task.ticket.key}
      tracker={tracker}
      candidates={read.data?.items ?? null}
      readError={read.isError ? read.error : null}
      currentOwner={
        owner === null
          ? null
          : { user_id: owner.user_id, name: owner.name, you: owner.user_id === viewerId }
      }
      trackerShows={trackerShowsFor(task)}
      pending={pending}
      error={error}
      onAssign={onAssign}
    />
  );
};
