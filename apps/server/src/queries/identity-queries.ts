/**
 * The handful of reads the composition root needs before any repository exists.
 *
 * The dependency rule (technical/01) puts repositories in `packages/infrastructure` behind ports in
 * `packages/application`. None of those exist yet — WP-15 builds the pipeline's repositories and
 * WP-19 the cost ones — and inventing a port for "does this user hold a membership in this
 * project" would be a port with one caller and no second implementation. `apps/server` is a
 * composition root and may name Drizzle directly, so these live here until there is a repository
 * to move them into; `docs/technical/PROGRESS.md` carries that move as discovered work.
 *
 * Everything here was a **read** until WP-31. Better Auth still owns `users`, `sessions`,
 * `accounts` and `verifications`; what this file now also writes is `user_identities`, the mapping
 * of a **provider account** to a platform user — PROGRESS backlog **79**, the table that has had a
 * reader since WP-15c and no writer at all.
 *
 * It is here rather than behind a port for the reason the rest of this file is: a repository with
 * one caller and no second implementation is a port nobody needs. The reader stays where it is
 * (`createPostgresIdentityDirectory`, behind `InboundIdentityDirectory`), because *that* one has two
 * callers and a fake.
 */
import type { AuditEntry, UserRole, UserSummary } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';

const { configAudit, projectMembers, projects, runs, tasks, users } = dbAdapters.schema;

export type Database = dbAdapters.Database;

/** The four statuses `UserSummary` publishes; anything else in the column is reported as `active`. */
const USER_STATUSES = new Set<UserSummary['status']>(['active', 'invited', 'disabled']);

const asStatus = (value: string): UserSummary['status'] =>
  USER_STATUSES.has(value as UserSummary['status']) ? (value as UserSummary['status']) : 'active';

export interface IdentityRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly status: UserSummary['status'];
  readonly banned: boolean;
}

/** The row behind an authenticated session. `null` when the user was deleted mid-session. */
export const findUserById = async (database: Database, id: string): Promise<IdentityRow | null> => {
  const rows = await database
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  // A ban with an expiry in the past is over. Better Auth applies the same rule at sign-in; it is
  // repeated here because a session issued before the ban is still in the table.
  const banned = row.banned === true && (row.banExpires === null || row.banExpires > new Date());
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: asStatus(row.status),
    banned,
  };
};

/** The user's role in one project, or `null` when they hold no membership in it. */
export const findProjectRole = async (
  database: Database,
  projectId: string,
  userId: string,
): Promise<UserRole | null> => {
  const rows = await database
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
};

export interface ProjectConfigRow {
  readonly config: Record<string, unknown>;
  readonly configSource: Record<string, string>;
  readonly configHash: string | null;
  readonly updatedAt: Date;
}

