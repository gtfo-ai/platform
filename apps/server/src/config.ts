/**
 * The server's configuration, parsed with zod at boot (TD-023: "single `config.ts` parsed with
 * zod 4 at boot (fail fast)").
 *
 * Three rules the shape follows:
 *
 * 1. **Fail fast, and never partially.** `loadServerConfig` either returns a whole, validated
 *    configuration or throws one error naming every offending variable. Nothing downstream reads
 *    `process.env`, so there is no way to end up half-configured — a process that starts is a
 *    process whose configuration parsed.
 * 2. **Secrets take a `_FILE` variant** (Docker secrets convention, TD-020), resolved first, and
 *    `APP_SECRET_KEY` has no default in any environment. A development default would be a real
 *    secret in the repository the day someone shipped with it.
 * 3. **The database, dispatcher and jobs halves are the loaders `packages/infrastructure` already
 *    owns**, so `.env.example` has one description per variable and this file adds only what the
 *    HTTP process itself needs.
 */
import process from 'node:process';
import { CONNECTIONS_PER_DISPATCH } from '@platform/application';
import { db, eventing, jobs } from '@platform/infrastructure';
import * as z from 'zod';
import { ROLES, roleCapabilities } from './role.js';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Field name -> the environment variable it comes from, so an error names what to fix. */
const SOURCE_VARIABLE: Record<string, string> = {
  role: 'ROLE',
  port: 'PORT',
  host: 'HOST',
  baseUrl: 'APP_BASE_URL',
  secretKey: 'APP_SECRET_KEY',
  logLevel: 'LOG_LEVEL',
  logFormat: 'LOG_FORMAT',
  timezone: 'TZ',
  allowSignUp: 'APP_ALLOW_SIGNUP',
  bootstrapAdminEmail: 'APP_BOOTSTRAP_ADMIN_EMAIL',
  bootstrapAdminName: 'APP_BOOTSTRAP_ADMIN_NAME',
  bootstrapAdminPassword: 'APP_BOOTSTRAP_ADMIN_PASSWORD',
  sessionTtlDays: 'APP_SESSION_TTL_DAYS',
  metricsUsername: 'APP_METRICS_USERNAME',
  metricsPassword: 'APP_METRICS_PASSWORD',
  sseBufferSize: 'APP_SSE_BUFFER_SIZE',
  sseMaxQueuedFrames: 'APP_SSE_MAX_QUEUED_FRAMES',
  sseMaxTopics: 'APP_SSE_MAX_TOPICS',
  sseMaxBufferedTopics: 'APP_SSE_MAX_BUFFERED_TOPICS',
  ssePingIntervalMs: 'APP_SSE_PING_INTERVAL_MS',
  sseRetryMs: 'APP_SSE_RETRY_MS',
  sseMaxConnections: 'APP_SSE_MAX_CONNECTIONS',
  sseShutdownDrainMs: 'APP_SSE_SHUTDOWN_DRAIN_MS',
  shutdownTimeoutMs: 'APP_SHUTDOWN_TIMEOUT_MS',
  bodyLimitBytes: 'APP_HTTP_BODY_LIMIT_BYTES',
  trustProxy: 'APP_TRUST_PROXY',
};

/**
 * Argon2id, at the OWASP parameters TD-022 names. They are configuration rather than constants
 * because the right cost depends on the host, and a self-hoster on small hardware who cannot
 * afford 19 MiB per login needs a knob that is not a fork.
 */
export const argon2ConfigSchema = z.strictObject({
  memoryCostKib: z.int().min(8_192).max(1_048_576),
  timeCost: z.int().min(2).max(16),
  parallelism: z.int().min(1).max(16),
});

export type Argon2Config = z.infer<typeof argon2ConfigSchema>;

