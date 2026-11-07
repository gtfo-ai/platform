/**
 * **humanize, the account-linking half** — *Your accounts* and *Linked accounts*' words (S-26.8a,
 * the M26 UX spec § 5). Every word those two screens say is here, never inline, exactly as for
 * `ui/humanize.ts`, with `linkRefusal`, which picks the words for one of S-26.6's refusals (both
 * screens' unlink dialogs use it, so it cannot live in the lazy `features/your-accounts.tsx`).
 *
 * **Why it is not in `humanize.ts` itself (measured, S-26.8a):** `humanize.ts` is imported by the
 * remote worker's local page, so it sits in the chunk `worker.html` loads, which `bundle:check` holds
 * to 120 kB gzipped. These words, appended there, put that page at 119 807 B — 193 B under its
 * budget, with the next slice's words already on their way; here they leave it at 117 723 B.
 * Imported only by the two settings screens (both lazy), they ship in the settings chunk and in
 * neither entry's initial graph.
 */
import { ApiError } from '../api/http.js';
import { titleCase } from './humanize.js';

/**
 * A provider id as a person says it — `jira-cloud` is *Jira*. One this build does not name is its
 * id in title case, never the raw slug (the id is the platform's own, not provider text).
 */
const ACCOUNT_PROVIDER_NAME: Readonly<Record<string, string>> = {
  'jira-cloud': 'Jira',
  jira: 'Jira',
  gitlab: 'GitLab',
  slack: 'Slack',
};

export const accountProviderName = (provider: string): string =>
  Object.hasOwn(ACCOUNT_PROVIDER_NAME, provider)
    ? (ACCOUNT_PROVIDER_NAME[provider] as string)
    : titleCase(provider);

/** Why a link code stopped before its expiry (`identityLinkVoidReasonSchema`). */
export type LinkVoidReason = 'replaced' | 'second_author' | 'identity_linked_elsewhere';

export const LINK_VOID_REASON_WORDS: Readonly<Record<LinkVoidReason, string>> = {
  replaced: 'A newer code replaced this one, so it links nobody.',
  second_author:
    'Someone else wrote this code too, so it links nobody. Get a new code and write it where fewer people can see it.',
  identity_linked_elsewhere:
    'The account that wrote this code is linked to another person, so it links nobody. An administrator can change that.',
};

/** `n` things, with the noun in the right number: "1 task", "3 tasks". */
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * *Your accounts*' words. A provider's display name is never in these strings: the caller renders
 * the parts around an `UntrustedText` (`before`/`after`), or passes the name through
 * `sanitiseUntrusted` where it lands in a dialog title.
 */
export const YOUR_ACCOUNTS_WORDS = {
  title: 'Your accounts',
  description:
    'Your own Jira and GitLab accounts. Questions you answer and plans you approve from a linked account count as yours, and tasks assigned to it are yours here.',
  listLabel: 'Your linked accounts',
  noneTitle: 'No account is linked to you yet',
  noneHint:
    'Link your Jira or GitLab account so what you answer and approve there counts, and tasks assigned to you there reach you here.',
  linkedOn: (date: string): string => `linked ${date}`,
  accountId: 'Account id',
  via: 'Read through',
  unlink: 'Unlink',
  unlinkTitle: (provider: string, name: string): string => `Unlink ${provider} account ${name}?`,
  unlinkConsequence: (provider: string): string =>
    `Answers and approvals from this ${provider} account stop counting as yours, though tasks you already own stay yours until the ticket’s assignee changes.`,
  unlinkRefused: 'The account was not unlinked.',
  unlinked: 'Unlinked. Answers and approvals from that account no longer count as yours.',
  // The link flow.
  flowTitle: 'Link an account',
  why: 'A linked account can answer questions and approve plans, so the platform never takes your word for which account is yours and never matches by email: the provider proves it, from a comment you write.',
  start: 'Link an account',
  newCode: 'Get a new code',
  issuing: 'Getting a code…',
  issueRefused: 'No code was issued.',
  codeLabel: 'Your link code',
  validUntil: (time: string): string => `Valid until ${time}. It is shown only once.`,
  instruction:
    'Write this code as a comment on any ticket of a project you are in (Jira), from your own account.',
  instructionGitlab: 'In GitLab it works the same way, as a comment on any merge request.',
  dontEdit: 'Do not edit the comment afterwards: an edited comment links nobody.',
  waiting: 'Waiting for your comment… This page updates by itself.',
  liveWithoutCode: (created: string, expires: string): string =>
    `The code you asked for at ${created} is valid until ${expires}. It was shown only once: if you no longer have it, get a new one.`,
  wroteItOn: 'I wrote it on …',
  wroteItOnHint:
    'On a project with no webhook the platform reads the comments only when you say where. Name a ticket or merge request the platform has a task for.',
  project: 'Project',
  choose: 'Choose…',
  where: 'Where you wrote it',
  aTicket: 'A ticket',
  aMergeRequest: 'A merge request',
  ticketKey: 'Ticket key',
  mergeRequestNumber: 'Merge request number',
  read: 'Read the comments',
  reading: 'Reading…',
  readRefused: 'The comments were not read.',
  /**
   * What *I wrote it on …* found. `matched` is `0` also when the code's match was already recorded
   * (`alreadyMatched`, the state carries it); otherwise a comment that carried the code and matched
   * nothing was refused for its author, which is said rather than left as a silent nothing.
   */
  readOutcome: (
    comments: number,
    carried: number,
    matched: number,
    alreadyMatched: boolean,
  ): string =>
    carried === 0
      ? `None of the ${count(comments, 'comment', 'comments')} there carries your code. Check that you wrote it from your own account and did not edit it.`
      : matched === 0 && !alreadyMatched
        ? `Read ${count(comments, 'comment', 'comments')}; ${count(carried, 'carries', 'carry')} your code, but its author cannot be linked: the integration’s own account, an account an administrator declared a machine, or an account linked to another person links nobody.`
        : `Read ${count(comments, 'comment', 'comments')}; ${count(carried, 'carries', 'carry')} your code.`,
  // The confirmation (TD-031's amendment item 9 (a)).
  confirmBefore: (provider: string): string => `Link ${provider} account `,
  confirmAfter: '?',
  checkTheId: 'The name is what the provider says. Check that the account id is yours.',
  confirm: 'Link this account',
  confirming: 'Linking…',
  notMine: 'Not mine — get a new code',
  confirmRefused: 'The account was not linked.',
  // What follows.
  linkedBefore: (provider: string): string => `Linked: ${provider} account `,
  linkedAfter: '.',
  whatFollows: (provider: string): string =>
    `Questions you answer and plans you approve from this account in ${provider} now count as yours.`,
  adopted: (tasks: number, provider: string): string =>
    `You now own ${count(tasks, 'task', 'tasks')} assigned to you in ${provider}.`,
  deleteComment: 'You can delete the comment with the code now.',
  linkAnother: 'Link another account',
  // A code that stopped.
  expired: (time: string): string => `This code expired at ${time} without linking an account.`,
} as const;

