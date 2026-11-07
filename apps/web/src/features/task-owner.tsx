/**
 * **The task's owner on its page** (S-26.8b, the M26 UX spec § 2): who owns it, and the one
 * secondary control that changes it.
 *
 * - **The line**, beside the ticket's links in the header: the owner's avatar (initials) and
 *   *Owner: Vojtěch*, *(you)* when it is the reader; *Unassigned* in muted text, which is not a
 *   warning; or, for a tracker assignee the platform cannot link to a member of the project (S-26.1's
 *   `unlinked_assignee`), *Assigned in Jira to Jan Novák (not linked to a platform account)* — the
 *   name is provider text (BD-022) and goes through `UntrustedText`. *Link account…* opens Settings →
 *   Linked accounts for a reader who may open it (an administrator; the screen's `minRole`, so a
 *   maintainer below that is not offered a link that would redirect — self-service linking is
 *   S-26.8a's).
 * - **The actions** are *Take it*, *Assign…* and *Unassign*, each offered only when the read's
 *   `can_take` / `can_assign` / `can_unassign` says so — the domain's `ownerCapabilities`, the
 *   matrix the route decides with — so a member sees *Take it* on an unassigned task and *Unassign*
 *   on their own, and a maintainer all three on anybody's. The first of *Take it* and *Unassign*
 *   that applies is a secondary button by the line, with *Assign…* beside it; every one is in the
 *   header's `···` menu ({@link OwnerMenuItems}). None is ever the page's amber primary: that stays
 *   the callout's (TD-033).
 * - *Assign…* opens the person picker (`AssignDialog` in `./task-owner-dialogs.tsx`, a lazy chunk)
 *   over `GET /api/projects/:id/owner-candidates?task_id=`, exactly the people the command accepts;
 *   the tracker is mentioned per candidate (`writes_back`), and the toast is *Assigned to Petra.
 *   Their machine picks it up at the next stage.*
 * - **Taking a task somebody else owns asks first**, naming them: *Take DEMO-1 from Vojtěch? Their
 *   machine stops getting it.*, confirmed by *Take it from Vojtěch*; when *Take it* by this reader
 *   writes the assignment back to the tracker (`take_writes_back`, per caller — not
 *   `owner_writes_back`, which is about the current owner) it adds *also assigns DEMO-1 in Jira*
 *   (*, replacing Vojtěch* or *Jan Novák* — whoever the read's `tracker_assignee` says the tracker
 *   shows, when that is not the reader), and says nothing of the tracker otherwise. **Taking a task
 *   nobody owns that the tracker assigns to somebody else** (unlinked, or a linked person who gave
 *   it back) asks only when the take writes back — *Take DEMO-2? This also assigns DEMO-2 in
 *   Jira to you, replacing Jan Novák.*, *Take it and assign in Jira* — and is taken at once when it
 *   does not ({@link takeConfirmFor}). The dialog is a lazy chunk, fetched the first time it opens.
 * - **Unassign never writes to the tracker** (TD-031's amendment item 4): its words never claim a
 *   tracker change, and where assignments are written back they say the ticket stays assigned
 *   there.
 * - **What follows is said once it is done**, in a polite status line: *Assigned to you. Your
 *   machine picks it up at the next stage.* A refusal (`403 owner_change_not_permitted`,
 *   `409 task_finished`, `422 owner_not_project_member`) is said in words (`api/read-error.ts`).
 *
 * Every word on this module's own surface is `ui/words/owners.ts`' `OWNER_WORDS`; the picker's are
 * `./owner-assign-words.ts`, in the lazy chunk.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { lazy, type ReactElement, Suspense, useState } from 'react';
import { useSession, useTaskOwnerCommand } from '../app/queries.js';
import { ActionMenuItem } from '../ui/action-menu.js';
import { Avatar } from '../ui/avatar.js';
import { Button, ErrorNotice } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { OWNER_WORDS, trackerName } from '../ui/words/owners.js';
import { isOrgSectionFor } from './settings-sections.js';
import type { TakeConfirm } from './task-owner-dialogs.js';
import { showsSomeoneElse, trackerShowsFor } from './tracker-shows.js';

/** A task's owner as the read publishes it. */
export type TaskOwnerView = NonNullable<TaskRecord['owner']>;

const loadDialogs = () => import('./task-owner-dialogs.js');
const TakeConfirmDialog = lazy(async () => ({
  default: (await loadDialogs()).TakeConfirmDialog,
}));
const AssignDialog = lazy(async () => ({
  default: (await loadDialogs()).AssignDialog,
}));

/** An owner action the page may offer. */
export type OwnerAction = 'take' | 'assign' | 'unassign';

const ACTION_LABEL: Readonly<Record<OwnerAction, string>> = {
  take: OWNER_WORDS['owner.action.take'],
  assign: OWNER_WORDS['owner.action.assign'],
  unassign: OWNER_WORDS['owner.action.unassign'],
};