const serverConfigFields = z.strictObject({
  /** Which workloads this process runs (technical/01: one image, `ROLE` splits it). */
  role: z.enum(ROLES),
  port: z.int().min(0).max(65_535),
  host: z.string().min(1),
  /**
   * Absolute origin the instance is reached on.
   *
   * It decides three things that all break quietly if it is wrong: the session cookie's `Secure`
   * attribute and `__Host-` prefix, the one trusted origin the CSRF check accepts, and the `servers`
   * entry of the generated OpenAPI document. `z.url()` alone accepts `localhost:8080` — it reads
   * `localhost:` as a scheme — so the protocol is checked explicitly.
   */
  baseUrl: z
    .url()
    .refine(
      (value) => ['http:', 'https:'].includes(new URL(value).protocol),
      'must be an absolute http:// or https:// URL, e.g. https://agentic.example.com',
    ),
  /** Session signing and secret encryption at rest (TD-023). No default, ever. */
  secretKey: z
    .string()
    .min(
      32,
      'must be at least 32 characters (generate one with `openssl rand -base64 48`); there is no default',
    ),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  logFormat: z.enum(['json', 'pretty']),
  /** IANA zone; the cron schedules and the working calendar are read in it, never in the host's. */
  timezone: z.string().min(1),

  /** Open registration. Off by default: a self-hosted instance on the internet is not a sign-up page. */
  allowSignUp: z.boolean(),
  /** When set and no user exists yet, this account is created as `admin` at boot. */
  bootstrapAdminEmail: z.email().nullable(),
  bootstrapAdminName: z.string().min(1),
  bootstrapAdminPassword: z.string().min(12).nullable(),
  sessionTtlDays: z.int().min(1).max(365),

  /** Optional basic auth on `/metrics` (TD-023). Both halves or neither. */
  metricsUsername: z.string().nullable(),
  metricsPassword: z.string().nullable(),

  /** Frames kept per SSE topic for replay after a reconnect (TD-014's ring buffer). */
  sseBufferSize: z.int().min(1).max(10_000),
  /**
   * How far one stream's write queue may grow past the depth it opened at before that client is
   * treated as a stalled reader and dropped. Separate from the buffer size on purpose, and
   * measured as growth rather than depth — see `sse/hub.ts`.
   */
  sseMaxQueuedFrames: z.int().min(1).max(100_000),
  /** Topics one stream may carry; it bounds the largest replay a reconnect can ask for. */
  sseMaxTopics: z.int().min(1).max(1_000),
  /** Topics whose replay buffer is retained, least-recently-published evicted first. */
  sseMaxBufferedTopics: z.int().min(1).max(1_000_000),
  /** `: ping` comment interval; technical/08 says 20 s. */
  ssePingIntervalMs: z.int().min(1_000).max(600_000),
  /** The `retry:` field sent to the client; technical/08 says 1000 ms. */
  sseRetryMs: z.int().min(100).max(600_000),
  /** Hard cap on concurrent streams, so a client loop cannot exhaust the process's sockets. */
  sseMaxConnections: z.int().min(1).max(100_000),
  /** How long shutdown waits for one stream's queue to reach the socket before abandoning it. */
  sseShutdownDrainMs: z.int().min(10).max(600_000),

  shutdownTimeoutMs: z.int().min(100).max(600_000),
  bodyLimitBytes: z
    .int()
    .min(1_024)
    .max(64 * 1_024 * 1_024),
  /** Behind a reverse proxy (technical/01's optional caddy), so `X-Forwarded-*` is honoured. */
  trustProxy: z.boolean(),

  argon2: argon2ConfigSchema,
  database: db.databaseConfigSchema,
  dispatch: eventing.dispatchConfigSchema,
  jobs: jobs.jobsConfigSchema,
});

