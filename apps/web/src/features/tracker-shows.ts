/**
 * **Who the tracker shows as the ticket's assignee**, as the task read says (S-26.8b's follow-up,
 * the review of PR #103): `tracker_assignee`, the stored assignee the server publishes with the
 * user it resolves to live — never the platform's own account. A tiny module of its own because
 * both *Take it*'s confirmation (`./task-owner.tsx`, initial) and *Assign…*'s picker
 * (`./task-owner-dialogs.tsx`, lazy) read it.
 *
 * It is a record of what the tracker showed, never a guess from `owner_writes_back` (a predicate
 * over the current owner, not a write that landed): after Vojtěch, written back, unassigns, the
 * task has no owner and the tracker still shows him, and this says so.
 */
import type { TaskRecord } from '@platform/contracts';

/**
 * The tracker's assignee: `name` is provider text (or `null` when it sent none), `userId` the
 * platform user it is, or `null` for somebody else. `null` when the tracker shows nobody, or only
 * the platform.
 */
export type TrackerShows = { readonly name: string | null; readonly userId: string | null } | null;

export const trackerShowsFor = (
  task: Pick<TaskRecord, 'tracker_assignee' | 'unlinked_assignee'>,
): TrackerShows => {
  if (task.tracker_assignee !== undefined) {
    const shown = task.tracker_assignee;
    return shown === null ? null : { name: shown.display_name, userId: shown.user_id };
  }
  // An older server that sends no `tracker_assignee`: only the person it cannot link is known.
  const unlinked = task.unlinked_assignee ?? null;
  return unlinked === null ? null : { name: unlinked.display_name, userId: null };
};

/** Whether the tracker shows somebody other than `userId` — whom a write-back would replace. */
export const showsSomeoneElse = (shows: TrackerShows, userId: string | null): boolean =>
  shows !== null && (shows.userId === null || shows.userId !== userId);
