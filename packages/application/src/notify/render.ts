/**
 * What a notification says — platform text, with every untrusted field bounded (WP-32, BD-022).
 *
 * Three rules, and each one is a defect somebody else has already paid for:
 *
 *  1. **The sentence is the platform's and the values are quoted into it.** A ticket key, a stage
 *     id and a stage's return reason all come from outside (a provider, a project's own template,
 *     a model), so none of them is ever a *verb* here: the class decides what is said and the
 *     fields decide what it is said about.
 *  2. **Every untrusted field is bounded before it is stored or sent**, at the caps below — the
 *     **URL included**, by {@link boundUrl}. A chat message has a provider limit (Slack truncates
 *     at 4 000 characters and refuses past 40 000), and `notifications.title`/`detail`/`url` are
 *     stored state built out of external text — the third such sink after `inbox` and
 *     `tasks.ticket_snapshot`.
 *  3. **Nothing here redacts.** Redaction is the binding's (TD-012 step 1 composed with step 2) and
 *     happens in the duty, which is the only place that holds the redactor. A function that
 *     redacted *and* bounded would decide the order, and the order matters: WP-30 measured that
 *     truncating first publishes `glpat-FAKE`, a prefix no rule can match.
 *
 * Pure and total: no clock, no I/O, no provider.
 */
import type { NotificationClass } from '@platform/contracts';
import type { MessageBody } from '../ports/integrations/communication.js';

/**
 * The caps, and why each is where it is.
 *
 * A title is one line in a channel and one line in a digest; 200 characters is longer than any
 * ticket summary a board will show and short enough that twenty of them fit in one digest under
 * Slack's 3 000-character section limit. A detail is a return reason or a blocker brief — a
 * paragraph the platform wrote for a human to act on — and 1 000 characters is the length at which
 * a chat message stops being read; the whole brief is on the task page, which the URL points at.
 */
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_DETAIL_MAX = 1_000;
/** A ticket key inside the title. Jira's are short; a provider's are not promised to be. */
export const NOTIFICATION_KEY_MAX = 64;
/**
 * A link is stored state and a line of a chat message, so it is bounded like the other two.
 *
 * 2 048 characters is far longer than any ticket or merge-request URL a provider issues (Jira's
 * `…/browse/PROJ-1` is under 60) and is the length past which a value is not a link anybody
 * follows. The number is the platform's own choice rather than a protocol limit: nothing in
 * `urlSchema` bounds it, so something here must.
 */
export const NOTIFICATION_URL_MAX = 2_048;

/**
 * Cuts to `max` **characters** and says so, rather than cutting silently.
 *
 * The marker is the platform's own and cannot be forged into the middle of a value, because the
 * cut always happens at the end: a body that contains the ellipsis is a body that is shorter than
 * the cap and was not cut.
 */
export const boundText = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

/** The two schemes a notification is willing to publish as a link. */
const RENDERABLE_URL_SCHEMES: readonly string[] = ['http:', 'https:'];

/**
 * Every character of a URL the platform is willing to publish: printable ASCII without the space
 * (`!` is U+0021 and `~` is U+007E).
 *
 * Written as a range of literal characters rather than as `\u`-escapes because a regular
 * expression containing a control character is refused by `lint/suspicious/noControlCharactersInRegex`
 * — and the positive form is the better rule anyway: it names what is allowed instead of chasing
 * what is not. What it excludes, and why each matters: the space and every C0/C1 control (a newline
 * would write an extra line into a message body that is `**title**\ndetail\nurl`), the Unicode line
 * separators, and non-ASCII characters. The cost is stated rather than hidden: a provider that
 * issues an internationalised URL un-encoded loses its link. Every URL-emitting API this platform
 * speaks to percent-encodes, and a dropped link is the safe direction.
 */
const PUBLISHABLE_URL_CHARACTERS = /^[!-~]+$/;

