/**
 * **An approval's words that only the Inbox shows** (S-27.1).
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */

/**
 * What an approval's Inbox row says where a question's says when it is due — *requested 3 h ago ·
 * waits for a maintainer* (BD-006's 2026-11-07 amendment, S-27.1): an approval never expires, so it
 * has no due time to show, and only a maintainer decides one (BD-006, Q10).
 */
export const APPROVAL_WAIT_WORDS = 'waits for a maintainer';