/**
 * The owner actions the read offers this caller, in the order the one button picks from: the
 * server's own flags, nothing derived — a flag that is absent (an older server) offers nothing.
 */
export const ownerOffers = (
  detail: Partial<Pick<TaskDetailResponse, 'can_take' | 'can_assign' | 'can_unassign'>>,
): readonly OwnerAction[] => [
  ...(detail.can_take === true ? (['take'] as const) : []),
  ...(detail.can_assign === true ? (['assign'] as const) : []),
  ...(detail.can_unassign === true ? (['unassign'] as const) : []),
];

/** The owner's name as the page says it; an account with no name is said so, never blank. */
export const ownerName = (owner: TaskOwnerView): string =>
  owner.name.trim() === '' ? OWNER_WORDS['owner.nameless'] : owner.name;

/**
 * What *Take it* must confirm, or `null` to take it at once:
 *
 * - somebody **other than the reader** owns the task — confirmed against their name, with whom
 *   the tracker shows when that is not the reader (`tracker_assignee`: the owner, or anybody
 *   else), which the dialog says only when the take writes back;
 * - nobody owns it, the tracker shows somebody **other than the reader** — a person the platform
 *   cannot link, or a linked one who gave the task back (Vojtěch, written back, then unassigned:
 *   the ticket still shows him) — **and** *Take it* by this reader writes the assignment back
 *   (`take_writes_back`, S-26.3, the read's per-caller answer): taking it replaces them in the
 *   tracker, so it asks; when it does not, taking it changes nothing there and asks nothing;
 * - otherwise (nobody owns it and the tracker shows nobody else, or the reader owns it) — at once.
 */
export const takeConfirmFor = (
  task: Pick<TaskRecord, 'owner' | 'unlinked_assignee' | 'tracker_assignee'>,
  viewerId: string | null,
  takeWritesBack: boolean,
): TakeConfirm | null => {
  const owner = task.owner ?? null;
  const shows = trackerShowsFor(task);
  const replaced = showsSomeoneElse(shows, viewerId) ? shows : null;
  if (owner !== null) {
    return owner.user_id === viewerId
      ? null
      : { kind: 'owner', ownerName: ownerName(owner), replacing: replaced };
  }
  return replaced !== null && takeWritesBack ? { kind: 'held', assignee: replaced.name } : null;
};

/** The page's owner control: what is offered, what was done, and the confirmation's state. */
export const useOwnerControl = (detail: TaskDetailResponse) => {
  const session = useSession();
  const viewer = session.data?.user ?? null;
  const command = useTaskOwnerCommand(detail.task.id, detail.task.project_id);
  const [confirming, setConfirming] = useState(false);
  // The confirmation is a lazy chunk, mounted on first use and kept.
  const [loaded, setLoaded] = useState(false);
  // The picker likewise: its chunk and its candidates read only once somebody opens it.
  const [assigning, setAssigning] = useState(false);
  const [pickerLoaded, setPickerLoaded] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // No session read yet: nobody to take it for, so nothing is offered.
  const offers = viewer === null ? [] : ownerOffers(detail);
  const takeConfirm = takeConfirmFor(
    detail.task,
    viewer?.id ?? null,
    detail.take_writes_back === true,
  );

  const send = (userId: string | null, words: string): void => {
    setDone(null);
    command.mutate(userId, {
      onSuccess: () => {
        setDone(words);
        setConfirming(false);
        setAssigning(false);
      },
    });
  };
  const take = (): void => {
    if (viewer !== null) {
      send(viewer.id, OWNER_WORDS['owner.took']);
    }
  };
  /** The picker's choice: the reader picking themself is told what *Take it* would say. */
  const assign = (userId: string, name: string): void => {
    send(
      userId,
      userId === viewer?.id ? OWNER_WORDS['owner.took'] : OWNER_WORDS['owner.assigned'](name),
    );
  };
  const run = (action: OwnerAction): void => {
    if (action === 'unassign') {
      // Unassigning never writes to the tracker: where assignments are written back, the ticket
      // keeps its assignee there, and the words say so rather than claim a change.
      send(
        null,
        OWNER_WORDS['owner.unassigned_done'](
          detail.task.owner_writes_back === true ? trackerName(detail.task.ticket.provider) : null,
        ),
      );
    } else if (action === 'assign') {
      command.reset();
      setPickerLoaded(true);
      setAssigning(true);
    } else if (takeConfirm !== null) {
      command.reset();
      setLoaded(true);
      setConfirming(true);
    } else {
      take();
    }
  };
  return {
    viewer,
    offers,
    takeConfirm,
    run,
    take,
    assign,
    confirming,
    setConfirming,
    loaded,
    assigning,
    setAssigning,
    pickerLoaded,
    done,
    command,
  };
};

