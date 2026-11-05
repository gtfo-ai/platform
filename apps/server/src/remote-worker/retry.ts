/**
 * **Retries with jitter, until self-termination** — TD-031 decisions 2 and 9.
 *
 * A worker retries every call that failed **transiently** (no answer, `5xx`, `429`, an answer that
 * did not parse) with jittered exponential backoff, and stops retrying the moment the caller says
 * the run is no longer worth retrying for — for a run-scoped call that is self-termination:
 * `TTL − ½·renew` on the monotonic clock since the last successful renewal, after which the worker
 * pushes nothing (the sweep owns the row, and acts only after the skew grace). A refusal that is not
 * transient (`lease_lost`, `401`, `410`, `426`, a `4xx`) is thrown at once: retrying an answered
 * question repeats the answer.
 *
 * The idempotency that makes a retry safe is the core's: transcript by `(run_id, seq)`, tools by
 * `(run_id, tool_use_id)`, `finish` by `(run_id, epoch)`, `spawn` by the claim.
 */
import { isTransient } from './core-client.js';

/** The first backoff and its cap, in milliseconds. */
export const RETRY_BASE_MS = 500;
export const RETRY_MAX_MS = 15_000;

/** A run's self-termination bound: `TTL − ½·renew` (TD-031 §2), 585 s for a remote run. */
export const selfTerminationMsOf = (leaseTtlMs: number, renewMs: number): number =>
  leaseTtlMs - renewMs / 2;

/** The `n`-th backoff (from 0), with full jitter over its upper half. */
export const backoffMs = (
  attempt: number,
  random: () => number = Math.random,
  base: number = RETRY_BASE_MS,
  max: number = RETRY_MAX_MS,
): number => {
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 20));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
};

export class RetriesExhaustedError extends Error {
  override readonly name = 'RetriesExhaustedError';
  readonly attempts: number;
  constructor(cause: unknown, attempts: number) {
    super(
      `gave up after ${attempts} attempts: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.attempts = attempts;
  }
}

export interface RetryOptions {
  /** `true` once retrying no longer serves anything — self-termination, or the process stopping. */
  readonly giveUp: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Called before each wait, for the log. */
  readonly onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
}

export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * `call()` until it answers, a non-transient error is thrown, or `giveUp()` — the last two throw
 * (a give-up as {@link RetriesExhaustedError} carrying the last transient failure).
 */
export const retrying = async <T>(call: () => Promise<T>, options: RetryOptions): Promise<T> => {
  const sleep = options.sleep ?? sleepMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error)) throw error;
      if (options.giveUp()) throw new RetriesExhaustedError(error, attempt + 1);
      const wait = backoffMs(attempt, options.random);
      options.onRetry?.(error, attempt + 1, wait);
      await sleep(wait);
      if (options.giveUp()) throw new RetriesExhaustedError(error, attempt + 1);
    }
  }
};
