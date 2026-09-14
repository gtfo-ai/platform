/**
 * Quiet hours, urgent classes and what a digest is for — product/18:33's policy, as arithmetic
 * (WP-32).
 *
 * > *"Slack notifications batched into a daily digest outside configured hours; urgent classes
 * > (escalation, budget 100%) still immediate"* — product/18:33, defaults *"quiet hours off; digest
 * > on at 09:00 org time"*.
 *
 * Everything here is pure and takes **minutes since local midnight** rather than an instant: the
 * zone arithmetic that turns "now" into a wall-clock reading belongs to the ring that owns the
 * organisation's calendar (`@platform/application`'s `scheduling/zoned-time.ts`, Q38), and a policy
 * that read a `Date` would be one `getHours()` away from the host's zone — standing rule 2's shape
 * for a clock rather than for a stopwatch.
 *
 * ## The three rules, and the one they compose into
 *
 *  1. **An urgent class is always immediate.** Which classes are urgent is *configuration*
 *     ({@link DEFAULT_URGENT_NOTIFICATION_CLASSES} is the default, not the rule).
 *  2. **Deferral needs a carrier.** With the digest off there is nothing to defer *into*, so a
 *     notification is delivered immediately whatever the window says. Holding it back until
 *     somebody switches the digest on would be a message nobody was told was waiting.
 *  3. **Inside the window, everything else waits for the digest.** Outside it, or with no window
 *     configured at all (the shipped default), everything is immediate.
 *
 * Nothing here can answer `'drop'`, and that is the point: quiet hours **defer and never drop**.
 * The two deliveries are the only two values {@link NotificationDelivery} has.
 */
import type { NotificationClass } from '@platform/contracts';

/**
 * product/18:33's *"urgent classes (escalation, budget 100%)"*, as the shipped default.
 *
 * A function would be safer against mutation but every other default in this ring is a frozen
 * `readonly` array (`DEFAULT_LINT_ISSUE_TYPES`), and consistency is worth more here than a defence
 * against a caller that would have to cast to break it.
 */
export const DEFAULT_URGENT_NOTIFICATION_CLASSES: readonly NotificationClass[] = [
  'escalation',
  'budget_exhausted',
];

/** A wall-clock window in the organisation's zone. May wrap midnight. */
export interface QuietHours {
  /** `HH:MM`, inclusive. */
  readonly from: string;
  /** `HH:MM`, exclusive. */
  readonly to: string;
}

/** How a notification reaches a human. There is no third value: nothing is ever dropped. */
export type NotificationDelivery = 'immediate' | 'digest';

export interface NotificationRoutingInput {
  readonly notificationClass: NotificationClass;
  /** `features.digest.enabled`. */
  readonly digestEnabled: boolean;
  /** `features.digest.quiet_hours`, or `null` for "off" — the shipped default. */
  readonly quietHours: QuietHours | null;
  /**
   * `features.digest.urgent`. **Absent and empty are different**: absent means the project never
   * chose, so the platform default applies; an explicitly empty list means *nothing* is urgent
   * (standing rule 16 — the absent case must not be the quiet one).
   */
  readonly urgentClasses: readonly NotificationClass[] | undefined;
  /** Minutes since midnight in the organisation's zone, `0…1439`. */
  readonly localMinutes: number;
}

/** `HH:MM` → minutes since midnight. Refuses anything `timeOfDaySchema` would have refused. */
export const minutesOfTimeOfDay = (value: string): number => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) {
    throw new Error(`expected a 24-hour HH:MM time, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * Is a local wall-clock reading inside the window?
 *
 * `[from, to)` — closed at the start, open at the end, so a window that ends at 08:00 is over at
 * 08:00 rather than at 08:01 and two adjacent windows cannot both claim one minute.
 *
 * **A window whose `to` is not after its `from` wraps midnight**: `22:00`–`08:00` is a night. That
 * is the case worth stating, because the obvious implementation (`from <= m && m < to`) makes a
 * night window match *nothing* — which is a quiet window that is silently never quiet, the failure
 * an operator would never notice because its symptom is the bot behaving exactly as before.
 *
 * `from === to` is an **empty** window rather than a whole day: `[x, x)` is empty by the same
 * reading that makes the boundaries work, and "quiet all day" is spelled by switching the digest
 * on and the notifications off rather than by a degenerate interval. Asserted both ways.
 */
export const inQuietWindow = (localMinutes: number, window: QuietHours): boolean => {
  const from = minutesOfTimeOfDay(window.from);
  const to = minutesOfTimeOfDay(window.to);
  if (from === to) {
    return false;
  }
  return from < to
    ? localMinutes >= from && localMinutes < to
    : localMinutes >= from || localMinutes < to;
};

/** Which classes this project treats as urgent — the configured set, or the platform's. */
export const urgentClassesOf = (
  configured: readonly NotificationClass[] | undefined,
): readonly NotificationClass[] => configured ?? DEFAULT_URGENT_NOTIFICATION_CLASSES;

/** product/18:33's *"urgent classes … still immediate"*, asked of one class. */
export const isUrgentNotification = (
  notificationClass: NotificationClass,
  configured: readonly NotificationClass[] | undefined,
): boolean => urgentClassesOf(configured).includes(notificationClass);

/**
 * The whole policy: immediate, or held for the next digest.
 *
 * The order of the questions is the order of the rules above, and it is load-bearing — an urgent
 * class is immediate *before* the digest is consulted, so switching the digest off can never make
 * an escalation quieter than switching it on.
 */
export const notificationDelivery = (input: NotificationRoutingInput): NotificationDelivery => {
  if (isUrgentNotification(input.notificationClass, input.urgentClasses)) {
    return 'immediate';
  }
  if (!input.digestEnabled || input.quietHours === null) {
    return 'immediate';
  }
  return inQuietWindow(input.localMinutes, input.quietHours) ? 'digest' : 'immediate';
};
