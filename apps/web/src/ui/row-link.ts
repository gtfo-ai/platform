/**
 * Whole-row click targets (S-23.26): GitHub's stretched link, as two names.
 *
 * - {@link ROW_LINK_HOST} goes on the row — a `<li>`, a card, anything that is one item. `ListRow`
 *   carries it already, so a `ListRow` only needs the second half.
 * - {@link rowLink} is spread onto the row's **one** primary control: usually the title's router
 *   `<Link>`; the row's call-to-action link when the title is text (a *Needs you* row's *Answer*,
 *   which opens the task); a title `<button>` when the row's default is to open something on the
 *   page (the Agents list's run dialog, the inbox question's answer form). Its `::after` covers the
 *   row, and every other control in the row — and every element with a native `title=`, so a
 *   count's or a cost's tooltip still shows — is lifted above it by the stylesheet
 *   (`styles.css`, "Whole-row click targets"), so a menu, a copy button or an *Approve* keeps its
 *   own click.
 *
 * The rules the primitive is written to:
 *
 * - **No handler on the row.** The row stays one real link, so the keyboard's tab order, a
 *   middle-click or ⌘/Ctrl-click into a new tab, the context menu's *Copy link* and a screen
 *   reader's list of links are the browser's, not a re-implementation. The cost — a drag across the
 *   row selects nothing, because it starts on the link — is GitHub's too, and accepted.
 * - **A row click never performs a mutation.** The stretched control navigates or opens
 *   something; a row whose only control is a command (*Take this one*, *Re-queue*, *Approve* with
 *   no page behind it) gets no row link and no hover, because it has no destination.
 * - **Nothing positioned between the control and the row**: the `::after` is sized to its nearest
 *   positioned ancestor, which must be the row. Don't put `relative` on a wrapper inside a row, nor a
 *   `title=` (which the lift makes positioned) on an element that contains the row link.
 * - **One per row.** A second stretched control covers the first.
 *
 * A row with a row link gets the hover background and, when its control has keyboard focus, the
 * focus ring round the whole row (`--focus-ring`); the control's own `FOCUS_RING` is not needed.
 * A rounded row (a board card) sets `--row-link-radius` so the ring follows its corners.
 */
import { cx } from './cx.js';

/** The class that makes an element the row a row link covers. */
export const ROW_LINK_HOST = 'row-link-host';

/** The attribute that marks a row's one stretched control (the stylesheet's and `j`/`k`'s). */
export const ROW_LINK_ATTRIBUTE = 'data-row-link' as const;

/**
 * The class that lifts a non-control above the row link: a block of text in the row that should
 * stay selectable and not open the row (a ticket's free-text notes). Controls and anything with a
 * native `title=` are lifted without it.
 */
export const ROW_LINK_LIFT = 'row-link-lift';

/** Props for the row's primary control: the marker and its classes (`className` is the caller's). */
export const rowLink = (
  className?: string,
): { readonly 'data-row-link': ''; readonly className: string } => ({
  'data-row-link': '',
  className: cx(className),
});