export const findProjectConfig = async (
  database: Database,
  projectId: string,
): Promise<ProjectConfigRow | null> => {
  const rows = await database
    .select({
      config: projects.config,
      configSource: projects.configSource,
      configHash: projects.configHash,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? null
    : {
        config: row.config as Record<string, unknown>,
        configSource: row.configSource as Record<string, string>,
        configHash: row.configHash,
        updatedAt: row.updatedAt,
      };
};

export interface IdentityMappingRow extends Record<string, unknown> {
  readonly provider: string;
  readonly external_id: string;
  readonly user_id: string;
  readonly display_name: string | null;
  readonly created_at: Date | string;
}

/**
 * Maps a provider account to a platform user — the writer PROGRESS backlog **79** is about (WP-31).
 *
 * An **upsert on the primary key** `(provider, external_id)`, because re-mapping an account to a
 * different person is the operation an operator actually performs when somebody leaves: an insert
 * that refused would leave them deleting a row they cannot see. What it must never be is an upsert
 * on `(provider, user_id)` — one person may hold several accounts of one provider — which is why
 * the conflict target is spelled out rather than left to the table.
 *
 * `email` is deliberately **not** written. It is a column of the table and the only thing that
 * would read it is a match the platform performed itself, which is the one route BD-022 and Q10
 * refuse: a *guessed* identity would then be allowed to answer questions and approve plans. An
 * operator names the account.
 */
export const upsertIdentityMapping = async (
  database: Database,
  input: {
    readonly provider: string;
    readonly externalId: string;
    readonly userId: string;
    readonly displayName: string | null;
  },
): Promise<IdentityMappingRow> => {
  const result = await database.execute<IdentityMappingRow>(sql`
    insert into user_identities (provider, external_id, user_id, display_name)
    values (${input.provider}, ${input.externalId}, ${input.userId}, ${input.displayName})
    on conflict (provider, external_id)
      do update set user_id = excluded.user_id, display_name = excluded.display_name
    returning provider, external_id, user_id, display_name, created_at
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('the identity mapping upsert returned no row');
  }
  return row;
};

/** Every mapping an operator has made, so the screen that writes them can also show them. */
export const listIdentityMappings = async (
  database: Database,
): Promise<readonly IdentityMappingRow[]> => {
  const result = await database.execute<IdentityMappingRow>(sql`
    select provider, external_id, user_id, display_name, created_at
      from user_identities
     order by provider asc, external_id asc
  `);
  return [...result.rows];
};

export const listUsers = async (database: Database): Promise<UserSummary[]> => {
  const rows = await database
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .orderBy(asc(users.email));
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    // technical/08's `UserSummary.name` is nullable; the column is `not null`, so an empty name is
    // reported as absent rather than as an empty string a UI would render as a blank row.
    name: row.name === '' ? null : row.name,
    role: row.role,
    status: asStatus(row.status),
  }));
};

export interface AuditPage {
  readonly items: AuditEntry[];
  readonly nextCursor: string | null;
}

/**
 * A page of `config_audit`, newest first.
 *
 * The cursor is the `created_at` of the last row on the previous page. `config_audit` is
 * partitioned by `created_at` and indexed on it descending, so paging by timestamp reads one
 * partition at a time; paging by offset would scan every partition for every page.
 *
 * It arrives as a `Date`, not as the client's string: an unparseable cursor used to become
 * `new Date(NaN)` and reach the driver, which is a query built from input nobody validated. The
 * route parses it and rejects what it cannot read (`parseAuditCursor`).
 */
export const listAuditEntries = async (
  database: Database,
  options: { readonly limit: number; readonly cursor?: Date; readonly entityType?: string },
): Promise<AuditPage> => {
  const conditions = [
    ...(options.cursor === undefined ? [] : [lt(configAudit.createdAt, options.cursor)]),
    ...(options.entityType === undefined ? [] : [eq(configAudit.entityType, options.entityType)]),
  ];

  const rows = await database
    .select({
      id: configAudit.id,
      entityType: configAudit.entityType,
      entityId: configAudit.entityId,
      userId: configAudit.userId,
      diff: configAudit.diff,
      createdAt: configAudit.createdAt,
    })
    .from(configAudit)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(configAudit.createdAt))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      entity_type: row.entityType,
      entity_id: row.entityId,
      user_id: row.userId,
      diff: row.diff as AuditEntry['diff'],
      created_at: row.createdAt.toISOString(),
    })),
    nextCursor:
      rows.length > options.limit && last !== undefined ? last.createdAt.toISOString() : null,
  };
};

/** Migration names this database has applied, for the readiness check. */
export const appliedMigrations = async (database: Database): Promise<string[]> => {
  const result = await database.execute<{ name: string }>(
    sql`select name from platform_migrations order by name`,
  );
  return [...result.rows].map((row) => row.name);
};

/**
 * The project a task belongs to, or `null` when the task does not exist.
 *
 * Used to scope an SSE topic: `task:<id>` is authorised against the caller's role **in that task's
 * project**, which is a different question from their organisation role (see `sse/topic-access.ts`).
 */
export const findTaskProjectId = async (
  database: Database,
  taskId: string,
): Promise<string | null> => {
  const rows = await database
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return rows[0]?.projectId ?? null;
};

/** The project a run belongs to, or `null` when the run does not exist. */
export const findRunProjectId = async (
  database: Database,
  runId: string,
): Promise<string | null> => {
  const rows = await database
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
};

/** Whether a project exists at all. */
export const projectExists = async (database: Database, projectId: string): Promise<boolean> => {
  const rows = await database
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows.length > 0;
};
