/**
 * What a screen says when a read or a command fails — **from the error's structured fields**, never
 * from the server's text (WP-114, PROGRESS backlog 327; S-23.22; S-25.18).
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
 * *is* — its code, its status, the specifics in `details` — and returns the message separately,
 * which `ErrorNotice` shows only inside a collapsed *Technical details*. A network failure and the
 * client's own platform sentences (an attempt nobody can vouch for) are platform text and stay
 * visible.
 *
 * **Every code the server raises has its own sentence, with the next step** (S-25.18, the owner's
 * rule: the person always understands what went wrong, why, and what is required of them). Before
 * it, a code this table did not hold fell back to its status, so ten typed 409s read *"This is not
 * possible in the state it is in now. Reload to see where it stands"* — which reload fixed for none
 * of them — and the reason sat behind the collapsed details. `api/error-code-census.test.ts` reads
 * the codes off the server's sources and fails on one with no sentence here, and on a sentence for
 * a code the server no longer raises. Where the server's `details` name the specifics (which
 * projects use an integration, the organisation's maximum, the state a task is in, the request id
 * of a failure), the sentence says them.
 *
 * **The table is loaded, not imported** (review of #123): it lives in `./error-sentences.ts`, which
 * this module loads with `import()` the first time an error is said ({@link loadErrorSentences}),
 * because `ErrorNotice` is on every screen's first paint and the sentences are needed only after a
 * failure. Until it arrives an error is said by its status and its paths — the sentence this module
 * always gave a code it did not know — and `ErrorNotice`/`ErrorReason` re-render with the code's own
 * sentence when it lands ({@link useErrorSentences}). The `ui` tier loads it before every test file
 * (`test/support/web-lazy-chunks.ts`), so a test meets the final sentence.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type * as Sentences from './error-sentences.js';
import { fieldNames, TRANSITION_UNKNOWN } from './error-words.js';
import { ApiError, NetworkError } from './http.js';

/** Is this read error the caller's role — a `403` from the server, and nothing else? */
export const isForbiddenError = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403;

/** What the person reads, and the diagnostic that goes behind *Technical details* (or nothing). */
export interface ErrorSentence {
  readonly sentence: string;
  readonly technical: string | null;
}

export {
  fieldNames,
  invalidSettingsSentence,
  settingNames,
  TRANSITION_UNKNOWN,
} from './error-words.js';

// ── The sentence table, loaded on the first failure ──────────────────────────

type SentencesModule = typeof Sentences;

let sentences: SentencesModule | null = null;
let loading: Promise<SentencesModule> | null = null;
const listeners = new Set<() => void>();

/** The sentence table's module, imported once; a failed import is forgotten so the next retries. */
export const loadErrorSentences = (): Promise<SentencesModule> => {
  loading ??= import('./error-sentences.js').then(
    (loaded) => {
      sentences = loaded;
      for (const listener of listeners) listener();
      return loaded;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
};

/**
 * Starts the load, for a caller that cannot wait on it. A chunk that failed to load leaves the
 * status sentence in place — still a true sentence about the failure — and the next call retries.
 */
const startLoading = (): void => {
  loadErrorSentences().catch(() => undefined);
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const loaded = (): boolean => sentences !== null;

/**
 * For a component that says an error: loads the table and re-renders once it has arrived, so the
 * status sentence drawn first is replaced by the code's own. `true` once it is here.
 */
export const useErrorSentences = (): boolean => {
  const here = useSyncExternalStore(subscribe, loaded, loaded);
  useEffect(() => {
    if (!here) startLoading();
  }, [here]);
  return here;
};

/** The refusals whose `details` name an integration's settings rather than a form's fields. */
const CONFIG_CODES: ReadonlySet<string> = new Set([
  'invalid_integration_config',
  'invalid_binding_config',
  'credential_in_config',
]);

/**
 * A code no entry holds — a framework's own (`fst_err_…`) or a server newer than this bundle — is
 * said by its status. A 409 says it cannot be done *now* and never offers a reload as the fix.
 */
const STATUS_SENTENCE = (status: number): string =>
  status === 400 || status === 422
    ? 'The server did not accept this request. Check what you entered and try again.'
    : status === 401
      ? 'You are signed out. Sign in again.'
      : status === 403
        ? 'This is not allowed.'
        : status === 404
          ? 'It was not found. It may have been removed.'
          : status === 409
            ? TRANSITION_UNKNOWN
            : status === 413
              ? 'That is too large to send.'
              : status === 429
                ? 'Too many requests. Wait a moment and try again.'
                : status >= 500
                  ? 'The server could not do this right now. Try again in a moment.'
                  : 'The server refused this.';

/** The visible sentence for `error`, built from its type, code, status and details. */
export const errorSentence = (error: unknown): ErrorSentence => {
  if (error instanceof ApiError) {
    const technical = `${error.message} (${error.status} ${error.code})`;
    if (error.code === 'idempotency_attempt_unknown') {
      // The client's own platform sentence (`ATTEMPT_UNKNOWN_MESSAGE`), never the server's.
      return { sentence: error.message, technical: null };
    }
    if (sentences === null) {
      startLoading();
    }
    const known = sentences?.codeSentence(error);
    if (known !== undefined) {
      return { sentence: known, technical };
    }
    const fields = error.code === 'invalid_response' ? [] : fieldNames(error.details);
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
