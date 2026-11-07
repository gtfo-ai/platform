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
 * - {@link OwnerPicker}: *Assign…*, a person picker over the candidates it is **given** — the
 *   people the owner command accepts. No read of exactly those people is served yet (the org's
 *   user list includes non-members and disabled users), so nothing renders it: BACKLOG 1297 wires
 *   it to `GET /api/projects/:id/owner-candidates` when that lands.
 *
 * A ticket key and a person's name are text somebody else wrote: a dialog's title is a string, so
 * both are passed through `sanitiseUntrusted` (the bidi overrides and control characters, as the
 * board's *Cancel ACME-1?* does), and the picker's options are text nodes.
 */
import { type ReactElement, useId, useState } from 'react';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { Dialog } from '../ui/dialog.js';
import { OWNER_WORDS } from '../ui/humanize.js';
import { ErrorNotice } from '../ui/kit.js';
import { Select } from '../ui/select.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';

/**
 * What *Take it* must confirm (`takeConfirmFor` in `./task-owner.tsx`):
 *
 * - `owner` — somebody else owns the task. `replacing` is the tracker assignee the platform cannot
 *   link, when the tracker shows one with a name, said only when the assignment is written back.
 * - `held` — nobody owns it, the tracker assigns it to a person the platform cannot link, and the
 *   project writes the assignment back: taking it reassigns the ticket there (S-26.3).
 */
export type TakeConfirm =
  | { readonly kind: 'owner'; readonly ownerName: string; readonly replacing: string | null }
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
  /** `owner_writes_back`: the assignment is also written to the tracker. */
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
                    <UntrustedText value={confirm.replacing} />
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

/** A person the owner command accepts for this task. */
export interface OwnerCandidate {
  readonly user_id: string;
  readonly name: string;
}

/**
 * The person picker of *Assign…*. The current owner is listed, marked, and not choosable (choosing
 * them changes nothing); *Assign* stays disabled until somebody else is chosen.
 */
export const OwnerPicker = ({
  open,
  onOpenChange,
  ticketKey,
  candidates,
  currentOwnerId,
  pending,
  error,
  onAssign,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly ticketKey: string;
  readonly candidates: readonly OwnerCandidate[];
  readonly currentOwnerId: string | null;
  readonly pending: boolean;
  readonly error: unknown;
  /** The chosen person's id, and their name for the status line. */
  readonly onAssign: (userId: string, name: string) => void;
}): ReactElement => {
  const words = OWNER_WORDS['owner.picker'];
  const fieldId = useId();
  const [chosen, setChosen] = useState('');
  const choosable = candidates.filter((candidate) => candidate.user_id !== currentOwnerId);
  const picked = choosable.find((candidate) => candidate.user_id === chosen) ?? null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setChosen('');
        }
        onOpenChange(next);
      }}
      title={words.title(sanitiseUntrusted(ticketKey))}
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
                onAssign(picked.user_id, picked.name);
              }
            }}
          >
            {words.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {choosable.length === 0 ? (
          <p data-owner-picker-empty="" className="text-sm text-fg-muted">
            {words.empty}
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
              {candidates.map((candidate) => (
                <option
                  key={candidate.user_id}
                  value={candidate.user_id}
                  disabled={candidate.user_id === currentOwnerId}
                >
                  {`${sanitiseUntrusted(candidate.name)}${
                    candidate.user_id === currentOwnerId ? words.current : ''
                  }`}
                </option>
              ))}
            </Select>
          </div>
        )}
        {error === undefined || error === null ? null : (
          <ErrorNotice title={OWNER_WORDS['owner.refused']} error={error} />
        )}
      </div>
    </Dialog>
  );
};