/**
 * The SSE drain is one *step inside* the graceful shutdown, not a budget beside it.
 *
 * `preClose` waits up to `APP_SSE_SHUTDOWN_DRAIN_MS` for the slowest stream, and everything behind
 * it — the dispatcher's own drain, pg-boss, the pool — has to finish inside what is left of
 * `APP_SHUTDOWN_TIMEOUT_MS`. Both fields accept up to 600 000 independently, so they could be set
 * equal (or the drain set longer) and the outer bound would stop being a bound at all: the SSE
 * step alone would consume it and the process would be killed by whatever supervises it, mid-step,
 * with the jobs half never drained. That is exactly the failure bounding the drain was added to
 * prevent, one level up.
 */
export const serverConfigSchema = serverConfigFields.refine(
  (config) => config.sseShutdownDrainMs < config.shutdownTimeoutMs,
  {
    message:
      'must be less than APP_SHUTDOWN_TIMEOUT_MS: the SSE drain is one step inside the graceful shutdown, and the steps behind it (dispatch drain, jobs, the pool) need what is left of that budget',
    path: ['sseShutdownDrainMs'],
  },
);

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const SERVER_CONFIG_DEFAULTS = {
  role: 'all',
  port: 8080,
  host: '0.0.0.0',
  baseUrl: 'http://localhost:8080',
  logLevel: 'info',
  logFormat: 'json',
  timezone: 'UTC',
  allowSignUp: false,
  bootstrapAdminName: 'Administrator',
  sessionTtlDays: 7,
  sseBufferSize: 256,
  sseMaxQueuedFrames: 512,
  sseMaxTopics: 64,
  sseMaxBufferedTopics: 1_024,
  ssePingIntervalMs: 20_000,
  sseRetryMs: 1_000,
  sseMaxConnections: 1_000,
  sseShutdownDrainMs: 5_000,
  shutdownTimeoutMs: 30_000,
  bodyLimitBytes: 1_048_576,
  trustProxy: false,
  argon2: { memoryCostKib: 19_456, timeCost: 2, parallelism: 1 },
} as const;

/**
 * The connections this process needs beyond the dispatcher's own floor.
 *
 * `createEventing` refuses a pool smaller than `2 × APP_DISPATCH_MAX_CONCURRENCY + 1`, and says in
 * its own message that this is "the floor for the dispatcher alone". It is: pg-boss runs its
 * workers, its supervision passes and the partition-maintenance cron **on the same pool**, and the
 * HTTP layer serves every request query from it too. A pool sized at exactly the dispatcher's
 * floor therefore starts, passes that check, and then stalls the first time a request and a sweep
 * want a connection at the same time — with `APP_DB_CONNECTION_TIMEOUT_MS` turning it into request
 * failures rather than a hang, which is better but still an outage.
 *
 * So the composition root adds its own floor on top, per workload it actually starts.
 */
