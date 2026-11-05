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
