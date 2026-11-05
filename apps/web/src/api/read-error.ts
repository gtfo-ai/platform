/**
 * What a screen says when a read or a command fails — **from the error's structured fields**, never
 * from the server's text (WP-114, PROGRESS backlog 327; S-23.22).
 *
 * The dead-letter section named every read error *"Reading them needs the admin role"*, so a
 * `503 dead_letters_unavailable` from a process with no eventing, a 404 or a 500 was shown to an
 * administrator as a permission problem — a wrong sentence about the one person who can act on it.
 * A **403** is the role and keeps the screen's sentence; anything else is said from the error's
 * status and code.
 *
 * **A server's `message` is a diagnostic, not copy** (S-23.22, the final UX audit's item 2). The
 * problem document's text is written for an operator reading a log: it names table rows, API paths,
 * ids and spec references. So {@link errorSentence} builds the visible sentence from what the error
 * *is* — its code, its status, the paths in `details` — and returns the message separately, which
 * `ErrorNotice` shows only inside a collapsed *Technical details*. A network failure and the client's
 * own platform sentences (an attempt nobody can vouch for) are platform text and stay visible.
 */

import { configFieldLabel } from '../ui/humanize.js';
import { ApiError, NetworkError } from './http.js';

/** Is this read error the caller's role — a `403` from the server, and nothing else? */
export const isForbiddenError = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403;

/** What the person reads, and the diagnostic that goes behind *Technical details* (or nothing). */
export interface ErrorSentence {
  readonly sentence: string;
  readonly technical: string | null;
}

/**
 * Refusals the task, run and integration screens meet, said plainly. A code this table does not
 * hold falls back to its status ({@link STATUS_SENTENCE}); the server's own text is never the
 * sentence.
 */
const CODE_SENTENCE: Readonly<Record<string, string>> = {
  forbidden: 'Your role does not allow this.',
  unauthenticated: 'You are signed out. Sign in again.',
  illegal_transition:
    'This is not possible in the state it is in now. Reload to see where it stands.',
  task_conflict: 'The task changed while this was being done. Try again.',
  task_merged: 'The task is already merged, so this no longer applies.',
  stage_not_reached: 'The task has not reached that stage yet.',
  stage_not_current: 'That stage is not the one the task is at now.',
  stage_not_in_template: 'That stage is not part of this task’s pipeline.',
  iteration_limit_reached: 'That loop has used all the rounds it is allowed.',
  run_not_live: 'The run has already ended.',
  budget_not_raised: 'The new cap must be above the cap in force.',
  not_paused_by_task_cap: 'The task is not paused by its own cap.',
  no_gate_feedback: 'There is no gate failure to attach.',
  model_not_listed: 'That model is not one this project may use.',
  take_in_progress: 'Someone is already taking this over.',
  policy_violation: 'A project policy does not allow this.',
  integration_host_not_permitted: 'That address is on a host this instance does not allow.',
  secret_name_not_permitted: 'That environment variable is not one this instance allows.',
  integration_retired: 'The integration is retired, so it cannot be changed.',
  integration_name_retired: 'A retired integration already has that name. Choose another.',
  too_many_requests: 'Too many requests. Wait a moment and try again.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  invalid_response: 'The server’s answer could not be read. Reload the page.',
  idempotency_key_in_flight:
    'The same request is still being performed. Wait a moment, then check whether it was done.',
  idempotency_key_reused:
    'This was already sent with different details. Reload the page and try again.',
  ticket_has_task: 'That ticket already has a task. Open it from the board.',
  task_exists: 'That ticket already has a task. Open it from the board.',
  discovery_in_flight: 'A discovery is already running for this project. Wait for it to finish.',
  project_has_live_tasks:
    'The project has tasks still in progress. Wait for them to finish or cancel them first.',
  missing_secret:
    'An environment variable you named is not set on the server. Ask an administrator to set it, then try again.',
};

/** The refusals whose `details` name an integration's settings rather than a form's fields. */
const CONFIG_CODES: ReadonlySet<string> = new Set([
  'invalid_integration_config',
  'invalid_binding_config',
  'credential_in_config',
]);

const STATUS_SENTENCE = (status: number): string =>
  status === 400 || status === 422
    ? 'The server did not accept this request.'
    : status === 401
      ? 'You are signed out. Sign in again.'
      : status === 403
        ? 'This is not allowed.'
        : status === 404
          ? 'It was not found. It may have been removed.'
          : status === 409
            ? 'This is not possible in the state it is in now. Reload to see where it stands.'
            : status === 413
              ? 'That is too large to send.'
              : status === 429
                ? 'Too many requests. Wait a moment and try again.'
                : status >= 500
                  ? 'The server could not do this right now. Try again in a moment.'
                  : 'The server refused this.';

/**
 * The settings a list of key paths names, as labels, once each: `config.base_url` → "Base URL",
 * `statuses.0` → "Statuses". The last named segment is the setting; an index is not a name.
 */
export const settingNames = (paths: readonly string[]): string[] => [
  ...new Set(
    paths
      .map((path) =>
        path
          .split(/[./]/)
          .filter((segment) => !/^\d+$/.test(segment))
          .at(-1),
      )
      .filter((segment): segment is string => segment !== undefined && segment !== '')
      .map(configFieldLabel),
  ),
];

/** "Some settings are invalid: Base URL, Project key." — or without the list when none is named. */
export const invalidSettingsSentence = (paths: readonly string[]): string => {
  const names = settingNames(paths);
  return names.length === 0
    ? 'Some settings are invalid.'
    : `Some settings are invalid: ${names.join(', ')}.`;
};

const fieldNames = (details: ApiError['details']): string[] =>
  settingNames(details.map((detail) => detail.path));

/** The visible sentence for `error`, built from its type, code, status and paths. */
export const errorSentence = (error: unknown): ErrorSentence => {
  if (error instanceof ApiError) {
    const technical = `${error.message} (${error.status} ${error.code})`;
    if (error.code === 'idempotency_attempt_unknown') {
      // The client's own platform sentence (`ATTEMPT_UNKNOWN_MESSAGE`), never the server's.
      return { sentence: error.message, technical: null };
    }
    const fields = error.code === 'invalid_response' ? [] : fieldNames(error.details);
    const known = CODE_SENTENCE[error.code];
    if (known !== undefined) {
      return { sentence: known, technical };
    }
    if (fields.length > 0) {
      const what = CONFIG_CODES.has(error.code) ? 'settings' : 'fields';
      return { sentence: `Some ${what} are invalid: ${fields.join(', ')}.`, technical };
    }
    return { sentence: STATUS_SENTENCE(error.status), technical };
  }
  if (error instanceof NetworkError) {
    return {
      sentence: 'The server could not be reached. Check the connection and try again.',
      technical: null,
    };
  }
  return { sentence: 'Something went wrong.', technical: String(error) };
};

/**
 * The sentence a screen shows for a failed read. A **role sentence** (*"… needs the admin role"*)
 * is written only as this function's `forbidden` argument — `apps/web/src/role-sentence.test.ts`
 * refuses one anywhere else (WP-122, PROGRESS backlog 385, which found five more screens that had
 * named every failure a permission problem). Any other failure is {@link errorSentence}'s.
 */
export const readErrorDetail = (error: unknown, forbidden: string): string =>
  isForbiddenError(error) ? forbidden : errorSentence(error).sentence;