export const POOL_RESERVATIONS = {
  /** pg-boss's workers, supervision and cron. */
  jobs: 2,
  /** Concurrent HTTP request queries — a floor, not a capacity plan. */
  http: 2,
  /** Readiness checks and partition maintenance, which must not queue behind request traffic. */
  maintenance: 1,
  /**
   * The pipeline's two job workers (WP-15b).
   *
   * `pipeline/runtime.ts` states the arithmetic: each `stage.execute` worker holds one connection
   * during each of its two transactions and each review-window worker holds one during each of
   * its two, and the composition root runs one of each (`stageConcurrency: 1`). It is counted here
   * because every `worker` role now composes the pipeline — before WP-15b a process that was not
   * handed an audit sink ran none, so the floor did not have to include it.
   *
   * It is a **flat** term and not a per-dispatch one because both workers make their provider
   * calls *outside* a transaction of their own: `jobs.ts:194` evaluates a gate after its load
   * transaction has closed, and `jobs.ts:306` reads the merge request's discussions after
   * `reviewWindowHandler`'s has. An audit write started from either therefore replaces the
   * worker's connection rather than nesting inside it.
   */
  pipeline: 2,
  /**
   * The audit write a **dispatch** nests inside the handler's transaction (WP-15b).
   *
   * `CONNECTIONS_PER_DISPATCH` is 2 — the dispatcher's own transaction plus the handler's — and
   * that was the whole of it until an outbound provider call started writing an
   * `integration_actions` row. `createPostgresIntegrationAuditLog` opens a transaction of its own
   * (`postgres-unit-of-work.ts` takes a second `pool.connect()`), and three handlers call a
   * provider **from inside `context.scope.tx`**: `saga.ts:215` (the intake default-branch read,
   * after `store.tasks.insert` on the same scope), `workpad.ts:168` and the status mapping beside
   * it. So an in-flight dispatch peaks at **three** connections, not two, and the term is
   * proportional to `APP_DISPATCH_MAX_CONCURRENCY` rather than flat.
   *
   * **This exists because of a defect that is not the pool's**: CLAUDE.md's shape is
   * *transaction / no transaction / transaction*, and a handler holding a pooled connection across
   * provider latency breaks it. The defect is filed; until it is fixed the arithmetic has to
   * describe the code that exists, and when it is, this term goes to 0 rather than being quietly
   * absorbed.
   *
   * **What is not claimed**: no measurement of exhaustion under load exists, and none was taken —
   * generating load on this machine is forbidden (rule 66), and a margin quoted without the load it
   * was measured at is not a number (rule 64). This is arithmetic about the worst case, which is
   * what a start-up refusal should be built on.
   */
  auditPerDispatch: 1,
} as const;

/** The smallest `APP_DB_POOL_MAX` that can serve this configuration's workloads. */
export const requiredPoolConnections = (config: ServerConfig): number => {
  const capabilities = roleCapabilities(config.role);
  // `CONNECTIONS_PER_DISPATCH` rather than a literal 2: `createEventing` enforces its own floor
  // from that constant, and two readings of one number drift apart (standing rule 41).
  const perDispatch = CONNECTIONS_PER_DISPATCH + POOL_RESERVATIONS.auditPerDispatch;
  const dispatcher = capabilities.worker ? perDispatch * config.dispatch.maxConcurrency + 1 : 0;
  const jobsReserve = capabilities.worker ? POOL_RESERVATIONS.jobs : 0;
  const pipelineReserve = capabilities.worker ? POOL_RESERVATIONS.pipeline : 0;
  const httpReserve = capabilities.api ? POOL_RESERVATIONS.http : 0;
  return dispatcher + jobsReserve + pipelineReserve + httpReserve + POOL_RESERVATIONS.maintenance;
};

/** Thrown at boot rather than deadlocking later; see `requiredPoolConnections`. */
export class UndersizedPoolError extends Error {
  readonly poolMax: number;
  readonly required: number;

  constructor(poolMax: number, required: number, role: string) {
    super(
      `APP_DB_POOL_MAX is ${poolMax}, but ROLE=${role} needs at least ${required} connections: every in-flight dispatch holds three at once (its own transaction, the handler's, and the audit row an outbound provider call writes from inside the handler's), the sweep needs one to read with, and pg-boss, the pipeline's two job workers, the partition-maintenance cron and every HTTP request query share the same pool. Raise APP_DB_POOL_MAX to ${required} or more, or lower APP_DISPATCH_MAX_CONCURRENCY.`,
    );
    this.name = 'UndersizedPoolError';
    this.poolMax = poolMax;
    this.required = required;
  }
}

/** Reads `NAME`, preferring the contents of the file named by `NAME_FILE`. */
const readSecret = (name: string, env: EnvLike): string | undefined =>
  db.readEnvWithFile(name, env);

/** Leaves anything unparseable in place so the schema reports it against the right variable. */
const numberFromEnv = (raw: string | undefined, fallback: number): unknown => {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
};

/**
 * `z.stringbool()` semantics (TD-023) with an explicit fallback: `true/1/yes/on` and
 * `false/0/no/off`, case-insensitive. Anything else stays a string so the schema rejects it by
 * name rather than being read as `false` — a typo in a security flag must not read as "off".
 */
