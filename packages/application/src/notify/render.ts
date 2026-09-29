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
  maintenance_report: (name) => `Maintenance pass for ${name}`,
  reminder: (name) => `${name} is still waiting for a person`,
};

/** A markdown inline link, `[label](target)` — the same shape the Slack converter turns into one. */
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^\s)]+)\)/g;

/**
 * Every markdown link in `text` replaced by its bare target — **the label is dropped** (WP-65,
 * PROGRESS backlog 215).
 *
 * A notification's detail carries somebody else's words: a return reason's first line is a
 * reviewer model's summary on a verdict return, a blocker brief may be a model's, a question is a
 * model's. Chat renders markdown, so `[Approve](https://attacker.example)` would reach the channel
 * as a link labelled *Approve* under the platform's bot identity, inside the platform's own
 * sentence — one misleading click the bot appears to vouch for (BD-022). Mentions and broadcasts
 * are already inert (`toMrkdwn`); this closes the label. The URL stays, as its own text: a reader
 * sees where it goes before following it, and a provider's autolinker still makes it clickable.
 *
 * One rule for the class rather than one per event: it is applied to every detail and to the
 * subject's name (a ticket key is provider text too), so no event needs its own. The title's
 * sentence and the task URL are platform text and are not links.
 *
 * Applied **to a fixpoint**, because one pass can build a link out of what it removed:
 * `[x]([y](https://a))` matches with target `[y](https://a`, and the bare target plus the trailing
 * `)` is `[y](https://a)` — a new labelled link. Every replacement removes at least four
 * characters, so the loop ends.
 */
export const unlabelledLinks = (text: string): string => {
  let current = text;
  for (;;) {
    const next = current.replace(
      MARKDOWN_LINK,
      (_match: string, _label: string, target: string) => target,
    );
    if (next === current) {
      return current;
    }
    current = next;
  }
};

export const notificationDraft = (input: {
  readonly notificationClass: NotificationClass;
  readonly subject: NotificationSubject;
  /** The event's own words: a return reason, a blocker brief, a question, a budget line. */
  readonly detail: string | null;
}): NotificationDraft => {
  const name = boundText(unlabelledLinks(input.subject.name), NOTIFICATION_KEY_MAX);
  return {
    notificationClass: input.notificationClass,
    title: boundText(TITLE_OF[input.notificationClass](name), NOTIFICATION_TITLE_MAX),
    // Unlabelled **before** the cut: a link cut in half is no longer a link this can see, and the
    // cut half would be rendered by nothing (no closing parenthesis), so the order is safe only
    // this way round.
    detail:
      input.detail === null
        ? null
        : boundText(unlabelledLinks(input.detail), NOTIFICATION_DETAIL_MAX),
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

/** How an approval was settled, as the approval aggregate records it. */
export type SettledApprovalOutcome = 'approved' | 'rejected' | 'expired';

/** The longest decider name the edited message carries; a person's name, not a paragraph. */
export const SETTLED_APPROVAL_DECIDER_MAX = 80;

/**
 * The platform's sentence for each outcome, naming who decided it (WP-73, PROGRESS backlog 234) —
 * never a provider string. `decider` is the name of the user in `decided_by_user_id`, already
 * redacted by the caller; `null` when the approval names no user the store knows, which keeps the
 * role wording. `expired` names no one: nobody decided.
 */
const settledApprovalText = (outcome: SettledApprovalOutcome, decider: string | null): string => {
  switch (outcome) {
    case 'approved':
      return decider === null
        ? 'Approved by a maintainer. The task page names who.'
        : `Approved by ${decider}.`;
    case 'rejected':
      return decider === null
        ? 'Changes requested by a maintainer. The task page names who.'
        : `Changes requested by ${decider}.`;
    case 'expired':
      return 'Expired: nobody decided before the deadline, so the deadline did.';
  }
};

/**
 * The edited approval message — the same message with its buttons gone and the outcome in their
 * place (WP-65, PROGRESS backlog 202).
 *
 * `markdown` only, never `blocks`, for {@link notificationBody}'s reason — and because a body with
 * no blocks is what makes the Slack adapter render plain sections, which is the whole point: the
 * buttons are removed by being absent. The decider is named by **name** since WP-73 (backlog 234),
 * read from `users` through `NotificationStore.userName` for the approval's `decided_by_user_id`;
 * the name is text a person typed, so it is bounded and its links unlabelled here like every other
 * string, and the markdown path neutralises a mention in it.
 */
export const settledApprovalBody = (input: {
  readonly subject: NotificationSubject;
  readonly outcome: SettledApprovalOutcome;
  /** The decider's display name, redacted; `null` when none is known. */
  readonly decider?: string | null;
}): MessageBody => {
  const name = boundText(unlabelledLinks(input.subject.name), NOTIFICATION_KEY_MAX);
  const url = boundUrl(input.subject.url);
  const decider =
    input.decider === null || input.decider === undefined || input.decider.trim() === ''
      ? null
      : boundText(unlabelledLinks(input.decider), SETTLED_APPROVAL_DECIDER_MAX);
  return {
    markdown: [
      `**${boundText(`${name}: the approval is settled`, NOTIFICATION_TITLE_MAX)}**`,
      settledApprovalText(input.outcome, decider),
      ...(url === null ? [] : [url]),
    ].join('\n'),
  };
};

/** How a question stopped waiting, as the question aggregate records it (WP-88). */
export type SettledQuestionOutcome = 'answered' | 'expired';

/**
 * The platform's sentence for each outcome. `answerer` is the name of the user in
 * `answered_by_user_id`, already redacted by the caller; `null` keeps a sentence that names no one.
 * The **answer itself is never repeated**: it is text a person (or, from chat, anybody mapped)
 * typed, and it lives on the question and the task page, not in a channel message the platform
 * appears to vouch for.
 */
const settledQuestionText = (outcome: SettledQuestionOutcome, answerer: string | null): string =>
  outcome === 'answered'
    ? answerer === null
      ? 'Answered. The task page shows the answer and who gave it.'
      : `Answered by ${answerer}. The task page shows the answer.`
    : 'Expired: nobody answered before the deadline, so the task now needs a human on its page.';

/**
 * The edited question message — the same message with its buttons gone and the outcome in their
 * place (WP-88, PROGRESS backlog 233), the question's twin of {@link settledApprovalBody}: markdown
 * only, so the Slack adapter renders plain sections and the buttons are removed by being absent.
 */
export const settledQuestionBody = (input: {
  readonly subject: NotificationSubject;
  readonly outcome: SettledQuestionOutcome;
  /** The answerer's display name, redacted; `null` when none is known or nobody answered. */
  readonly answerer?: string | null;
}): MessageBody => {
  const name = boundText(unlabelledLinks(input.subject.name), NOTIFICATION_KEY_MAX);
  const url = boundUrl(input.subject.url);
  const answerer =
    input.answerer === null || input.answerer === undefined || input.answerer.trim() === ''
      ? null
      : boundText(unlabelledLinks(input.answerer), SETTLED_APPROVAL_DECIDER_MAX);
  return {
    markdown: [
      `**${boundText(`${name}: the question is settled`, NOTIFICATION_TITLE_MAX)}**`,
      settledQuestionText(input.outcome, answerer),
      ...(url === null ? [] : [url]),
    ].join('\n'),
  };
};
