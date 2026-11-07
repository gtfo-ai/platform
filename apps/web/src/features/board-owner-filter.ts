/**
 * **The board's owner filter, remembered per person** (S-26.8b, the M26 UX spec § 3): *Everyone*
 * (the default) · *Mine* · *Unassigned*, in the URL as `?owner=me|none` — which the server applies
 * (S-26.1's `listTasksQuerySchema.owner`) — and kept in this browser's storage **under the signed-in
 * person's id**, so a second person on the same browser does not inherit the first one's *Mine*.
 *
 * The URL wins when it names a filter (a link somebody sent opens what they saw); a board URL with
 * none opens the filter this person last chose. *Everyone* is remembered by forgetting: choosing it
 * removes the stored value. Storage that throws (a private window, a quota) remembers nothing and
 * the board still works, as the Agents page's view does.
 *
 * Plain data and no React, so it is tested alone.
 */
import type { BoardOwnerFilter } from '../ui/humanize.js';

/** The URL's filter: `me` or `none`; `undefined` is no filter in the URL. */
export type UrlOwnerFilter = Exclude<BoardOwnerFilter, 'all'>;

const isUrlOwnerFilter = (value: unknown): value is UrlOwnerFilter =>
  value === 'me' || value === 'none';

/** The storage key for one person's choice. */
export const ownerFilterStorageKey = (userId: string): string => `agentic.board.owner:${userId}`;

/** The filter this person last chose, or `null` — none stored, no person, or storage refused. */
export const readStoredOwnerFilter = (
  storage: Pick<Storage, 'getItem'> | undefined,
  userId: string | null,
): UrlOwnerFilter | null => {
  if (userId === null) {
    return null;
  }
  try {
    const value = storage?.getItem(ownerFilterStorageKey(userId));
    return isUrlOwnerFilter(value) ? value : null;
  } catch {
    return null;
  }
};

/** Remember `filter` for this person; *Everyone* is the absence of a stored value. */
export const storeOwnerFilter = (
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  userId: string | null,
  filter: BoardOwnerFilter,
): void => {
  if (userId === null) {
    return;
  }
  try {
    if (filter === 'all') {
      storage?.removeItem(ownerFilterStorageKey(userId));
    } else {
      storage?.setItem(ownerFilterStorageKey(userId), filter);
    }
  } catch {
    // Storage refused: the choice is not remembered, the board works.
  }
};

/** The filter in force: the URL's, else this person's stored one, else *Everyone*. */
export const boardOwnerFilter = (
  fromUrl: unknown,
  stored: UrlOwnerFilter | null,
): BoardOwnerFilter => (isUrlOwnerFilter(fromUrl) ? fromUrl : (stored ?? 'all'));

/** The URL search value for a filter: `undefined` for *Everyone*. */
export const ownerSearchValue = (filter: BoardOwnerFilter): UrlOwnerFilter | undefined =>
  filter === 'all' ? undefined : filter;
