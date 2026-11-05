/**
 * **The primary-button census** (S-23.23, the UX audit's § 2; research/19 rule 1: one beacon per
 * view). A screen's beacon is anything drawn with the primary tone — a `Button tone="primary"` or a
 * link given `buttonClassName('primary')` — and both carry the tone's own border class, which
 * nothing else in the application draws (`ui/button.tsx`). So the census counts that class.
 *
 * A dialog is not part of the screen beneath it: it has its own one primary, and it is outside
 * `main` in a portal anyway. Everything else in the document is counted — the frame's banner
 * included, because a banner above every screen is a second beacon on every screen.
 *
 * The screen tests assert with it (`expectOnePrimaryAtMost` or the exact list); its own test plants
 * two and watches it fire. What it cannot see, stated: a primary drawn by a class built at run time
 * that does not include the marker, and a screen state no test renders.
 */

/** The primary tone's border class — `TONES.primary` in `ui/button.tsx`. */
export const PRIMARY_MARKER = 'border-primary-line';

/** Every beacon in `root`, outside any dialog, in document order. */
export const primaryActions = (root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(`[class~="${PRIMARY_MARKER}"]`)].filter(
    (element) => element.closest('[role="dialog"]') === null,
  );

/** Their visible labels, for an assertion that names which beacon a state shows. */
export const primaryLabels = (root: ParentNode = document): string[] =>
  primaryActions(root).map((element) => (element.textContent ?? '').trim());

/** Throws, naming every beacon, when `root` draws more than one. */
export const assertOnePrimaryAtMost = (root: ParentNode = document, view = 'this view'): void => {
  const labels = primaryLabels(root);
  if (labels.length > 1) {
    throw new Error(
      `${view} draws ${labels.length} primary actions (${labels.map((label) => `"${label}"`).join(', ')}); a view has one at most`,
    );
  }
};