const booleanFromEnv = (raw: string | undefined, fallback: boolean): unknown => {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') {
    return fallback;
  }
  if (['true', '1', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(value)) {
    return false;
  }
  return value;
};

const nullableString = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  return value === undefined || value === '' ? null : value;
};

export const loadServerConfig = (env: EnvLike = process.env): ServerConfig => {
  const problems: string[] = [];
  const collect = <T>(load: () => T): T | undefined => {
    try {
      return load();
    } catch (error) {
      problems.push((error as Error).message);
      return undefined;
    }
  };

  // The three sub-configurations throw their own one-line errors; collecting them means an
  // operator with two mistakes learns about both, instead of fixing one and restarting to find
  // the next.
  const database = collect(() => db.loadDatabaseConfig(env));
  const dispatch = collect(() => eventing.loadDispatchConfig(env));
  const jobsConfig = collect(() => jobs.loadJobsConfig(env));

  const result = serverConfigSchema.safeParse({
    role: env.ROLE?.trim() || SERVER_CONFIG_DEFAULTS.role,
    port: numberFromEnv(env.PORT, SERVER_CONFIG_DEFAULTS.port),
    host: env.HOST?.trim() || SERVER_CONFIG_DEFAULTS.host,
    baseUrl: env.APP_BASE_URL?.trim() || SERVER_CONFIG_DEFAULTS.baseUrl,
    secretKey: readSecret('APP_SECRET_KEY', env) ?? '',
    logLevel: env.LOG_LEVEL?.trim() || SERVER_CONFIG_DEFAULTS.logLevel,
    logFormat: env.LOG_FORMAT?.trim() || SERVER_CONFIG_DEFAULTS.logFormat,
    timezone: env.TZ?.trim() || SERVER_CONFIG_DEFAULTS.timezone,

    allowSignUp: booleanFromEnv(env.APP_ALLOW_SIGNUP, SERVER_CONFIG_DEFAULTS.allowSignUp),
    bootstrapAdminEmail: nullableString(env.APP_BOOTSTRAP_ADMIN_EMAIL),
    bootstrapAdminName:
      env.APP_BOOTSTRAP_ADMIN_NAME?.trim() || SERVER_CONFIG_DEFAULTS.bootstrapAdminName,
    bootstrapAdminPassword: nullableString(readSecret('APP_BOOTSTRAP_ADMIN_PASSWORD', env)),
    sessionTtlDays: numberFromEnv(env.APP_SESSION_TTL_DAYS, SERVER_CONFIG_DEFAULTS.sessionTtlDays),

    metricsUsername: nullableString(env.APP_METRICS_USERNAME),
    metricsPassword: nullableString(readSecret('APP_METRICS_PASSWORD', env)),

    sseBufferSize: numberFromEnv(env.APP_SSE_BUFFER_SIZE, SERVER_CONFIG_DEFAULTS.sseBufferSize),
    sseMaxQueuedFrames: numberFromEnv(
      env.APP_SSE_MAX_QUEUED_FRAMES,
      SERVER_CONFIG_DEFAULTS.sseMaxQueuedFrames,
    ),
    sseMaxTopics: numberFromEnv(env.APP_SSE_MAX_TOPICS, SERVER_CONFIG_DEFAULTS.sseMaxTopics),
    sseMaxBufferedTopics: numberFromEnv(
      env.APP_SSE_MAX_BUFFERED_TOPICS,
      SERVER_CONFIG_DEFAULTS.sseMaxBufferedTopics,
    ),
    ssePingIntervalMs: numberFromEnv(
      env.APP_SSE_PING_INTERVAL_MS,
      SERVER_CONFIG_DEFAULTS.ssePingIntervalMs,
    ),
    sseRetryMs: numberFromEnv(env.APP_SSE_RETRY_MS, SERVER_CONFIG_DEFAULTS.sseRetryMs),
    sseMaxConnections: numberFromEnv(
      env.APP_SSE_MAX_CONNECTIONS,
      SERVER_CONFIG_DEFAULTS.sseMaxConnections,
    ),
    sseShutdownDrainMs: numberFromEnv(
      env.APP_SSE_SHUTDOWN_DRAIN_MS,
      SERVER_CONFIG_DEFAULTS.sseShutdownDrainMs,
    ),

    shutdownTimeoutMs: numberFromEnv(
      env.APP_SHUTDOWN_TIMEOUT_MS,
      SERVER_CONFIG_DEFAULTS.shutdownTimeoutMs,
    ),
    bodyLimitBytes: numberFromEnv(
      env.APP_HTTP_BODY_LIMIT_BYTES,
      SERVER_CONFIG_DEFAULTS.bodyLimitBytes,
    ),
    trustProxy: booleanFromEnv(env.APP_TRUST_PROXY, SERVER_CONFIG_DEFAULTS.trustProxy),

    argon2: {
      memoryCostKib: numberFromEnv(
        env.APP_ARGON2_MEMORY_KIB,
        SERVER_CONFIG_DEFAULTS.argon2.memoryCostKib,
      ),
      timeCost: numberFromEnv(env.APP_ARGON2_TIME_COST, SERVER_CONFIG_DEFAULTS.argon2.timeCost),
      parallelism: numberFromEnv(
        env.APP_ARGON2_PARALLELISM,
        SERVER_CONFIG_DEFAULTS.argon2.parallelism,
      ),
    },

    // Placeholders when a sub-loader failed: the schema would report them as missing and bury the
    // real message, so they are filled in and the collected problem is reported instead.
    database: database ?? PLACEHOLDER.database,
    dispatch: dispatch ?? PLACEHOLDER.dispatch,
    jobs: jobsConfig ?? PLACEHOLDER.jobs,
  });

  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = String(issue.path[0] ?? '');
      problems.push(
        SOURCE_VARIABLE[field] === undefined
          ? `${issue.path.join('.')} ${issue.message}`
          : `${SOURCE_VARIABLE[field]} ${issue.message}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`invalid server configuration: ${problems.join('; ')}`, {
      cause: result.success ? undefined : result.error,
    });
  }

  const config = result.data as ServerConfig;

  // Both halves of the metrics credential or neither: a username with no password is an
  // authentication check that always fails, and a password with no username is one that is never
  // applied — the second silently exposes the endpoint the operator meant to close.
  if ((config.metricsUsername === null) !== (config.metricsPassword === null)) {
    throw new Error(
      'invalid server configuration: APP_METRICS_USERNAME and APP_METRICS_PASSWORD must be set together (or both left unset to serve /metrics without authentication)',
    );
  }

  if (config.bootstrapAdminEmail !== null && config.bootstrapAdminPassword === null) {
    throw new Error(
      'invalid server configuration: APP_BOOTSTRAP_ADMIN_EMAIL is set but APP_BOOTSTRAP_ADMIN_PASSWORD (or _FILE) is not; the bootstrap administrator needs a password',
    );
  }

  const required = requiredPoolConnections(config);
  if (config.database.poolMax < required) {
    throw new UndersizedPoolError(config.database.poolMax, required, config.role);
  }

  return config;
};

/**
 * Values used only to keep the schema from reporting a missing sub-object when its own loader has
 * already produced a better error. They are never returned: `loadServerConfig` throws first.
 */
const PLACEHOLDER = {
  database: {
    url: 'postgres://placeholder',
    appRole: '',
    poolMax: 1,
    connectionTimeoutMs: 1_000,
    partitionMonthsAhead: 0,
    transcriptRetentionDays: null,
  },
  dispatch: eventing.DISPATCH_CONFIG_DEFAULTS,
  jobs: jobs.JOBS_CONFIG_DEFAULTS,
} as const;
