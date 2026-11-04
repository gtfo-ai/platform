/**
 * Whether this instance has ever been signed in to — the sign-in page's one pre-session fact
 * (WP-291).
 *
 * The page names `APP_BOOTSTRAP_ADMIN_EMAIL` only while nobody has signed in yet; after that the
 * hint is noise to every user who is not the operator. Where the fact is stored, and why there, is
 * `queries/setup-state-queries.ts`.
 *
 * ## Monotone, so it is cached one way only
 *
 * Once somebody has signed in, the answer stays: `users.first_signed_in_at` is set once and never
 * cleared (the one way back is deleting every account that ever signed in, on an instance with no
 * `human_actions` row — the instance is then unused again, and the hint is right). So a `false` answer is cached for the life of the process and the public read stops touching the
 * database at all — an unauthenticated caller cannot turn this endpoint into a query per request
 * except on an instance nobody has used yet. A `true` is never cached, because another process may
 * record the first sign-in at any moment.
 *
 * ## A failed stamp never fails a sign-in
 *
 * `signedIn` runs from Better Auth's `session.create.after` hook. A database error there would turn
 * a correct password into a 500 for the sake of a hint, so it is **logged at warn** and the sign-in
 * stands; the next sign-in stamps the column instead. That is the only error this module absorbs,
 * and it says so in the log line.
 */
import type { Logger } from '@platform/application';

export interface SetupStateStore {
  readonly anySignInRecorded: () => Promise<boolean>;
  readonly recordFirstSignIn: (userId: string) => Promise<void>;
}

export interface SetupState {
  /** `true` only while no account has ever signed in on this instance. */
  readonly firstSignInPending: () => Promise<boolean>;
  /** Called for every session the served Better Auth instance creates. */
  readonly signedIn: (userId: string) => Promise<void>;
}

export const createSetupState = (options: {
  readonly store: SetupStateStore;
  readonly logger: Logger;
}): SetupState => {
  let everSignedIn = false;
  return {
    firstSignInPending: async () => {
      if (everSignedIn) {
        return false;
      }
      everSignedIn = await options.store.anySignInRecorded();
      return !everSignedIn;
    },
    // Every sign-in stamps its own account: the column is per user, and the statement is a no-op
    // (`… and first_signed_in_at is null`) for an account that has signed in before.
    signedIn: async (userId) => {
      try {
        await options.store.recordFirstSignIn(userId);
        everSignedIn = true;
      } catch (error) {
        options.logger.warn(
          { user_id: userId, error: String(error) },
          'could not record the first sign-in; the sign-in page keeps its bootstrap hint until the next one',
        );
      }
    },
  };
};