/**
 * The refusals of S-26.6's routes, said plainly — keyed by the server's code; one this table does
 * not hold falls back to `errorSentence`'s (`api/read-error.ts`). A `link_code_voided` refusal is
 * said by its `void_reason` ({@link LINK_VOID_REASON_WORDS}).
 */
export const LINK_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  link_code_rate_limited:
    'You have asked for five codes in the last hour. Use the newest one, or try again later.',
  identity_links_unavailable:
    'Linking accounts is not available on this server right now. An administrator can tell why.',
  link_match_not_found: 'That match no longer belongs to your code. Reload the page.',
  link_code_expired: 'The code expired before you confirmed. Get a new code and comment again.',
  link_code_used: 'This code has already linked an account.',
  link_code_voided: 'This code no longer links anybody. Get a new code.',
  identity_linked_elsewhere:
    'That account is linked to another person. An administrator can unlink it.',
  identity_is_machine: 'An administrator declared that account a machine, so it links nobody.',
  identity_is_binding_account:
    'That is the account an integration acts as, so it links nobody. An administrator can link it if it is yours.',
  identity_link_read_not_permitted:
    'The platform reads a ticket for you only in a project where you are a member or above.',
  link_thread_not_found:
    'No task of that project has that ticket or merge request. Name one the platform has a task for.',
  link_thread_no_binding: 'That project has no connection that reads those comments.',
  link_thread_unavailable: 'The provider could not be read just now. Try again in a moment.',
  identity_not_found: 'That account is not linked any more.',
};

/** *Linked accounts*' (the administrator's) new words: Unlink and the unlinked assignees. */
export const LINKED_ACCOUNTS_WORDS = {
  unlink: 'Unlink',
  unlinkPersonTitle: (provider: string, name: string, person: string): string =>
    `Unlink ${provider} account ${name} from ${person}?`,
  unlinkMachineTitle: (provider: string, name: string): string =>
    `Unlink the ${provider} machine account ${name}?`,
  unlinkPersonConsequence: (person: string): string =>
    `Answers and approvals from this account stop counting as ${person}’s, though tasks they already own stay theirs until the ticket’s assignee changes.`,
  unlinkMachineConsequence:
    'The account is no longer treated as a machine: what it writes is again refused as from an unknown account until somebody links it.',
  unlinkRefused: 'The account was not unlinked.',
  candidatesTitle: 'Accounts nobody has linked',
  candidatesHint:
    'Each of these wrote something the platform refused because the account is not linked, or is the tracker assignee of a task in progress. Choosing one fills the form below; it links nothing until you say who the account is.',
  assignedTo: (tasks: number): string => `assigned to ${count(tasks, 'task', 'tasks')}`,
  refused: (deliveries: number): string => `${deliveries} refused`,
  lastSeen: (date: string): string => `last ${date}`,
} as const;

const isVoidReason = (value: string | undefined): value is LinkVoidReason =>
  value !== undefined && Object.hasOwn(LINK_VOID_REASON_WORDS, value);

/**
 * The sentence for one of S-26.6's refusals, or `undefined` for one this table does not hold — the
 * notice then says it from the error's status (`errorSentence`). A voided code is said by its reason.
 */
export const linkRefusal = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  if (error.code === 'link_code_voided') {
    const reason = error.details.find((detail) => detail.path === 'void_reason')?.message;
    if (isVoidReason(reason)) {
      return LINK_VOID_REASON_WORDS[reason];
    }
  }
  return Object.hasOwn(LINK_REFUSAL_WORDS, error.code) ? LINK_REFUSAL_WORDS[error.code] : undefined;
};
