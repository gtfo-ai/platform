/**
 * The per-integration rate limiter the outbound executor spends its calls through — technical/06
 * § "Outbound: actions", product/08 § "Rate limits" ("back off on 429 with `Retry-After`;
 * per-provider concurrency caps").
 *
 * A token bucket plus a concurrency gate, both driven by an injected `IntegrationTimer`, because
 * a rate-limit test that waits on the wall clock asserts something about the machine rather than
 * about the program (and CI is a 2-core runner).
 *
 * ## Shared quantities, written down
 *
 * Everything here is a quantity shared by every caller of one limiter, which is exactly the kind
 * of thing that gets shared by accident:
 *
 *  - **tokens** — the burst budget. Shared across actions on purpose: a provider quota is per
 *    account, not per endpoint, so a flood of comments must slow transitions down too.
 *  - **the concurrency slot** — held from the moment a caller starts waiting for a token until it
 *    releases, not just during the HTTP call. That is stricter than "cap the in-flight requests",
 *    deliberately: it stops a hundred waiters from all firing the instant the bucket refills. A
 *    holder must therefore never `acquire` a second slot of the same limiter before releasing its
 *    first; the executor guarantees that for a call nested in another's `perform` (backlog 550).
 *  - **`blockedUntil`** — set by `penalise` from a provider's `Retry-After`. It applies to the
 *    whole limiter, because a 429 is the account's, not the request's.
 *  - **`active`** — the number of held slots. A lease releases at most once (a second `release()`
 *    is a no-op), because a double release would hand out one slot too many, for ever.
 *
 * **A waiting caller has no deadline, and that is decided** (PROGRESS backlog 550). A wait ends
 * when a holder releases, so it is bounded by the holders: a holder spends its slot on a provider
 * request, which every shipped adapter's transport bounds with its own request timeout, plus the
 * retry and `Retry-After` sleeps between attempts. The one way a holder waited on *another waiter*
 * — a `perform` acquiring a second slot of the same limiter, which deadlocked at `maxConcurrent`
 * concurrent callers — is removed in the executor, which runs such a call under the outer lease
 * (`action-executor.ts`, the module docblock's last section). A deadline here would not have fixed
 * that either: it would have turned the hang into failed jobs, and it would fail a legitimate wait
 * behind a long `Retry-After` the same way, which is a queue turned into escalated tasks.
 *
 * The limiter is scoped by the executor to one `integrations.id`, not to a provider name: two
 * bindings of one provider are two accounts with two quotas. A provider whose quota really is
 * shared across bindings (one Jira site behind two projects) is a provider-level decision that
 * belongs in the executor's `rateLimits` resolver, where it can be seen.
 */
import type { IntegrationTimer } from '../ports/integrations/audit.js';

export interface RateLimitPolicy {
  /** Burst size: how many calls may go out back-to-back after an idle period. */
  readonly capacity: number;
  /** Sustained rate. Must be > 0, or the bucket could never refill. */
  readonly refillPerSecond: number;
  /** How many calls may be in flight (or waiting for a token) at once. */
  readonly maxConcurrent: number;
}

/**
 * A deliberately cautious default for a provider nobody has measured yet.
 *
 * Jira Cloud's cost-based limits, GitLab's 2000 requests/minute/user and Slack's per-method tiers
 * are all more generous than this; a provider that knows its own budget declares its own policy,
 * and the pipeline's executor reads it through `pipelineRateLimitPolicy`
 * (`packages/integrations/src/bindings/shipped-registry.ts`, backlog 550) — before that nothing
 * passed it, whatever the registration said. Being slower than the provider allows costs latency; being faster
 * costs a 429 storm and, on Slack, a warning about the app's behaviour.
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  capacity: 10,
  refillPerSecond: 5,
  maxConcurrent: 4,
};

/** A held concurrency slot. `release` is idempotent. */
export interface RateLimitLease {
  release(): void;
}

export interface RateLimiterSnapshot {
  readonly tokens: number;
  readonly active: number;
  readonly waiting: number;
  /** Milliseconds until the penalty from the last 429 expires; 0 when there is none. */
  readonly blockedForMs: number;
}

/** What {@link RateLimiter.tryAcquire} answers: a token taken, or how long until one would be. */
export type RateLimitAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterMs: number };

