/**
 * The words a screen prints beside a task's measured total, in one place (WP-134, PROGRESS backlog
 * 408).
 *
 * `TaskRecord.cost_actual_usd` adds only the runs that have a figure: a run that ended with nobody
 * measuring it adds nothing (WP-131, rule 16). The task page has said so since WP-131; the board card
 * printed the same total under the title *"Provider-reported cost"* and no count, which was wrong
 * twice — the total leaves runs out, and in `local` provider mode it is priced rather than reported.
 * Both screens now read their sentence from here, so they cannot drift apart. Platform text only:
 * nothing here is provider text, so it is a plain string rather than an `UntrustedText`.
 */

/**
 * *"Excludes 1 run nobody measured."* — what `cost_actual_usd` leaves out (WP-131, backlog 403).
 * The words are the notification's, so the three places say the same thing.
 */
export const unmeasuredRunsText = (count: number): string =>
  `Excludes ${count} ${count === 1 ? 'run' : 'runs'} nobody measured.`;

/** The board card's short form of {@link unmeasuredRunsText}: a card has one line for it. */
export const unmeasuredRunsShortText = (count: number): string => `excl. ${count} unmeasured`;

/**
 * The board card's tooltip on the total: what the figure is, in both provider modes (BD-011), and
 * that it leaves out a run nobody measured — said whether or not this task has one, because the
 * count beside it is what says how many.
 */
export const BOARD_COST_TITLE =
  'Measured cost so far for this task: reported by the provider, or priced from the price list in local provider mode (BD-011). A run that ended without a figure is left out, and counted beside the total when there is one.';
