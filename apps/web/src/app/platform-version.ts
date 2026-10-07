/**
 * **Is the server still the build this tab loaded?** (WP-154 (d), PROGRESS backlog 487.)
 *
 * `GET /api/version` was read once per tab (`useVersion`, for the dashboard and the settings page),
 * so nothing noticed an upgrade. This watch re-reads it at the two moments an upgrade shows itself:
 *
 * - **an `invalid_response`** — the API client asks {@link PlatformVersionWatch.check} before it
 *   throws the schema error, and throws `PlatformUpdatedError` instead when the server is a
 *   different build (`api/http.ts`);
 * - **every SSE reconnect** — a server restart drops the stream, so the reconnect is when a new
 *   build first becomes reachable (`realtime/provider.tsx`'s `onReconnected`).
 *
 * Once it has seen a different build it stays *updated* for the life of the tab: only a reload
 * loads the new bundle, so there is nothing to un-see. The shell shows the banner from
 * {@link PlatformVersionWatch.updated}.
 *
 * **The read is deliberately loose** — only `commit` is parsed, and unknown keys are kept. The
 * strict `versionResponseSchema` is the very thing that fails after an upgrade, and a watch that
 * could itself be refused by the new server's answer would be blind exactly when it is needed. A
 * read that fails for any other reason (the network, a 5xx while the server restarts) answers
 * *not known to be updated* and never throws: the caller's own error is then the one shown.
 */
import * as z from 'zod';
import type { ApiClient } from '../api/http.js';
import { isDifferentBuild } from './build-commit.js';

/** The one path the watch reads, and the one the API client never asks the watch about. */
export const VERSION_PATH = '/api/version';

const serverCommitSchema = z.looseObject({ commit: z.string().nullable() });

export interface PlatformVersionWatch {
  /** The commit this bundle was built from (`build-commit.ts`). */
  readonly bundleCommit: string;
  /** Re-reads the server's commit; `true` when the server is a different build. Never throws. */
  readonly check: () => Promise<boolean>;
  /** Whether a different build has been seen — stable for `useSyncExternalStore`. */
  readonly updated: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export const createPlatformVersionWatch = (options: {
  readonly bundleCommit: string;
  /** The server's `commit`; rejects when it could not be read. */
  readonly readServerCommit: () => Promise<string | null>;
}): PlatformVersionWatch => {
  let updated = false;
  let inFlight: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();

  const read = async (): Promise<boolean> => {
    try {
      const server = await options.readServerCommit();
      if (!updated && isDifferentBuild(options.bundleCommit, server)) {
        updated = true;
        for (const listener of listeners) {
          listener();
        }
      }
    } catch {
      // Not known to be updated; the caller's own error stands (see the module note).
    }
    return updated;
  };

  return {
    bundleCommit: options.bundleCommit,
    // Concurrent askers share one read: five queries failing at once are one `/api/version`.
    // Once a different build has been seen nothing can un-see it, so later askers read nothing.
    check: () => {
      if (updated) {
        return Promise.resolve(true);
      }
      inFlight ??= read().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    updated: () => updated,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** The watch's read, over the app's own client: loose, and never the strict schema. */
export const serverCommitReader = (client: ApiClient) => async (): Promise<string | null> =>
  (await client.get(VERSION_PATH, { schema: serverCommitSchema })).commit;
