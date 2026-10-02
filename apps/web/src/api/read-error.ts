/**
 * What a screen says when a read fails — **from the error's status**, never a fixed sentence
 * (WP-114, PROGRESS backlog 327).
 *
 * The dead-letter section named every read error *"Reading them needs the admin role"*, so a
 * `503 dead_letters_unavailable` from a process with no eventing, a 404 or a 500 was shown to an
 * administrator as a permission problem — a wrong sentence about the one person who can act on it.
 * A **403** is the role and keeps the screen's sentence; anything else shows what the server said
 * (the `ApiError`'s own message, or the status line for a body that was not a problem document),
 * which is what the knowledge panel already does. A network failure is not a 403 either, and is shown as itself.
 */
import { ApiError } from './http.js';

/** Is this read error the caller's role — a `403` from the server, and nothing else? */
export const isForbiddenError = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403;

/**
 * The sentence a screen shows for a failed read. A **role sentence** (*"… needs the admin role"*)
 * is written only as this function's `forbidden` argument — `apps/web/src/role-sentence.test.ts`
 * refuses one anywhere else (WP-122, PROGRESS backlog 385, which found five more screens that had
 * named every failure a permission problem).
 */
export const readErrorDetail = (error: unknown, forbidden: string): string =>
  isForbiddenError(error) ? forbidden : String(error);
