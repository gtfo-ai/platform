/**
 * Reading the project's digest settings, and the organisation's wall clock (WP-32).
 *
 * The **policy** is `@platform/domain`'s (`policies/notifications.ts`) and takes minutes since
 * local midnight. This is the half that cannot be pure: turning an instant into a wall-clock
 * reading needs a zone, and the zone is the **organisation's** — Q38 settled that working time is
 * an organisational fact seeded from `TZ`, and `features.digest.at` is written as *"09:00 org
 * time"* in product/18:33. A per-project zone was considered and refused: it would be a second zone
 * to keep true, and the digest, the working calendar and the budget windows (BD-010) would then
 * disagree about what "today" means for one project.
 *
 * Nothing here reads the host clock. `zonedParts` is the same explicit-zone arithmetic the working
 * calendar uses, for the reason its docblock gives: `Date#getHours()` silently reads the process
 * zone, so a container migration moves every digest by an hour.
 *
 * ## Q38's open half, answered here
 *
 * Q38 asks *"whether quiet hours (WP-32) should reuse the same window"* as the working calendar.
 * **They do not.** They share the **zone** and nothing else: `working_hours` says when a deadline
 * advances (a question asked at 16:00 on Friday is due Monday), while quiet hours say when a
 * message may interrupt somebody — the two are different questions with different defaults
 * (working hours default to 09:00–17:00 *on*; quiet hours default to **off**), and deriving one
 * from the other would mean an organisation that opens at 09:00 could not be notified before 09:00
 * without also moving every question deadline.
 */
import type { IsoDateTime, NotificationClass } from '@platform/contracts';
import type { ConfigValues, QuietHours } from '@platform/domain';
import { isoDateOf, zonedParts } from '../scheduling/zoned-time.js';

/** product/18:33's defaults, for a project whose configuration says nothing. */
export const DEFAULT_DIGEST_AT = '09:00';

export interface DigestSettings {
  readonly enabled: boolean;
  /** `HH:MM` in the organisation's zone. */
  readonly at: string;
  readonly quietHours: QuietHours | null;
  /**
   * `features.digest.urgent`, **undefined when the project never chose** — which is not the same as
   * an empty list, and the domain policy keeps the two apart (standing rule 16).
   */
  readonly urgent: readonly NotificationClass[] | undefined;
}

/**
 * The project's digest settings out of its effective configuration.
 *
 * `PLATFORM_DEFAULT_CONFIG` fills all four on a composed instance, so the `??`s here are for the
 * caller that passes a bare `{}` — a unit test, or a settings port that has not merged the platform
 * layer. They are the *same* defaults, written where a reader can check them against product/18:33.
 */
export const digestSettingsOf = (config: ConfigValues): DigestSettings => {
  const digest = config.features?.digest;
  return {
    enabled: digest?.enabled ?? true,
    at: digest?.at ?? DEFAULT_DIGEST_AT,
    quietHours: digest?.quiet_hours ?? null,
    urgent: digest?.urgent,
  };
};

/** Minutes since midnight in `timezone`, `0…1439`. */
export const localMinutesOf = (at: IsoDateTime, timezone: string): number => {
  const parts = zonedParts(new Date(at), timezone);
  return parts.hour * 60 + parts.minute;
};

/**
 * The day an instant belongs to, **in the organisation's zone** — the unit the digest's idempotency
 * key is one of.
 *
 * Carried over from the mechanism WP-10 left behind (`providers/slack/digest.ts`, removed by this
 * work package) together with the measurement that earned it: slicing the UTC instant silently
 * skipped a day whenever two consecutive fires landed on the same UTC date, which is exactly what a
 * DST transition does. `0 12 * * *` in `Pacific/Auckland` fires at `2026-09-26T00:00Z` (NZST) and
 * `2026-09-26T23:00Z` (NZDT) — both UTC `2026-09-26`, so the second day's digest was treated as a
 * replay and never posted. Not a southern-hemisphere quirk either: `30 19 * * *` in
 * `America/New_York` does the same across both US transitions.
 */
export const localDayOf = (at: IsoDateTime, timezone: string): string =>
  isoDateOf(zonedParts(new Date(at), timezone));
