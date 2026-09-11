/**
 * In-memory doubles for the ports the `IntegrationActionExecutor` stands on: the audit log, the
 * idempotency store, and time.
 *
 * technical/10 treats fakes as first-class code. These three are the *platform* side of WP-07 —
 * the provider fakes live in `@platform/integrations` — and they exist so that shadow mode,
 * idempotency, backoff and the audit trail can be proven without a database and without the wall
 * clock.
 *
 * ## Known divergences from the adapters they stand in for
 *
 * The register is here so the set is written down rather than rediscovered. The rule for adding to
 * it: **a fake may be stricter than the real adapter, never kinder.** Each entry says which it is,
 * because a reader who takes "stricter" on faith will not re-check.
 *
 *  1. **Equal — both implementations validate every event draft against the catalogue.** This
 *     entry read "stricter" until WP-15b, when the port got its second implementation:
 *     `MemoryIntegrationAuditLog` parses the payloads `integrationActionEventDrafts` produces with
 *     `domainEventSchemasByType`, and `createPostgresIntegrationAuditLog` parses the whole envelope
 *     with the same map before it opens a transaction. A claim about the *other* implementation
 *     cannot be maintained from inside this file, so it is restated when that one changes
 *     (standing rule 63).
 *  2. **Stricter — `put` on an existing idempotency key throws.** The Postgres store (WP-15b) is
 *     `on conflict do nothing`, keeping the first result, because the first is the one every later
 *     `get` must keep answering. Here a second `put` for a key that already holds a value is a loud
 *     error instead, because the executor only ever writes a key it has just missed and a second
 *     write means two callers raced through the same slot — the direction a fake is allowed to
 *     differ in.
 *  3. **Different — no persistence, no partitions, no `REVOKE`.** The append-only guarantee of
 *     `integration_actions` (technical/03) is enforced by the database, not here; the fake simply
 *     never mutates a recorded entry. Neither stricter nor kinder: the port promises nothing about
 *     storage. The properties both implementations *do* owe are the shared suites in
 *     `test/contract/support/integrations/audit-contract-suites.ts`, which run against each.
 *  4. **Different — the virtual timer's clock only moves when something sleeps.** Real elapsed
 *     time between two calls is zero here, so a duration recorded in an audit row is the sum of
 *     the backoff waits and nothing else. That makes durations deterministic; it also means a test
 *     cannot assert that a provider call "took" any particular time, which is a hardware
 *     assertion anyway.
 *  5. **Kinder, deliberately — `failNext` exists.** The real audit log fails when the database
 *     does. The fake fails when a test asks it to, which is the only way to reach the
 *     "action succeeded but its row could not be written" branch of the executor. Scripted failure
 *     is opt-in and off by default.
 */
import { domainEventSchemasByType, type Id, type JsonValue } from '@platform/contracts';
import {
  type IdempotencyScope,
  type IdempotencyStore,
  type IntegrationActionEntry,
  type IntegrationAuditLog,
  type IntegrationTimer,
  idempotencyStorageKey,
  integrationActionEventDrafts,
} from '../ports/integrations/audit.js';
import type { NormalisedEvent } from '../ports/integrations/common.js';

// ── Audit log ────────────────────────────────────────────────────────────────

export type IntegrationAuditEvent = NormalisedEvent<
  'integration.action.performed' | 'integration.action.failed'
>;

export interface MemoryIntegrationAuditLog extends IntegrationAuditLog {
  /** Every row, in the order it was recorded. */
  readonly entries: readonly IntegrationActionEntry[];
  /** The catalogue events those rows produced — none for `would_have` and `replayed`. */
  readonly events: readonly IntegrationAuditEvent[];
  /** Rows for one action name, for readable assertions. */
  entriesFor(action: string): readonly IntegrationActionEntry[];
  /** Makes the next `record` call reject with `error` (divergence 5). */
  failNext(error: Error): void;
  reset(): void;
}

