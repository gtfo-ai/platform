/**
 * Authorisation on the HTTP boundary (technical/08 § "Auth and RBAC").
 *
 * The decision itself is not made here. `packages/domain`'s `can(role, action, subject)` is the
 * single place a role is compared to an action — it is pure, total and covered by an exhaustive
 * role×action test (Q36) — and this module's whole job is to work out *which role* applies to
 * *this request* and then ask it. Reimplementing any part of that table here would create a second
 * answer to the same question, which is how authorisation bugs are born.
 *
 * ## The effective role
 *
 * A user carries an organisation role (`users.role`) and may additionally hold a membership in a
 * project (`project_members.role`). product/11 describes the four roles once, at organisation
 * level, and adds project membership without saying it restricts anything; TD-022 gives both the
 * same numeric levels. So the effective role for a project-scoped resource is the **higher** of
 * the two: membership promotes (a `member` who maintains one project), it never demotes (a project
 * membership cannot strip an organisation admin of the administration they were given).
 *
 * ## Untrusted input
 *
 * The project id comes from the URL. It is validated as a UUID by the route schema before this
 * runs, so the membership lookup can never be handed a fragment of SQL — and Drizzle parameterises
 * it regardless.
 */

import type { UserRole } from '@platform/contracts';
import type { PermissionAction, PermissionSubject } from '@platform/domain';
import { can, ROLE_LEVELS } from '@platform/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../errors.js';

/** Who is making the request, once the session cookie has been resolved to a row. */
export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  /** The organisation role. Project scoping is applied per request by `effectiveRole`. */
  readonly role: UserRole;
  readonly sessionId: string;
}

/** The higher of the organisation role and a project membership; see the module note. */
export const effectiveRole = (orgRole: UserRole, projectRole: UserRole | null): UserRole =>
  projectRole !== null && ROLE_LEVELS[projectRole] > ROLE_LEVELS[orgRole] ? projectRole : orgRole;

export interface PermissionGuardOptions {
  /**
   * Reads the project id out of the request when the resource is project-scoped. Returning
   * `undefined` means "organisation-scoped", and only the org role applies.
   */
  readonly project?: (request: FastifyRequest) => string | undefined;
  /** The resource's state, where it changes the answer (an open question, a live run, …). */
  readonly subject?: (request: FastifyRequest) => PermissionSubject | undefined;
}

export interface PermissionGuardDependencies {
  /**
   * The caller's role in a project, or `null` when they hold no membership.
   *
   * Injected rather than imported so this module names no database at all: the guard's whole
   * behaviour is then testable against a plain function, and the exhaustive "the guard agrees with
   * `can()` for every role" test needs no schema to run.
   */
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
}

/**
 * Builds a Fastify `preHandler` that refuses the request unless `can()` allows it.
 *
 * Refusals are two different answers on purpose: no session at all is 401 (authenticate and try
 * again), an authenticated caller without the role is 403 (authenticating differently will not
 * help). Both carry the machine-readable `code` of `apiErrorSchema`.
 */
export const requirePermission =
  (
    dependencies: PermissionGuardDependencies,
    action: PermissionAction,
    options: PermissionGuardOptions = {},
  ) =>
  async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new UnauthorizedError('this endpoint needs an authenticated session');
    }

    const projectId = options.project?.(request);
    const role =
      projectId === undefined
        ? actor.role
        : effectiveRole(actor.role, await dependencies.projectRole(projectId, actor.userId));

    if (!can(role, action, options.subject?.(request))) {
      throw new ForbiddenError(action, role);
    }

    request.effectiveRole = role;
  };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook when the request carries a valid session; `undefined` otherwise. */
    actor?: Actor;
    /** The role the permission guard actually applied, org or project. Logged and audited. */
    effectiveRole?: UserRole;
  }
}