/**
 * The URL a notification may carry — or `null`, which is how this one is bounded.
 *
 * It **drops** where {@link boundText} truncates, and the three refusals are one argument: a value
 * this function returns is concatenated into a chat message and stored in `notifications.url`, and
 * it arrived from a provider (BD-022).
 *
 *  1. **Too long is dropped, not cut.** A truncated URL is not a shorter link, it is a *different*
 *     one — `…/browse/ACME-1?next=/admin` cut at the query still resolves, somewhere nobody asked
 *     for — and there is no ellipsis a reader would notice inside a link.
 *  2. **A scheme the platform did not expect is dropped.** `urlSchema` is `z.url()`, which accepts
 *     `javascript:`, `data:`, `vbscript:` and `file:` (Q49), and a chat client renders this value
 *     as a link. Anything `new URL` cannot parse at all goes the same way.
 *  3. **Anything outside {@link PUBLISHABLE_URL_CHARACTERS} is refused rather than escaped.** The
 *     body is `**title**\ndetail\nurl`, so a newline inside the URL would write an extra line of
 *     what looks like platform text — and `new URL` strips newlines silently, which means the parse
 *     alone would have said yes. Refusing keeps the value byte-identical, so there is nothing for a
 *     later transform to undo (the answer `assemblePrompt` and `untrusted.tsx` both give).
 */
export const boundUrl = (value: string | null): string | null => {
  if (
    value === null ||
    value.length > NOTIFICATION_URL_MAX ||
    !PUBLISHABLE_URL_CHARACTERS.test(value)
  ) {
    return null;
  }
  try {
    return RENDERABLE_URL_SCHEMES.includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
};

export interface NotificationSubject {
  /** The ticket key, or another short name for what this is about. Bounded here. */
  readonly name: string;
  /**
   * Where a human goes to act on it — **already redacted**, and bounded here by {@link boundUrl}.
   *
   * Rendered as a link by the provider, never as markup. The caller redacts it for the same reason
   * it redacts the detail: this value is stored in `notifications.url` and sent to a chat provider,
   * and a ticket URL is provider text that can carry a query string somebody else wrote.
   */
  readonly url: string | null;
}

export interface NotificationDraft {
  readonly notificationClass: NotificationClass;
  readonly title: string;
  readonly detail: string | null;
  readonly url: string | null;
}

/** The platform's sentence for each class. The only place a class becomes English. */
const TITLE_OF: Readonly<Record<NotificationClass, (name: string) => string>> = {
  task_started: (name) => `${name} picked up`,
  question: (name) => `${name} is waiting for an answer`,
  stage_returned: (name) => `${name} went back a stage`,
  escalation: (name) => `${name} needs a human`,
  task_completed: (name) => `${name} is done`,
  task_cancelled: (name) => `${name} was cancelled`,
  budget_threshold: (name) => `${name} is close to its budget`,
  budget_exhausted: (name) => `${name} has spent its budget`,
  approval: (name) => `${name} is waiting for an approval`,
};

export const notificationDraft = (input: {
  readonly notificationClass: NotificationClass;
  readonly subject: NotificationSubject;
  /** The event's own words: a return reason, a blocker brief, a question, a budget line. */
  readonly detail: string | null;
}): NotificationDraft => {
  const name = boundText(input.subject.name, NOTIFICATION_KEY_MAX);
  return {
    notificationClass: input.notificationClass,
    title: boundText(TITLE_OF[input.notificationClass](name), NOTIFICATION_TITLE_MAX),
    detail: input.detail === null ? null : boundText(input.detail, NOTIFICATION_DETAIL_MAX),
    url: boundUrl(input.subject.url),
  };
};

/**
 * The chat message for one notification.
 *
 * `markdown` only — never `blocks`. The port is explicit that a caller supplying blocks owns the
 * escaping of every string inside them, and these strings carry a ticket's own words: handing the
 * provider markdown is what puts them through `toMrkdwn`, which neutralises `<!channel>`, `<@U…>`
 * and link syntax. A notification with an `@channel` in a ticket title would broadcast to everyone
 * in the workspace, which is precisely the bot product/18 exists to keep welcome.
 */
export const notificationBody = (draft: NotificationDraft): MessageBody => ({
  markdown: [
    `**${draft.title}**`,
    ...(draft.detail === null ? [] : [draft.detail]),
    ...(draft.url === null ? [] : [draft.url]),
  ].join('\n'),
});
