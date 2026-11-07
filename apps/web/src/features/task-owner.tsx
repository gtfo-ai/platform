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
 * - **The actions** are *Take it* and *Unassign*, each offered only when the read's `can_take` /
 *   `can_unassign` says so — the domain's `ownerCapabilities`, the matrix the route decides with —
 *   so a member sees *Take it* on an unassigned task and *Unassign* on their own, and a maintainer
 *   both on anybody's. The first that applies is the **one secondary button** by the line; every
 *   one is in the header's `···` menu ({@link OwnerMenuItems}). Neither is ever the page's amber
 *   primary: that stays the callout's (TD-033).
 * - *Assign…* (a person picker, maintainers) is built — `OwnerPicker` in `./task-owner-dialogs.tsx`,
 *   which takes its candidates as a prop — and **not offered yet**: the only read of people,
 *   `GET /api/org/users`, includes non-members and disabled users, which the command refuses, and the
 *   read of exactly the people it accepts is not served yet (BACKLOG 1297 wires it).
 * - **Taking a task somebody else owns asks first**, naming them: *Take DEMO-1 from Vojtěch? Their
 *   machine stops getting it.*, confirmed by *Take it from Vojtěch*; when the project writes the
 *   assignment back to the tracker (`owner_writes_back`) it adds *also assigns DEMO-1 in Jira*, and
 *   says nothing of the tracker otherwise. The dialog is a lazy chunk, fetched the first time it
 *   opens.
 * - **What follows is said once it is done**, in a polite status line: *Assigned to you. Your
 *   machine picks it up at the next stage.* A refusal (`403 owner_change_not_permitted`,
 *   `409 task_finished`, `422 owner_not_project_member`) is said in words (`api/read-error.ts`).
 *
 * Every word is `ui/humanize.ts`' `OWNER_WORDS`.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { lazy, type ReactElement, Suspense, useState } from 'react';
import { useSession, useTaskOwnerCommand } from '../app/queries.js';
import { ActionMenuItem } from '../ui/action-menu.js';
import { Avatar } from '../ui/avatar.js';
import { OWNER_WORDS, trackerName } from '../ui/humanize.js';
import { Button, ErrorNotice } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { isOrgSectionFor } from './settings-sections.js';

/** A task's owner as the read publishes it. */
export type TaskOwnerView = NonNullable<TaskRecord['owner']>;

const loadDialogs = () => import('./task-owner-dialogs.js');
const TakeFromDialog = lazy(async () => ({ default: (await loadDialogs()).TakeFromDialog }));

/** An owner action the page may offer. *Assign…* joins when its read is served (BACKLOG 1297). */
export type OwnerAction = 'take' | 'unassign';

const ACTION_LABEL: Readonly<Record<OwnerAction, string>> = {
  take: OWNER_WORDS['owner.action.take'],
  unassign: OWNER_WORDS['owner.action.unassign'],
};

/**
 * The owner actions the read offers this caller, in the order the one button picks from: the
 * server's own flags, nothing derived — a flag that is absent (an older server) offers nothing.
 */
export const ownerOffers = (
  detail: Pick<TaskDetailResponse, 'can_take' | 'can_unassign'>,
): readonly OwnerAction[] => [
  ...(detail.can_take === true ? (['take'] as const) : []),
  ...(detail.can_unassign === true ? (['unassign'] as const) : []),
];

/** The owner's name as the page says it; an account with no name is said so, never blank. */
export const ownerName = (owner: TaskOwnerView): string =>
  owner.name.trim() === '' ? OWNER_WORDS['owner.nameless'] : owner.name;

/**
 * The name *Take it* must confirm against: the owner's, when somebody **other than the reader**
 * owns the task. `null` — no owner, or the reader — takes it at once.
 */
export const takeFromWhom = (
  owner: TaskOwnerView | null | undefined,
  viewerId: string | null,
): string | null =>
  owner === null || owner === undefined || owner.user_id === viewerId ? null : ownerName(owner);

/** The page's owner control: what is offered, what was done, and the confirmation's state. */
export const useOwnerControl = (detail: TaskDetailResponse) => {
  const session = useSession();
  const viewer = session.data?.user ?? null;
  const command = useTaskOwnerCommand(detail.task.id, detail.task.project_id);
  const [confirming, setConfirming] = useState(false);
  // The confirmation is a lazy chunk, mounted on first use and kept.
  const [loaded, setLoaded] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // No session read yet: nobody to take it for, so nothing is offered.
  const offers = viewer === null ? [] : ownerOffers(detail);
  const takeFrom = takeFromWhom(detail.task.owner, viewer?.id ?? null);

  const send = (userId: string | null, words: string): void => {
    setDone(null);
    command.mutate(userId, {
      onSuccess: () => {
        setDone(words);
        setConfirming(false);
      },
    });
  };
  const take = (): void => {
    if (viewer !== null) {
      send(viewer.id, OWNER_WORDS['owner.took']);
    }
  };
  const run = (action: OwnerAction): void => {
    if (action === 'unassign') {
      send(null, OWNER_WORDS['owner.unassigned_done']);
    } else if (takeFrom !== null) {
      command.reset();
      setLoaded(true);
      setConfirming(true);
    } else {
      take();
    }
  };
  return { viewer, offers, takeFrom, run, take, confirming, setConfirming, loaded, done, command };
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
  const [first] = control.offers;
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
    </span>
  );
};

/**
 * What the last owner change did, or why it was refused — under the header's meta line — and the
 * confirmation *Take it* opens on somebody else's task. A refusal while the confirmation is open
 * stays in it, beside its button.
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
          {control.done}
        </p>
      )}
      {control.command.isError && !control.confirming ? (
        <ErrorNotice title="The owner was not changed." error={control.command.error} />
      ) : null}
      {!control.loaded || control.takeFrom === null ? null : (
        <Suspense fallback={null}>
          <TakeFromDialog
            open={control.confirming}
            onOpenChange={control.setConfirming}
            ticketKey={task.ticket.key}
            ownerName={control.takeFrom}
            writesBack={task.owner_writes_back === true}
            tracker={trackerName(task.ticket.provider)}
            pending={control.command.isPending}
            error={control.command.isError ? control.command.error : null}
            onConfirm={control.take}
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