export type OwnerControl = ReturnType<typeof useOwnerControl>;

/** The header's owner line and its one secondary button. */
export const OwnerLine = ({
  detail,
  control,
}: {
  readonly detail: TaskDetailResponse;
  readonly control: OwnerControl;
}): ReactElement => {
  const { task } = detail;
  const owner = task.owner ?? null;
  const unlinked = task.unlinked_assignee ?? null;
  const tracker = trackerName(task.ticket.provider);
  const words = OWNER_WORDS['owner.assigned_in_tracker_unlinked'];
  // The first of *Take it* and *Unassign* that applies, with *Assign…* beside it.
  const first = control.offers.find((action) => action !== 'assign');
  const offersAssign = control.offers.includes('assign');
  const canLink = isOrgSectionFor('identities', control.viewer?.role);
  return (
    <span
      data-task-owner={owner !== null ? 'owned' : unlinked !== null ? 'unlinked' : 'unassigned'}
      className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      {owner !== null ? (
        <>
          <Avatar name={sanitiseUntrusted(ownerName(owner))} size={20} decorative />
          <span>
            <UntrustedText value={OWNER_WORDS['owner.label'](ownerName(owner))} />
            {owner.user_id === control.viewer?.id ? OWNER_WORDS['owner.you'] : null}
          </span>
        </>
      ) : unlinked !== null ? (
        <>
          <span>
            {words.before(tracker)}
            {unlinked.display_name === null ? (
              words.nameless
            ) : (
              <UntrustedText value={unlinked.display_name} className="font-semibold text-fg" />
            )}
            {words.after}
          </span>
          {canLink ? (
            <Link
              to="/settings/$section"
              params={{ section: 'identities' }}
              className="text-link underline"
            >
              {OWNER_WORDS['owner.action.link']}
            </Link>
          ) : null}
        </>
      ) : (
        <span className="text-fg-muted">{OWNER_WORDS['owner.unassigned']}</span>
      )}
      {first === undefined ? null : (
        <Button
          size="sm"
          data-owner-action={first}
          disabled={control.command.isPending}
          onClick={() => {
            control.run(first);
          }}
        >
          {ACTION_LABEL[first]}
        </Button>
      )}
      {offersAssign ? (
        <Button
          size="sm"
          data-owner-action="assign"
          disabled={control.command.isPending}
          onClick={() => {
            control.run('assign');
          }}
        >
          {ACTION_LABEL.assign}
        </Button>
      ) : null}
    </span>
  );
};

/**
 * What the last owner change did, or why it was refused — under the header's meta line — the
 * confirmation *Take it* opens on somebody else's task, and *Assign…*'s picker. A refusal while
 * either is open stays in it, beside its button.
 */
export const OwnerFeedback = ({
  detail,
  control,
}: {
  readonly detail: TaskDetailResponse;
  readonly control: OwnerControl;
}): ReactElement => {
  const { task } = detail;
  return (
    <>
      {control.done === null ? null : (
        <p role="status" data-owner-done="" className="text-sm text-fg-muted">
          <UntrustedText value={control.done} />
        </p>
      )}
      {control.command.isError && !control.confirming && !control.assigning ? (
        <ErrorNotice title={OWNER_WORDS['owner.refused']} error={control.command.error} />
      ) : null}
      {!control.loaded || control.takeConfirm === null ? null : (
        <Suspense fallback={null}>
          <TakeConfirmDialog
            open={control.confirming}
            onOpenChange={control.setConfirming}
            ticketKey={task.ticket.key}
            confirm={control.takeConfirm}
            writesBack={detail.take_writes_back === true}
            tracker={trackerName(task.ticket.provider)}
            pending={control.command.isPending}
            error={control.command.isError ? control.command.error : null}
            onConfirm={control.take}
          />
        </Suspense>
      )}
      {!control.pickerLoaded ? null : (
        <Suspense fallback={null}>
          <AssignDialog
            open={control.assigning}
            onOpenChange={control.setAssigning}
            task={task}
            viewerId={control.viewer?.id ?? null}
            tracker={trackerName(task.ticket.provider)}
            pending={control.command.isPending}
            error={control.assigning && control.command.isError ? control.command.error : null}
            onAssign={control.assign}
          />
        </Suspense>
      )}
    </>
  );
};

/** The same actions as items of the header's `···` menu. */
export const OwnerMenuItems = ({ control }: { readonly control: OwnerControl }): ReactElement => (
  <>
    {control.offers.map((action) => (
      <ActionMenuItem
        key={action}
        disabled={control.command.isPending}
        onSelect={() => {
          control.run(action);
        }}
      >
        {ACTION_LABEL[action]}
      </ActionMenuItem>
    ))}
  </>
);
