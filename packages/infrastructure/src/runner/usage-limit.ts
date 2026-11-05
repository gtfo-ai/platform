/**
 * **A usage limit, read off the SDK stream** — WP-285, TD-031 decision 11, research/17 § 1.
 *
 * A subscription (`CLAUDE_CODE_OAUTH_TOKEN`, every remote worker and a `local`-mode server) has a
 * five-hour and a weekly usage limit. A run that reaches one is **not the task's failure**: it ends
 * `failed` / `rate_limited`, the stage entry is planned once more for another claimant, and the
 * claimant that hit the limit stops claiming until it resets. Three signals say so, each pinned by a
 * golden SDK-stream fixture under `test/fixtures/claude/usage-limit-*.script.jsonl`:
 *
 * | signal | the stream | `resetsAt` |
 * |---|---|---|
 * | `rate_limit_rejected` | `rate_limit_event` with `rate_limit_info.status: "rejected"` | when given |
 * | `credits_required` | `rate_limit_event` with `rate_limit_info.errorCode: "credits_required"` | when given |
 * | `api_status_429` | a `result` with `api_error_status: 429` | never — no reset time is on a result |
 *
 * **What is not known, stated** (`[unverified]`, TODO V-WM1): the unit of `resetsAt` and whether a
 * five-hour or weekly rejection uses `status: "rejected"`. Until a real limit is recorded, the unit
 * is read **by magnitude** ({@link resetsAtOf}): an epoch in seconds is about 1.8 × 10⁹ today and in
 * milliseconds about 1.8 × 10¹², so anything at or above 10¹¹ is milliseconds. A reset that is not in
 * the future, not finite, or more than {@link MAX_RESET_AHEAD_MS} ahead is refused as `null` — the
 * claimant then pauses for its default and the UI says *until about* — rather than trusted.
 *
 * An `allowed` or `allowed_warning` event is **not** a limit: the session goes on. A `429` from an
 * API key (`api` mode) is read the same way — the CLI "fails at once when a standard-speed request
 * gets a 429 that reports a spend limit or exhausted usage credits" (errors.md) — and only the
 * claimant decides what a pause means for it (the server's claimant pauses in `local` mode only).
 */
import type { RunUsageLimit } from '@platform/application';
import type { IsoDateTime } from '@platform/contracts';

/** At or above this a `resetsAt` is read as milliseconds; below it, seconds (see the docblock). */
export const RESETS_AT_MILLISECONDS_FROM = 1e11;

/** The furthest a believable reset can be: a weekly limit plus a day of slack. */
export const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `resetsAt` as an instant, or `null` when it cannot be believed: not a finite positive number, not
 * after `nowMs`, or more than {@link MAX_RESET_AHEAD_MS} after it.
 */
export const resetsAtOf = (value: unknown, nowMs: number): IsoDateTime | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value >= RESETS_AT_MILLISECONDS_FROM ? value : value * 1000;
  if (ms <= nowMs || ms - nowMs > MAX_RESET_AHEAD_MS) return null;
  return new Date(ms).toISOString() as IsoDateTime;
};

/**
 * The limit a message reports, or `null` for every message that reports none. Reads the raw SDK
 * message (a producer's object), so every field is checked before it is used.
 */
export const usageLimitOf = (message: unknown, nowMs: number): RunUsageLimit | null => {
  if (!isRecord(message)) return null;
  if (message['type'] === 'rate_limit_event') {
    const info = message['rate_limit_info'];
    if (!isRecord(info)) return null;
    if (info['errorCode'] === 'credits_required') {
      return { signal: 'credits_required', resetsAt: resetsAtOf(info['resetsAt'], nowMs) };
    }
    if (info['status'] === 'rejected') {
      return { signal: 'rate_limit_rejected', resetsAt: resetsAtOf(info['resetsAt'], nowMs) };
    }
    return null;
  }
  if (message['type'] === 'result' && message['api_error_status'] === 429) {
    return { signal: 'api_status_429', resetsAt: null };
  }
  return null;
};

/**
 * Two reports of one limit, merged: the first signal names it, and a reset time from either is kept
 * (a `rejected` event with a reset is usually followed by a `429` result with none).
 */
export const mergeUsageLimits = (
  first: RunUsageLimit | null,
  next: RunUsageLimit | null,
): RunUsageLimit | null => {
  if (first === null) return next;
  if (next === null) return first;
  return { signal: first.signal, resetsAt: first.resetsAt ?? next.resetsAt };
};
