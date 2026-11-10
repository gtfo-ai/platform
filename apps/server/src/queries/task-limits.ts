/**
 * **A person's limit on their tasks in flight** — the reads and the one writer behind
 * `routes/task-limits.ts` (S-28.6, the M28 ruling B on BD-010; migration 0112).
 *
 * - **What counts** is the domain's `countsTowardOwner` (`OWNER_COUNTED_TASK_STATES`, bound into
 *   each statement so the SQL cannot drift from it): the person's owned tasks that are `active`,
 *   `returned`, `waiting_answers` or `waiting_approval`, across every project — the count the
 *   scheduler's `TaskRepository.ownerAdmission` takes.
 * - **The limit in force** is `ownerLimitOf`: their own `users.max_tasks_in_flight` under the
 *   organisation's `pipeline.wip.max_tasks_per_owner`, else that value (3 when it states none).
 *   The organisation document is parsed strictly; one that does not parse is the routes' `409
 *   invalid_organisation_config`, never a silent default.
 * - **The writer** locks the user's row, refuses a number above the maximum (`above_maximum`,
 *   nothing written), and writes one `human_actions` row `user.task_limit` per change — none for a
 *   repeat of the stored value. It answers whether the limit in force **rose**, and the projects
 *   where the person has queued tasks, so the route can append the `config.changed` the scheduler
 *   hears (`pipeline/wip-raised.ts`) once the write has committed.
 */
