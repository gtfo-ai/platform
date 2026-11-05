/**
 * A project's execution settings and the instance's server claimant — the statements behind
 * `GET/PUT /api/projects/:id/execution` (WP-278, TD-031 decision 8, migration 0097).
 *
 * `project_execution_settings` has one writer, {@link writeProjectExecution}: an upsert keyed by the
 * project that answers the row it replaced (or `null`, the defaults), so the audit row says what
 * changed. The project row is locked `for share` first, so a project deleted meanwhile is a
 * `not_found` rather than a foreign-key error.
 */
import type { ExecutionSettings } from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { eq, gt, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

const { projectExecutionSettings, projects, serverClaimants } = dbAdapters.schema;

const toSettings = (row: typeof projectExecutionSettings.$inferSelect): ExecutionSettings => ({
  mode: row.mode,
  prefer: row.prefer,
  fallbackAfterSeconds: row.fallbackAfterSeconds,
  assigneeWindowSeconds: row.assigneeWindowSeconds,
  offerTimeoutSeconds: row.offerTimeoutSeconds,
});

/** The stored settings, or `null` when none is stored (the defaults apply). */
export const findProjectExecution = async (
  database: Pick<Database, 'select'>,
  projectId: string,
): Promise<ExecutionSettings | null> => {
  const rows = await database
    .select()
    .from(projectExecutionSettings)
    .where(eq(projectExecutionSettings.projectId, projectId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toSettings(row);
};

export type ExecutionWrite =
  | { readonly status: 'written'; readonly before: ExecutionSettings | null }
  | { readonly status: 'not_found' };

/** Replaces the project's settings; answers what they were before (`null`: the defaults). */
export const writeProjectExecution = async (
  database: Database,
  projectId: string,
  settings: ExecutionSettings,
): Promise<ExecutionWrite> =>
  database.transaction(async (tx) => {
    const found = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('share');
    if (found.length === 0) return { status: 'not_found' };
    const before = await tx
      .select()
      .from(projectExecutionSettings)
      .where(eq(projectExecutionSettings.projectId, projectId))
      .for('update');
    const values = {
      mode: settings.mode,
      prefer: settings.prefer,
      fallbackAfterSeconds: settings.fallbackAfterSeconds,
      assigneeWindowSeconds: settings.assigneeWindowSeconds,
      offerTimeoutSeconds: settings.offerTimeoutSeconds,
      updatedAt: sql`now()`,
    };
    await tx
      .insert(projectExecutionSettings)
      .values({ projectId, ...values })
      .onConflictDoUpdate({ target: projectExecutionSettings.projectId, set: values });
    const previous = before[0];
    return { status: 'written', before: previous === undefined ? null : toSettings(previous) };
  });

/** Whether any process holds a fresh `server_claimants` row, on the database's clock. */
export const serverClaimantRunning = async (
  database: Pick<Database, 'select'>,
): Promise<boolean> => {
  const rows = await database
    .select({ holder: serverClaimants.holder })
    .from(serverClaimants)
    .where(gt(serverClaimants.expiresAt, sql`now()`))
    .limit(1);
  return rows.length > 0;
};

/**
 * Whether this project's runs are **closed to remote workers by its run credential** (WP-283,
 * TD-031 decision 5, Q124 (a)): a live git binding whose integration gives runs a static token or a
 * deploy key and does not set `remote_run_credential: allow` — the claim's own clause
 * (`postgres-run-offers.ts`'s `WORKER_ELIGIBLE`), read for the execution setting to say why.
 */
export const remoteRunCredentialRefused = async (
  database: Pick<Database, 'execute'>,
  projectId: string,
): Promise<boolean> => {
  const result = await database.execute<{ refused: boolean }>(sql`
    select exists (
      select 1
        from bindings b
        join integrations i on i.id = b.integration_id
       where b.project_id = ${projectId}
         and i.type = 'git'
         and i.retired_at is null
         and coalesce(i.config ->> 'run_credential', 'minted') <> 'minted'
         and coalesce(i.config ->> 'remote_run_credential', 'deny') <> 'allow'
    ) as refused`);
  return result.rows[0]?.refused === true;
};