export const createMemoryAuditLog = (): MemoryIntegrationAuditLog => {
  const entries: IntegrationActionEntry[] = [];
  const events: IntegrationAuditEvent[] = [];
  let nextFailure: Error | null = null;

  return {
    get entries() {
      return entries;
    },
    get events() {
      return events;
    },
    entriesFor: (action) => entries.filter((entry) => entry.action === action),
    failNext: (error) => {
      nextFailure = error;
    },
    reset: () => {
      entries.length = 0;
      events.length = 0;
      nextFailure = null;
    },
    record: async (entry) => {
      if (nextFailure !== null) {
        const error = nextFailure;
        nextFailure = null;
        throw error;
      }
      entries.push(entry);
      for (const draft of integrationActionEventDrafts(entry)) {
        // Divergence 1: a drafted payload the `events` table would reject fails here too.
        domainEventSchemasByType[draft.type].shape.payload.parse(draft.payload);
        events.push(draft);
      }
    },
  };
};

// ── Idempotency store ────────────────────────────────────────────────────────

export interface MemoryIdempotencyStore extends IdempotencyStore {
  readonly size: number;
  /** Storage keys currently held, for asserting that two scopes did not collide. */
  keys(): readonly string[];
  reset(): void;
}

export const createMemoryIdempotencyStore = (): MemoryIdempotencyStore => {
  const values = new Map<string, JsonValue>();
  return {
    get size() {
      return values.size;
    },
    keys: () => [...values.keys()],
    reset: () => values.clear(),
    get: async (scope: IdempotencyScope) => values.get(idempotencyStorageKey(scope)),
    put: async (scope: IdempotencyScope, result: JsonValue) => {
      const key = idempotencyStorageKey(scope);
      if (values.has(key)) {
        // Divergence 2: two writers reached the same key, which the executor never does alone.
        throw new Error(`idempotency key ${key} was written twice`);
      }
      values.set(key, result);
    },
  };
};

// ── Time ─────────────────────────────────────────────────────────────────────

export interface VirtualTimer extends IntegrationTimer {
  /** Every `sleep` duration asked for, in order. Positive assertions on backoff live here. */
  readonly sleeps: readonly number[];
  /** Moves the clock forward, resolving everything that falls due. */
  advance(milliseconds: number): Promise<void>;
  /** Sleepers still waiting. */
  readonly pending: number;
}

export interface VirtualTimerOptions {
  readonly start?: number;
  /**
   * When true, a `sleep` schedules its own wake-up: the clock jumps to the earliest deadline on
   * the next microtask. A test then never has to drive the clock by hand, and the clock still
   * moves monotonically to real deadlines rather than by the sum of concurrent sleeps.
   */
  readonly autoAdvance?: boolean;
}

interface Sleeper {
  readonly dueAt: number;
  readonly resolve: () => void;
}

export const createVirtualTimer = (options: VirtualTimerOptions = {}): VirtualTimer => {
  let current = options.start ?? 0;
  const autoAdvance = options.autoAdvance ?? false;
  const sleepers: Sleeper[] = [];
  const sleeps: number[] = [];

  const wakeDue = (): void => {
    sleepers.sort((left, right) => left.dueAt - right.dueAt);
    while (sleepers.length > 0 && (sleepers[0] as Sleeper).dueAt <= current) {
      const sleeper = sleepers.shift() as Sleeper;
      sleeper.resolve();
    }
  };

  const advanceToEarliest = (): void => {
    if (sleepers.length === 0) {
      return;
    }
    sleepers.sort((left, right) => left.dueAt - right.dueAt);
    current = Math.max(current, (sleepers[0] as Sleeper).dueAt);
    wakeDue();
  };

  return {
    get sleeps() {
      return sleeps;
    },
    get pending() {
      return sleepers.length;
    },
    now: () => current,
    sleep: (milliseconds: number) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError(`sleep expects a non-negative number of milliseconds`);
      }
      sleeps.push(milliseconds);
      if (milliseconds === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        sleepers.push({ dueAt: current + milliseconds, resolve });
        if (autoAdvance) {
          queueMicrotask(advanceToEarliest);
        }
      });
    },
    advance: async (milliseconds: number) => {
      current += milliseconds;
      wakeDue();
      // Let whatever the wake-ups unblocked run before returning, so a test can assert on the
      // state the sleepers left behind rather than on a promise that has not settled yet.
      for (let flush = 0; flush < 10; flush += 1) {
        await Promise.resolve();
      }
    },
  };
};

/** A stable, obviously fake integration id for tests that need one. */
export const testIntegrationId = (n = 1): Id =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
