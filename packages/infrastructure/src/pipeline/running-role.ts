/**
 * **Who may take a project's run** (TD-031 §8: `member` or above) — one SQL predicate for every
 * worker-path statement that asks it: the claim (`WORKER_ELIGIBLE` in `postgres-run-offers.ts`) and
 * the online-assignee read (`postgres-execution-routing.ts`).
 *
 * The role compared is the **effective** one, the rule `apps/server/src/auth/rbac.ts`'s
 * `effectiveRole` applies to every project-scoped request: the higher of the organisation role
 * (`users.role`) and a membership in the project (`project_members.role`) — a membership promotes,
 * it never demotes. "At or above `member`" of the higher of two roles is "either one is", so the
 * predicate is a disjunction and needs no level arithmetic in SQL.
 *
 * Both statements once joined `project_members` alone, and nothing outside the tests writes that
 * table: on a real installation no worker was ever eligible (an organisation admin's connected
 * worker, holding the right images, claimed nothing — backlog 886).
 *
 * The role list is derived from the domain's ordering (`ROLE_LEVELS`), never restated, and is a
 * closed set of enum literals — so inlining it is not an injection surface.
 */
import { ROLE_LEVELS, USER_ROLES } from '@platform/domain';

/** The roles that may take a run: `member` and every role above it. */
export const RUNNING_ROLES = USER_ROLES.filter((role) => ROLE_LEVELS[role] >= ROLE_LEVELS.member);

const ROLE_ARRAY = `array[${RUNNING_ROLES.map((role) => `'${role}'`).join(', ')}]::text[]`;

/**
 * A predicate true when the user `userColumn` may take a run of the project `projectColumn` —
 * both SQL expressions of the enclosing statement (a column or a parameter).
 */
export const userMayRunInProjectSql = (userColumn: string, projectColumn: string): string => `(
       exists (select 1 from users ru
                where ru.id = ${userColumn} and ru.role::text = any(${ROLE_ARRAY}))
    or exists (select 1 from project_members rm
                where rm.user_id = ${userColumn} and rm.project_id = ${projectColumn}
                  and rm.role::text = any(${ROLE_ARRAY})))`;

/**
 * **Who may own a task of the project, or hold its head start** (S-26.1, the review of PR #92):
 * {@link userMayRunInProjectSql}, and the account is not disabled (`users.status`). An owner, a
 * linked assignee and an online assignee answer through this one predicate, so an account an
 * administrator disabled neither owns a task nor holds a window its claim would then refuse.
 *
 * A predicate of its own rather than a conjunct inside `userMayRunInProjectSql`: the claim already
 * refuses a disabled user through `USER_MAY_ACT_SQL` (`worker-holder.ts`), and the S-22.19 reads
 * that explain why a worker takes nothing count projects with `userMayRunInProjectSql` beside that
 * check — folding it in there would report a disabled owner twice (`owner_disabled` and
 * `no_eligible_project`), which the claim's parity case refuses.
 */
export const userMayOwnInProjectSql = (userColumn: string, projectColumn: string): string => `(
       ${userMayRunInProjectSql(userColumn, projectColumn)}
   and exists (select 1 from users ou
                where ou.id = ${userColumn} and ou.status <> 'disabled'))`;

/**
 * A predicate true when the project `projectColumn`'s **run credential keeps remote workers off its
 * runs** (WP-282, TD-031 decision 5, Q124 (a)): a live git binding whose integration gives runs a
 * static token or a deploy key without `remote_run_credential: allow`. **The claim's own clause**
 * (`workerEligibleSql` in `postgres-run-offers.ts` asks `not` this), defined once so the reads that
 * explain why a worker takes nothing (S-22.19) ask exactly what the claim asks.
 */
export const remoteRunCredentialRefusedSql = (projectColumn: string): string => `exists (
           select 1
             from bindings b
             join integrations i on i.id = b.integration_id
            where b.project_id = ${projectColumn}
              and i.type = 'git'
              and i.retired_at is null
              and coalesce(i.config ->> 'run_credential', 'minted') <> 'minted'
              and coalesce(i.config ->> 'remote_run_credential', 'deny') <> 'allow')`;

/**
 * **Held elsewhere** (S-26.1, TD-031's 2026-11-06 amendment item 6) — true when the task `task`'s
 * stored tracker assignee (`tasks.ticket_assignee`, migration 0104) names a person, not the
 * platform's own account or a machine (`platform` false), who is **not** a `person` identity linked
 * to a user that may own the project's tasks ({@link userMayOwnInProjectSql}). Read **live** through
 * `user_identities`, so a link or a role change made since the read counts at once.
 *
 * The SQL spelling of the domain's `taskHeldElsewhere` (`packages/domain/src/tasks/owner.ts`) over
 * the directory's `classifyAssignee` — one predicate for the command, the task DTO's
 * `unlinked_assignee`, and (S-26.4, S-26.5) the claim, the pick and the waiting read;
 * `test/integration/pipeline/task-owner.integration.test.ts` holds the two spellings to one answer.
 * `task` is the alias of a `tasks` row in the enclosing statement.
 */
export const taskHeldElsewhereSql = (task: string): string => `(
       ${task}.ticket_assignee is not null
   and coalesce((${task}.ticket_assignee ->> 'platform')::boolean, false) = false
   and not exists (select 1 from user_identities hi
                    where hi.provider = ${task}.ticket_assignee ->> 'provider'
                      and hi.external_id = ${task}.ticket_assignee ->> 'external_id'
                      and hi.kind = 'person'
                      and ${userMayOwnInProjectSql('hi.user_id', `${task}.project_id`)}))`;

/**
 * **The user the task `task`'s stored tracker assignee resolves to** (S-26.8b's follow-up, the task
 * DTO's `tracker_assignee.user_id`): a scalar subquery answering the `user_id` of the `person`
 * identity the assignee names when that user may own the project's tasks
 * ({@link userMayOwnInProjectSql}, which refuses a disabled account), else `null` — never for a
 * `platform` assignee (the binding's own account, a machine). The positive half of
 * {@link taskHeldElsewhereSql}, over the same identity and the same predicate, read live.
 */
export const trackerAssigneeUserSql = (task: string): string => `(
       select ti.user_id from user_identities ti
        where ${task}.ticket_assignee is not null
          and coalesce((${task}.ticket_assignee ->> 'platform')::boolean, false) = false
          and ti.provider = ${task}.ticket_assignee ->> 'provider'
          and ti.external_id = ${task}.ticket_assignee ->> 'external_id'
          and ti.kind = 'person'
          and ${userMayOwnInProjectSql('ti.user_id', `${task}.project_id`)}
        order by ti.user_id
        limit 1)`;
