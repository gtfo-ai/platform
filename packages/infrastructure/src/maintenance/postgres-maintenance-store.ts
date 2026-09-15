/**
 * `MaintenanceStore` on PostgreSQL — the three reads the maintenance scheduler makes (WP-36).
 *
 * **No table of its own.** The schedule lives in the project's configuration document and the
 * *"has this period's chore been created?"* question is a `tasks` lookup by the platform-issued key
 * (`packages/application/src/maintenance/scheduler.ts` carries the argument, and technical/02:32's
 * `ScheduledJob` line is amended to match). So this adapter reads three things the platform already
 * writes and writes nothing.
 *
 * **`maintenanceSpendSince` is the second query in the platform that sums the ledger for a feature
 * cap**, after `PostgresShadowStore.shadowSpendSince`, and it is deliberately the same shape — now
 * including the second number both of them answer: sum `cost_entries` — the record — rather than
 * `tasks.cost_actual`, which is a running total the workpad job can lag, and add the chore runs of
 * the window the ledger has **not** recorded yet, because it writes from a handler that commits
 * after the run's own transaction (`../cost/pending-run-spend.ts`). What differs is the predicate, and it is the one thing this feature had to
 * decide: the chores this scheduler created, recognised by their reference. `tasks.template` would
 * charge a `chore` ticket a *human* filed to the maintenance cap, and `runs.mode` would too,
 * because a maintenance chore's runs are ordinary delivery runs. `coalesce(sum(...), 0)` — a
 * project whose chores have cost nothing has spent nothing, which is the one place a zero is a
 * measurement rather than an invention.
 *
 * **`staleDependencies` reads `tasks.dependencies` and refuses to report a non-answer as a
 * finding.** WP-38's gate records `metadata.status` per package, and the shipped state with no
 * `APP_DEPENDENCY_REGISTRY_HOSTS` declared is `not_checked` — so the `where` demands `checked`, and
 * a build that asks no registry produces no findings and the scheduler says *"nothing to do"*
 * rather than briefing a run on packages nobody looked up (standing rule 16). `distinct on` keeps
 * one row per package: a dependency added by three tasks is one thing to fix, and the newest task's
 * answer is the one that reflects what the registry last said.
 */
import type {
  CapSpend,
  KbHygieneReport,
  MaintenanceStore,
  StaleDependency,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  ACTIVE_RUN_STATUSES_PARAM,
  PENDING_RUN_WINDOW_SQL,
  pendingRunUsdSql,
  UNLEDGERED_RUN_SQL,
} from '../cost/pending-run-spend.js';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const instant = (value: Date | string): IsoDateTime =>
  (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) as IsoDateTime;

/** The `where` that says *"a chore this platform scheduled"*; see the docblock above. */
const MAINTENANCE_TASK_PREDICATE = "t.ticket_provider = 'platform' and t.ticket_key like 'chore!%'";

interface HealthRow extends Record<string, unknown> {
  readonly commit_sha: string | null;
  readonly documents: number;
  readonly findings: unknown;
  readonly created_at: Date;
}

interface DependencyRow extends Record<string, unknown> {
  readonly ecosystem: string | null;
  readonly name: string | null;
  readonly path: string | null;
  readonly deprecated: boolean | null;
  readonly last_published_at: string | null;
}

export class PostgresMaintenanceStore implements MaintenanceStore {
  async maintenanceSpendSince(
    tx: Transaction,
    projectId: Id,
    since: IsoDateTime,
    reserveUsd: number,
  ): Promise<CapSpend> {
    const { rows } = await sqlOf(tx).query<{ spent_usd: string; pending_usd: string }>(
      // Two numbers for one cap: what the ledger has charged this month's chores, and what their
      // runs have committed that the ledger has not written yet (`../cost/pending-run-spend.ts`).
      `select coalesce((
                select sum(c.usd) from cost_entries c
                  join tasks t on t.id = c.task_id
                 where c.project_id = $1 and ${MAINTENANCE_TASK_PREDICATE} and c.created_at >= $2
              ), 0)::text as spent_usd,
              coalesce((
                select sum(${pendingRunUsdSql('$3', '$4')})
                  from runs r
                  join tasks t on t.id = r.task_id
                 where r.project_id = $1 and ${MAINTENANCE_TASK_PREDICATE}
                   and ${UNLEDGERED_RUN_SQL} and ${PENDING_RUN_WINDOW_SQL('$2')}
              ), 0)::text as pending_usd`,
      [projectId, since, [...ACTIVE_RUN_STATUSES_PARAM], reserveUsd],
    );
    const row = rows[0];
    return {
      spentUsd: Number(row?.spent_usd ?? 0),
      pendingUsd: Number(row?.pending_usd ?? 0),
    };
  }

  async latestKbHygiene(tx: Transaction, projectId: Id): Promise<KbHygieneReport | null> {
    const { rows } = await sqlOf(tx).query<HealthRow>(
      `select commit_sha, documents, findings, created_at
         from kb_health_reports
        where project_id = $1
        order by created_at desc
        limit 1`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    /**
     * The findings are whatever the hygiene pass wrote, and every string in them is repository text
     * (a page's path, an expiry the page declared). They are bounded again on the way into the
     * brief rather than trusted here, because this is a read of a column the platform wrote from
     * somebody else's words — the same position `ticket_snapshot` takes.
     */
    const findings = Array.isArray(row.findings) ? row.findings : [];
    return {
      commitSha: row.commit_sha,
      documents: Number(row.documents ?? 0),
      createdAt: instant(row.created_at),
      findings: findings.flatMap((entry) => {
        const finding = entry as { kind?: unknown; path?: unknown; detail?: unknown };
        return typeof finding.kind === 'string' &&
          typeof finding.path === 'string' &&
          typeof finding.detail === 'string'
          ? [{ kind: finding.kind, path: finding.path, detail: finding.detail }]
          : [];
      }),
    };
  }

  async staleDependencies(
    tx: Transaction,
    projectId: Id,
    options: { readonly unreleasedSince: IsoDateTime; readonly limit: number },
  ): Promise<readonly StaleDependency[]> {
    const { rows } = await sqlOf(tx).query<DependencyRow>(
      `select distinct on (d->>'ecosystem', d->>'name')
              d->>'ecosystem' as ecosystem,
              d->>'name' as name,
              d->>'path' as path,
              (d->'metadata'->>'deprecated')::boolean as deprecated,
              d->'metadata'->>'last_published_at' as last_published_at
         from tasks t
         cross join lateral jsonb_array_elements(coalesce(t.dependencies->'added', '[]'::jsonb)) as d
        where t.project_id = $1
          and d->'metadata'->>'status' = 'checked'
          and (
            (d->'metadata'->>'deprecated')::boolean is true
            or (
              d->'metadata'->>'last_published_at' is not null
              and (d->'metadata'->>'last_published_at')::timestamptz < $2::timestamptz
            )
          )
        order by d->>'ecosystem', d->>'name', t.created_at desc
        limit $3`,
      [projectId, options.unreleasedSince, options.limit],
    );
    return rows.flatMap((row) =>
      row.ecosystem === null || row.name === null || row.path === null
        ? []
        : [
            {
              ecosystem: row.ecosystem,
              name: row.name,
              path: row.path,
              deprecated: row.deprecated === true,
              lastPublishedAt:
                row.last_published_at === null ? null : instant(row.last_published_at),
            } satisfies StaleDependency,
          ],
    );
  }
}
