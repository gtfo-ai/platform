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
 * and they are reported separately because they need different actions. Since WP-272 (TD-032
 * decision 2) a newer schema whose every unknown migration is `additive` is not a refusal: the
 * build serves it and says so as `schema: degraded` with `details.schema: ahead_additive` (200).
 */
import { db as dbAdapters } from '@platform/infrastructure';
import type { Database } from './queries/identity-queries.js';
import { appliedMigrations } from './queries/identity-queries.js';
import type { CheckStatus, ReadinessDetail, ReadinessReport } from './routes/ops.js';

export interface ReadinessOptions {
  readonly database: Database;
  /**
   * `null` when this process holds no job client. Since WP-72 every shipped role holds one —
   * `ROLE=api`'s is the enqueue-only sender — so every role reports `queue`.
   */
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
  /**
   * **Who claims agent runs** (WP-277, TD-031 decision 13; replaces WP-86's `agent_runs`). `null` in
   * a process that holds no job client.
   *
   * `composedHere` is `server` when this process runs the server claimant (a launcher, or the
   * in-process provisioner); `workersConnected` counts remote workers online (0 until WP-281). The
   * line reads `server`, `workers: <n>` or `none` — and `none` is **not** degraded on its own: a
   * `workers_only` core with no worker online, or with no open offer, is a valid state. It is
   * `degraded` (still 200) only when an offer has waited past the bound
   * (`OFFER_UNCLAIMED_AFTER_SECONDS`) with no claimant, and the report names that offer. A failed
   * read is `degraded` with the detail `unknown`, never `ok` (standing rule 16).
   */
  readonly claimants?: {
    readonly composedHere: 'server' | null;
    readonly workersConnected: () => Promise<number>;
    readonly oldestUnclaimedOffer: () => Promise<{
      readonly runId: string;
      readonly offeredAt: string;
      readonly waitedSeconds: number;
    } | null>;
  } | null;
  /**
   * Longest **each** awaited check may take (the migrations read and, where composed, the
   * `claimants` read each get their own deadline), so the whole report is bounded by twice this.
   */
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
 *
 * **It is one of two readers of `platform_migrations`** (PROGRESS backlog 119): the other is
 * `findUnknownMigrations` in `packages/infrastructure/src/db/migrator.ts`, behind
 * `assertSchemaIsKnown`. Since WP-272 both take "ahead" from the one decision, `judgeSchema`
 * (TD-032 decision 2): an unknown row that is `contract` or unclassified refuses a start there and
 * is `migrations: down` here; unknown rows that are **all** `additive` start there and are
 * `migrations: ok` here with `schema: degraded` and `details.schema: ahead_additive` — still 200,
 * because the build was designed to serve that schema, and still visible, because it is the state
 * of a rolled-back build. A pending migration is `down` either way: a migration still running can
 * wait. They read the table with different queries (that one returns nothing when the table does
 * not exist yet; this one's caller throws and reports `database: 'down'`), so a change to what
 * "applied" means has to be made in both.
 */
export const migrationStatus = (
  known: readonly string[],
  applied: readonly dbAdapters.AppliedMigration[],
): {
  status: CheckStatus;
  pending: string[];
  unknown: string[];
  schema: dbAdapters.SchemaVerdict['kind'];
} => {
  const appliedSet = new Set(applied.map((row) => row.name));
  const pending = known.filter((name) => !appliedSet.has(name));
  const verdict = dbAdapters.judgeSchema(known, applied);
  return {
    // A database carrying a non-additive migration this build does not know is `down`, not
    // `degraded`: serving traffic against a schema the code has never seen is how a rollback
    // corrupts data.
    status: verdict.kind === 'ahead' || pending.length > 0 ? 'down' : 'ok',
    pending,
    unknown: verdict.unknown.map((row) => row.name),
    schema: verdict.kind,
  };
};

export const createReadinessCheck = (
  options: ReadinessOptions,
): (() => Promise<ReadinessReport>) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  return async (): Promise<ReadinessReport> => {
    const checks: Record<string, CheckStatus> = {};
    const details: Record<string, ReadinessDetail> = {};

    const none: dbAdapters.AppliedMigration[] = [];
    const applied = await withDeadline(
      appliedMigrations(options.database).then(
        (rows) => ({ ok: true as const, rows }),
        () => ({ ok: false as const, rows: none }),
      ),
      timeoutMs,
      { ok: false as const, rows: none },
    );

    // One query answers both: reaching `platform_migrations` proves the connection works.
    checks.database = applied.ok ? 'ok' : 'down';
    if (applied.ok) {
      const migrations = migrationStatus(
        dbAdapters.loadMigrations().map((migration) => migration.name),
        applied.rows,
      );
      checks.migrations = migrations.status;
      // TD-032 decision 2: an all-additive future is served, and said (WP-272).
      if (migrations.schema === 'ahead_additive') {
        checks.schema = 'degraded';
        details.schema = 'ahead_additive';
      }
    } else {
      checks.migrations = 'down';
    }

    if (options.jobsStarted !== null) {
      checks.queue = options.jobsStarted() ? 'ok' : 'down';
    }

    if (options.dispatchReady !== null) {
      checks.dispatch = options.dispatchReady() ? 'ok' : 'down';
    }

    const claimants = options.claimants ?? null;
    let claimantsLine: ReadinessReport['claimants'];
    let unclaimed: ReadinessReport['oldest_unclaimed_offer'];
    if (claimants !== null) {
      const read = await withDeadline(
        Promise.all([claimants.workersConnected(), claimants.oldestUnclaimedOffer()]).then(
          ([workers, oldest]) => ({ ok: true as const, workers, oldest }),
          () => ({ ok: false as const }),
        ),
        timeoutMs,
        { ok: false as const },
      );
      if (!read.ok) {
        checks.claimants = 'degraded';
        details.claimants = 'unknown';
      } else {
        claimantsLine =
          claimants.composedHere ?? (read.workers > 0 ? `workers: ${read.workers}` : 'none');
        if (claimantsLine === 'none' && read.oldest !== null) {
          checks.claimants = 'degraded';
          details.claimants = 'unclaimed';
          unclaimed = {
            run_id: read.oldest.runId,
            offered_at: read.oldest.offeredAt,
            waited_seconds: read.oldest.waitedSeconds,
          };
        } else {
          checks.claimants = 'ok';
        }
      }
    }

    const worst = Object.values(checks).includes('down')
      ? 'down'
      : Object.values(checks).includes('degraded')
        ? 'degraded'
        : 'ok';
    return {
      status: worst,
      checks,
      ...(Object.keys(details).length === 0 ? {} : { details }),
      ...(claimantsLine === undefined ? {} : { claimants: claimantsLine }),
      ...(unclaimed === undefined ? {} : { oldest_unclaimed_offer: unclaimed }),
    };
  };
};
