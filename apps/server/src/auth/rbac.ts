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
 * The project id comes from the URL, and **whether it has been validated depends on where the guard
 * is hooked** — which is the part that used to be wrong here. A guard registered as a `preHandler`
 * runs *after* Fastify has validated params, query and body, so the id really is a UUID by then.
 * The four knowledge routes (`routes/kb.ts`, WP-18b) register it as a **`preValidation`** hook
 * instead, because `/kb/doc?path=` and `/kb/proposals/:id/:decision` would otherwise answer an
 * anonymous caller `400` describing their own shape rather than `401` — so there the guard sees the
 * raw path segment. That is why those routes pass a `project` hook (`projectOf`) which returns the
 * id **only when it is a uuid** and `undefined` otherwise: `undefined` means organisation-scoped
 * here, the caller is still refused if they may not read, and the `400` arrives from the validator a
 * moment later. Either way the membership lookup cannot be handed a fragment of SQL — Drizzle
 * parameterises it, and a non-uuid never reaches it.
 *
 * ## Visibility, before the role (BD-035, TD-022's visibility amendment item 2)
 *
 * A project-scoped guard first asks whether the project is one the caller sees
 * (`auth/visibility.ts`). A hidden project is refused **404**, with the body a missing one gets —
 * `project <id> does not exist`, or the label `routes/scope.ts` left for a task, run, artifact or
 * shadow batch — so the answer does not confirm that it exists. The order is therefore 401, then
 * 404 for a hidden project (and for a missing one, for a narrowed caller — it is not in their set
 * either), then 403. The guard reads **no** existence: for a caller who sees every project, a
 * missing project's 404 is still the handler's (or the scope hook's), after the role, as before.
 * A guard built with a `project` hook and no `visibleProjects` is refused at registration.
 */

import type { UserRole } from '@platform/contracts';
import type { PermissionAction, PermissionSubject } from '@platform/domain';
import { can, ROLE_LEVELS } from '@platform/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors.js';
import { isProjectVisible, type VisibleProjectsReader, visibilityFor } from './visibility.js';

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
  /**
   * The caller's visible projects (BD-035). Required, so a composition cannot forget it; a guard
   * with a `project` hook refuses to be built without one.
   */
  readonly visibleProjects: VisibleProjectsReader;
}

/** Marks a guard that asks visibility, for the route census (`visibility-census.test.ts`). */
export const VISIBILITY_GUARD = Symbol.for('agentic.visibility-guard');

/**
 * Builds a Fastify hook that refuses the request unless `can()` allows it.
 *
 * Registered as a `preHandler` by most routes and as a **`preValidation`** hook by the knowledge
 * routes; the module docblock says what that changes (the `project` hook then sees an unvalidated
 * path segment, which is why `routes/kb.ts` hands it `projectOf`). Both positions run after the
 * session hook, which is an `onRequest` one, so `request.actor` is set either way.
 *
 * Refusals are two different answers on purpose: no session at all is 401 (authenticate and try
 * again), an authenticated caller without the role is 403 (authenticating differently will not
 * help). Both carry the machine-readable `code` of `apiErrorSchema`.
 */
export const requirePermission = (
  dependencies: PermissionGuardDependencies,
  action: PermissionAction,
  options: PermissionGuardOptions = {},
): ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
  // Probed from JavaScript too: a caller that bypasses the type must not get a guard that skips it.
  if (options.project !== undefined && typeof dependencies.visibleProjects !== 'function') {
    throw new TypeError(
      `a project-scoped guard for ${action} needs visibleProjects (BD-035, TD-022's visibility amendment)`,
    );
  }
  const guard = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new UnauthorizedError('this endpoint needs an authenticated session');
    }

    const projectId = options.project?.(request);
    if (projectId !== undefined) {
      const visible = await visibilityFor(request, actor, dependencies.visibleProjects);
      if (!isProjectVisible(visible, projectId)) {
        // The body a missing id gets: the scope hook's label when it resolved one, else the project.
        throw new NotFoundError(request.scopeLabel ?? `project ${projectId}`);
      }
    }
    const role =
      projectId === undefined
        ? actor.role
        : effectiveRole(actor.role, await dependencies.projectRole(projectId, actor.userId));

    if (!can(role, action, options.subject?.(request))) {
      throw new ForbiddenError(action, role);
    }

    request.effectiveRole = role;
  };
  if (options.project !== undefined) {
    Object.defineProperty(guard, VISIBILITY_GUARD, { value: true });
  }
  return guard;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook when the request carries a valid session; `undefined` otherwise. */
    actor?: Actor;
    /** The role the permission guard actually applied, org or project. Logged and audited. */
    effectiveRole?: UserRole;
    /**
     * What a scope hook resolved, as its 404 names it (`task <id>`), so the guard's 404 for a hidden
     * project is the body a missing id gets (`routes/scope.ts`).
     */
    scopeLabel?: string;
  }
}
