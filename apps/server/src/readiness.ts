/**
 * `/readyz`'s checks (TD-023: "`/readyz` (DB, migrations head, queue)").
 *
 * Each check answers one question and is allowed to be slow only in the way a failure is: the
 * whole report is produced with a deadline, because a readiness probe that hangs is read by an
 * orchestrator as "still deciding" rather than "not ready", and the instance stays in the load
 * balancer while it cannot serve.
 *
 * The migrations check is the one worth explaining. TD-019 makes migrations forward-only and says
 * an application must refuse to start when the database's schema is *newer* than the code — that
 * is a rollback in progress, and the older build cannot know what the newer one changed. The
 * mirror case, a database *older* than the code, is a deployment where `migrate` has not run yet
 * (or is still running): also not ready, but recoverable without redeploying. Both are reported,
 * and they are reported separately because they need different actions.
 */
import { db as dbAdapters } from '@platform/infrastructure';
import type { Database } from './queries/identity-queries.js';
import { appliedMigrations } from './queries/identity-queries.js';
import type { CheckStatus, ReadinessReport } from './routes/ops.js';

export interface ReadinessOptions {
  readonly database: Database;
  /** `null` when this process runs no job runtime (`ROLE=api`). */
  readonly jobsStarted: (() => boolean) | null;
  /**
   * Can this process's dispatcher actually advance an event? `null` when it runs none (`ROLE=api`).
   *
   * TD-023 lists "DB, migrations head, queue" and this is the fourth, added at WP-15a's review
   * because the three did not cover the state the build is actually in: `apps/server` cannot
   * compose the pipeline on its own (no runner transport, Q52; no `IntegrationAuditLog` adapter),
   * so `main.ts` starts an instance whose bus has **no handlers**. Every existing check was `ok`
   * and an orchestrator was told the process was ready to serve a product that could never run a
   * ticket. A boot `warn` is not a readiness signal: nothing reads it, and `/readyz` is what a
   * container platform, a load balancer and an operator all read instead.
   */
  readonly dispatchReady: (() => boolean) | null;
  /** Longest the whole report may take. */
  readonly timeoutMs?: number;
}

export const DEFAULT_READINESS_TIMEOUT_MS = 3_000;

/** Resolves to `fallback` when `promise` has not settled within `ms`. */
const withDeadline = async <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/**
 * Compares the migrations this build ships with those the database has applied.
 *
 * Exported so the comparison can be tested without a database — the interesting cases are a
 * database ahead of the code and one behind it, and neither is convenient to produce for real.
 */
export const migrationStatus = (
  known: readonly string[],
  applied: readonly string[],
): { status: CheckStatus; pending: string[]; unknown: string[] } => {
  const knownSet = new Set(known);
  const appliedSet = new Set(applied);
  const pending = known.filter((name) => !appliedSet.has(name));
  const unknown = applied.filter((name) => !knownSet.has(name));
  return {
    // A database carrying migrations this build does not know is `down`, not `degraded`: serving
    // traffic against a schema the code has never seen is how a rollback corrupts data.
    status: unknown.length > 0 ? 'down' : pending.length > 0 ? 'down' : 'ok',
    pending,
    unknown,
  };
};

export const createReadinessCheck = (
  options: ReadinessOptions,
): (() => Promise<ReadinessReport>) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  return async (): Promise<ReadinessReport> => {
    const checks: Record<string, CheckStatus> = {};

    const applied = await withDeadline(
      appliedMigrations(options.database).then(
        (names) => ({ ok: true as const, names }),
        () => ({ ok: false as const, names: [] as string[] }),
      ),
      timeoutMs,
      { ok: false as const, names: [] as string[] },
    );

    // One query answers both: reaching `platform_migrations` proves the connection works.
    checks.database = applied.ok ? 'ok' : 'down';
    checks.migrations = applied.ok
      ? migrationStatus(
          dbAdapters.loadMigrations().map((migration) => migration.name),
          applied.names,
        ).status
      : 'down';

    if (options.jobsStarted !== null) {
      checks.queue = options.jobsStarted() ? 'ok' : 'down';
    }

    if (options.dispatchReady !== null) {
      checks.dispatch = options.dispatchReady() ? 'ok' : 'down';
    }

    const worst = Object.values(checks).includes('down')
      ? 'down'
      : Object.values(checks).includes('degraded')
        ? 'degraded'
        : 'ok';
    return { status: worst, checks };
  };
};
