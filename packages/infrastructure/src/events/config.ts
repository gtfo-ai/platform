/**
 * Dispatcher configuration from the environment (technical/12, TD-020).
 *
 * Same shape as `db/config.ts`: `APP_*` names, a zod schema, and one error naming every offending
 * variable rather than a serialised `ZodError`. None of these hold a secret, so none take a
 * `_FILE` variant.
 */
import * as z from 'zod';

export type EnvLike = Readonly<Record<string, string | undefined>>;

const SOURCE_VARIABLE: Record<string, string> = {
  batchSize: 'APP_DISPATCH_BATCH_SIZE',
  maxConcurrency: 'APP_DISPATCH_MAX_CONCURRENCY',
  pollIntervalMs: 'APP_DISPATCH_POLL_INTERVAL_MS',
  retryDelayMs: 'APP_DISPATCH_RETRY_DELAY_MS',
  maxRetryDelayMs: 'APP_DISPATCH_MAX_RETRY_DELAY_MS',
  drainTimeoutMs: 'APP_DISPATCH_DRAIN_TIMEOUT_MS',
  broadcastChannel: 'APP_BROADCAST_CHANNEL',
};

export const dispatchConfigSchema = z
  .strictObject({
    /** Events read per sweep. One per stream at most, so this bounds parallel streams, not depth. */
    batchSize: z.int().min(1).max(1000),
    /**
     * Dispatches in flight at once. Each holds **two** pooled connections — the transaction owning
     * the event's queue row, and the handler's running inside it — so `APP_DB_POOL_MAX` must be
     * more than twice this. `createEventing` refuses a combination that cannot work.
     */
    maxConcurrency: z.int().min(1).max(64),
    /**
     * Longest an idle worker waits before sweeping again. This is TD-014's polling fallback: with
     * `NOTIFY` working it is never reached, and without it this is the worst-case latency. Every
     * process arms this timer for itself — it backs up that process's own subscription, so it is
     * never handed to a scheduler or a cron.
     */
    pollIntervalMs: z.int().min(10).max(600_000),
    /** First retry delay after a handler failure; doubled per attempt up to `maxRetryDelayMs`. */
    retryDelayMs: z.int().min(0).max(3_600_000),
    maxRetryDelayMs: z
      .int()
      .min(0)
      .max(24 * 3_600_000),
    /** How long a graceful shutdown waits for in-flight dispatches before reporting them. */
    drainTimeoutMs: z.int().min(0).max(600_000),
    /** `NOTIFY` channel; a bare lower-case identifier, because it is interpolated into `LISTEN`. */
    broadcastChannel: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/, 'expected a bare lower-case SQL identifier'),
  })
  .refine((config) => config.maxRetryDelayMs >= config.retryDelayMs, {
    message: 'APP_DISPATCH_MAX_RETRY_DELAY_MS must be at least APP_DISPATCH_RETRY_DELAY_MS',
    path: ['maxRetryDelayMs'],
  });

export type DispatchConfig = z.infer<typeof dispatchConfigSchema>;

export const DISPATCH_CONFIG_DEFAULTS = {
  batchSize: 32,
  maxConcurrency: 1,
  pollIntervalMs: 1_000,
  retryDelayMs: 5_000,
  maxRetryDelayMs: 300_000,
  drainTimeoutMs: 30_000,
  broadcastChannel: 'platform_broadcast',
} as const satisfies DispatchConfig;

export const loadDispatchConfig = (env: EnvLike = process.env): DispatchConfig => {
  const result = dispatchConfigSchema.safeParse({
    batchSize: numberFromEnv(env.APP_DISPATCH_BATCH_SIZE, DISPATCH_CONFIG_DEFAULTS.batchSize),
    maxConcurrency: numberFromEnv(
      env.APP_DISPATCH_MAX_CONCURRENCY,
      DISPATCH_CONFIG_DEFAULTS.maxConcurrency,
    ),
    pollIntervalMs: numberFromEnv(
      env.APP_DISPATCH_POLL_INTERVAL_MS,
      DISPATCH_CONFIG_DEFAULTS.pollIntervalMs,
    ),
    retryDelayMs: numberFromEnv(
      env.APP_DISPATCH_RETRY_DELAY_MS,
      DISPATCH_CONFIG_DEFAULTS.retryDelayMs,
    ),
    maxRetryDelayMs: numberFromEnv(
      env.APP_DISPATCH_MAX_RETRY_DELAY_MS,
      DISPATCH_CONFIG_DEFAULTS.maxRetryDelayMs,
    ),
    drainTimeoutMs: numberFromEnv(
      env.APP_DISPATCH_DRAIN_TIMEOUT_MS,
      DISPATCH_CONFIG_DEFAULTS.drainTimeoutMs,
    ),
    broadcastChannel:
      env.APP_BROADCAST_CHANNEL?.trim() === undefined || env.APP_BROADCAST_CHANNEL?.trim() === ''
        ? DISPATCH_CONFIG_DEFAULTS.broadcastChannel
        : env.APP_BROADCAST_CHANNEL.trim(),
  });

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const field = String(issue.path[0] ?? '');
      return SOURCE_VARIABLE[field] === undefined
        ? issue.message
        : `${SOURCE_VARIABLE[field]} ${issue.message}`;
    });
    throw new Error(`invalid dispatcher configuration: ${problems.join('; ')}`, {
      cause: result.error,
    });
  }

  return result.data;
};

/** Leaves anything unparseable in place so the schema reports it against the right variable. */
const numberFromEnv = (raw: string | undefined, fallback: number): unknown => {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
};