export interface RateLimiter {
  /** Resolves when a concurrency slot **and** a token are available. */
  acquire(): Promise<RateLimitLease>;
  /**
   * Takes a token **now or not at all** (WP-87) — the webhook door's question, which answers a
   * caller `429` with `Retry-After` instead of holding its request open. It takes no concurrency
   * slot (a delivery holds nothing across its own handling that a slot would bound) and it does not
   * queue, so it is for a limiter nobody `acquire`s: mixing the two would let this jump the FIFO
   * `acquire` keeps. `retryAfterMs` is at least 1 and counts a penalty as well as the refill.
   */
  tryAcquire(): RateLimitAttempt;
  /** A provider said "not before then" — usually `Retry-After` on a 429. */
  penalise(milliseconds: number): void;
  snapshot(): RateLimiterSnapshot;
}

const assertPolicy = (policy: RateLimitPolicy): void => {
  if (!Number.isFinite(policy.capacity) || policy.capacity < 1) {
    throw new TypeError(`rate limit capacity must be at least 1, got ${policy.capacity}`);
  }
  if (!Number.isFinite(policy.refillPerSecond) || policy.refillPerSecond <= 0) {
    throw new TypeError(
      `rate limit refillPerSecond must be greater than 0, got ${policy.refillPerSecond}`,
    );
  }
  if (!Number.isFinite(policy.maxConcurrent) || policy.maxConcurrent < 1) {
    throw new TypeError(`rate limit maxConcurrent must be at least 1, got ${policy.maxConcurrent}`);
  }
};

export const createRateLimiter = (
  policy: RateLimitPolicy,
  timer: IntegrationTimer,
): RateLimiter => {
  assertPolicy(policy);

  let tokens = policy.capacity;
  let lastRefillAt = timer.now();
  let blockedUntil = 0;
  let active = 0;
  const waiting: (() => void)[] = [];

  const refill = (): void => {
    const now = timer.now();
    const elapsedMs = Math.max(0, now - lastRefillAt);
    lastRefillAt = now;
    if (elapsedMs === 0) {
      return;
    }
    tokens = Math.min(policy.capacity, tokens + (elapsedMs / 1000) * policy.refillPerSecond);
  };

  /** Milliseconds until the bucket holds a whole token again. */
  const msUntilToken = (): number =>
    tokens >= 1 ? 0 : Math.ceil(((1 - tokens) / policy.refillPerSecond) * 1000);

  const enterQueue = (): Promise<void> => {
    // FIFO even when a slot is free: skipping the queue would starve the caller that has been
    // waiting longest, and a starved comment is a task that never finishes.
    if (active < policy.maxConcurrent && waiting.length === 0) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const releaseSlot = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next !== undefined) {
      next();
    }
  };

  const acquire = async (): Promise<RateLimitLease> => {
    await enterQueue();
    let released = false;
    const lease: RateLimitLease = {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        releaseSlot();
      },
    };

    try {
      for (;;) {
        refill();
        const penaltyMs = Math.max(0, blockedUntil - timer.now());
        const waitMs = Math.max(penaltyMs, msUntilToken());
        if (waitMs <= 0) {
          break;
        }
        await timer.sleep(waitMs);
      }
    } catch (error) {
      // A timer that throws (a cancelled virtual clock, a stopped runtime) must not leak the slot.
      lease.release();
      throw error;
    }

    tokens -= 1;
    return lease;
  };

  const tryAcquire = (): RateLimitAttempt => {
    refill();
    const waitMs = Math.max(Math.max(0, blockedUntil - timer.now()), msUntilToken());
    if (waitMs > 0) {
      return { ok: false, retryAfterMs: Math.max(1, waitMs) };
    }
    tokens -= 1;
    return { ok: true };
  };

  return {
    acquire,
    tryAcquire,
    penalise: (milliseconds: number) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError(`penalty must be a non-negative number of milliseconds`);
      }
      blockedUntil = Math.max(blockedUntil, timer.now() + milliseconds);
    },
    snapshot: () => {
      refill();
      return {
        tokens,
        active,
        waiting: waiting.length,
        blockedForMs: Math.max(0, blockedUntil - timer.now()),
      };
    },
  };
};
