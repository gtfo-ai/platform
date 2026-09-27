/**
 * The `Idempotency-Key` record in memory — the double the route tests bind `claimAttempt` and
 * `releaseAttempt` to, so a route's key policy is asserted without a PostgreSQL container.
 *
 * It keeps the table's two states apart the way `command_idempotency` does (migration 0053):
 * `performed` is the map a test's `recordAction` fills — what the real `insertHumanAction` completes
 * — and `inFlight` is a claim nobody completed. The semantics it must share with the SQL are the
 * three `queries/idempotency-queries.ts` states: a first claim wins, a performed key answers its
 * digest and params, a held key answers `in_flight`, and a release frees only a held key. The SQL
 * half is held to the same three by `test/integration/server/command-idempotency.integration.test.ts`.
 */
import type { JsonObject } from '@platform/contracts';
import type { CommandAttemptClaim } from '../queries/idempotency-queries.js';
import type { IdempotencyRecords } from './idempotency.js';

export interface MemoryAttempt {
  readonly bodyDigest: string | null;
  readonly params: JsonObject;
}

export interface MemoryAttemptRecords extends IdempotencyRecords {
  /** Held claims, keyed `user|action|key`, with the instant each was taken. */
  readonly inFlight: Map<string, { readonly bodyDigest: string; readonly claimedAt: string }>;
}

export const scopeOf = (query: {
  readonly userId: string;
  readonly action: string;
  readonly key: string;
}): string => `${query.userId}|${query.action}|${query.key}`;

export const memoryAttemptRecords = (
  /** Completed attempts, keyed `user|action|key` — the map a test's `recordAction` writes. */
  performed: Map<string, MemoryAttempt>,
  clock: () => string = () => new Date().toISOString(),
): MemoryAttemptRecords => {
  const inFlight = new Map<string, { readonly bodyDigest: string; readonly claimedAt: string }>();
  return {
    inFlight,
    claimAttempt: async (query): Promise<CommandAttemptClaim> => {
      const scope = scopeOf(query);
      const done = performed.get(scope);
      if (done !== undefined) {
        return { status: 'performed', bodyDigest: done.bodyDigest, params: done.params };
      }
      const held = inFlight.get(scope);
      if (held !== undefined) {
        return { status: 'in_flight', bodyDigest: held.bodyDigest, claimedAt: held.claimedAt };
      }
      inFlight.set(scope, { bodyDigest: query.digest, claimedAt: clock() });
      return { status: 'claimed' };
    },
    releaseAttempt: async (query) => {
      inFlight.delete(scopeOf(query));
    },
  };
};