import type { JsonObject, OrganisationSettings, TaskState } from '@platform/contracts';
import {
  DEFAULT_WIP_LIMITS,
  OWNER_COUNTED_TASK_STATES,
  ownerLimitOf,
  TASKS_PER_OWNER_BOUND,
  type WipLimits,
} from '@platform/domain';
import { sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

/** The audit row's action — `ui/words/human-actions.ts` names it. */
export const TASK_LIMIT_ACTION = 'user.task_limit';

/** The organisation's per-person default and maximum, from its parsed settings document. */
export interface OrganisationOwnerLimits {
  readonly default: number;
  readonly maximum: number;
  readonly organisationStates: boolean;
}

export const organisationOwnerLimitsOf = (
  settings: OrganisationSettings,
): OrganisationOwnerLimits => {
  const stated = settings.pipeline?.wip?.max_tasks_per_owner;
  return {
    default: stated ?? DEFAULT_WIP_LIMITS.maxTasksPerOwner,
    maximum: stated ?? TASKS_PER_OWNER_BOUND,
    organisationStates: stated !== undefined,
  };
};

/** The limit in force for a person with `personal`, against the organisation's two values. */
export const personalLimitInForce = (
  limits: OrganisationOwnerLimits,
  personal: number | null,
): number =>
  ownerLimitOf(
    {
      ...DEFAULT_WIP_LIMITS,
      maxTasksPerOwner: limits.default,
      ownerLimitMaximum: limits.maximum,
    } satisfies WipLimits,
    personal,
  );

const COUNTED = `{${OWNER_COUNTED_TASK_STATES.join(',')}}`;

/** The organisation's stored settings document (the first organisation's, as every read here). */
export const readOrganisationSettingsDocument = async (database: Database): Promise<unknown> => {
  const { rows } = await database.execute<{ settings: unknown }>(sql`
    select settings from organizations order by created_at limit 1`);
  return rows[0]?.settings ?? null;
};

export interface PersonTaskLoad {
  readonly personal: number | null;
  readonly inFlight: number;
  readonly queued: number;
  readonly holders: readonly {
    readonly taskId: string;
    readonly ticketKey: string;
    readonly projectKey: string;
    readonly state: TaskState;
  }[];
}

/** One person's own number, their counted tasks (oldest first, at most `holders`) and queued ones. */
export const readPersonTaskLoad = async (
  database: Database,
  userId: string,
  holders: number,
): Promise<PersonTaskLoad | null> => {
  const { rows } = await database.execute<{
    personal: number | null;
    in_flight: number;
    queued: number;
  }>(sql`
    select u.max_tasks_in_flight as personal,
           (select count(*)::int from tasks t
             where t.owner_user_id = u.id and t.state::text = any(${COUNTED}::text[])) as in_flight,
           (select count(*)::int from tasks t
             where t.owner_user_id = u.id and t.state = 'queued') as queued
      from users u where u.id = ${userId}`);
  const row = rows[0];
  if (row === undefined) return null;
  const listed = await database.execute<{
    id: string;
    ticket_key: string;
    project_key: string;
    state: TaskState;
  }>(sql`
    select t.id, t.ticket_key, p.key as project_key, t.state::text as state
      from tasks t join projects p on p.id = t.project_id
     where t.owner_user_id = ${userId} and t.state::text = any(${COUNTED}::text[])
     order by t.created_at, t.id
     limit ${holders}`);
  return {
    personal: row.personal === null ? null : Number(row.personal),
    inFlight: Number(row.in_flight),
    queued: Number(row.queued),
    holders: listed.rows.map((holder) => ({
      taskId: holder.id,
      ticketKey: holder.ticket_key,
      projectKey: holder.project_key,
      state: holder.state,
    })),
  };
};

/** Every person with their own number, counted and queued tasks — an administrator's list. */
export const listPeopleTaskLoads = async (
  database: Database,
): Promise<
  readonly {
    readonly userId: string;
    readonly name: string | null;
    readonly email: string;
    readonly personal: number | null;
    readonly inFlight: number;
    readonly queued: number;
  }[]
> => {
  const { rows } = await database.execute<{
    id: string;
    name: string | null;
    email: string;
    personal: number | null;
    in_flight: number;
    queued: number;
  }>(sql`
    select u.id, u.name, u.email, u.max_tasks_in_flight as personal,
           (select count(*)::int from tasks t
             where t.owner_user_id = u.id and t.state::text = any(${COUNTED}::text[])) as in_flight,
           (select count(*)::int from tasks t
             where t.owner_user_id = u.id and t.state = 'queued') as queued
      from users u
     where u.status <> 'disabled'
     order by lower(coalesce(nullif(u.name, ''), u.email)), u.id`);
  return rows.map((row) => ({
    userId: row.id,
    name: row.name === '' ? null : row.name,
    email: row.email,
    personal: row.personal === null ? null : Number(row.personal),
    inFlight: Number(row.in_flight),
    queued: Number(row.queued),
  }));
};

export type SetTaskLimitResult =
  | {
      readonly status: 'set';
      readonly personal: number | null;
      readonly limit: number;
      readonly performed: boolean;
      /** The limit in force rose: these projects hold the person's queued tasks. */
      readonly raised: { readonly from: number; readonly to: number } | null;
      readonly queuedProjects: readonly string[];
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'above_maximum'; readonly maximum: number };

/**
 * **The one writer of `users.max_tasks_in_flight`** (S-28.6): the row locked, the number held under
 * the organisation's maximum, one audit row per change.
 */
export const setPersonTaskLimit = async (
  database: Database,
  input: {
    readonly userId: string;
    readonly actorUserId: string;
    readonly personal: number | null;
    readonly limits: OrganisationOwnerLimits;
    readonly via: 'self' | 'administrator';
  },
): Promise<SetTaskLimitResult> =>
  database.transaction(async (tx) => {
    const { rows } = await tx.execute<{ personal: number | null }>(sql`
      select max_tasks_in_flight as personal from users where id = ${input.userId} for update`);
    const row = rows[0];
    if (row === undefined) {
      return { status: 'not_found' } as const;
    }
    if (input.personal !== null && input.personal > input.limits.maximum) {
      return { status: 'above_maximum', maximum: input.limits.maximum } as const;
    }
    const before = row.personal === null ? null : Number(row.personal);
    const limit = personalLimitInForce(input.limits, input.personal);
    if (before === input.personal) {
      return {
        status: 'set',
        personal: before,
        limit,
        performed: false,
        raised: null,
        queuedProjects: [],
      } as const;
    }
    await tx.execute(sql`
      update users set max_tasks_in_flight = ${input.personal}, updated_at = now()
       where id = ${input.userId}`);
    const params: JsonObject = {
      user_id: input.userId,
      max_tasks_in_flight: input.personal,
      previous: before,
      via: input.via,
    };
    await tx.execute(sql`
      insert into human_actions (user_id, action, params)
      values (${input.actorUserId}, ${TASK_LIMIT_ACTION}, ${JSON.stringify(params)}::jsonb)`);
    const from = personalLimitInForce(input.limits, before);
    const queued =
      limit > from
        ? await tx.execute<{ project_id: string }>(sql`
            select distinct project_id from tasks
             where owner_user_id = ${input.userId} and state = 'queued'
             order by project_id`)
        : { rows: [] };
    return {
      status: 'set',
      personal: input.personal,
      limit,
      performed: true,
      raised: limit > from ? { from, to: limit } : null,
      queuedProjects: queued.rows.map((project) => project.project_id),
    } as const;
  });
