/**
 * Project scoping for a resource whose project is a **column** rather than a URL segment (WP-15h).
 *
 * `requirePermission`'s own `project` hook is synchronous, which is all the routes before this one
 * needed: `/api/projects/:project_id/config` reads the id out of the path. A run and a task carry
 * theirs in the database, so the lookup happens in a preHandler that runs first and leaves the
 * answer on the request for the guard to scope against.
 *
 * **The order of the three answers is the security-relevant part.** 401 when there is no session at
 * all, *before* the lookup: otherwise an anonymous caller could tell an existing id from a
 * non-existent one by the status code. Then 404 when the row does not exist. Only then is
 * `scopedProjectId` set — and never `undefined`, because `requirePermission` reads `undefined` as
 * "organisation-scoped", which would silently drop the project half of the decision (standing rule
 * 18: an absent value must not produce the permissive result).
 */
import type { FastifyRequest } from 'fastify';
import { NotFoundError, UnauthorizedError } from '../errors.js';

export interface ScopeOptions {
  /** The URL parameter holding the resource id. */
  readonly param: string;
  /** What the id names, for the 404 message: `run`, `task`. */
  readonly what: string;
  /**
   * The project the resource belongs to, or `null` when there is no such resource.
   *
   * A closure over whatever reads it rather than `(database, id)`, so a route module can be driven
   * without one — the argument `requirePermission`'s `projectRole` makes, and what lets
   * `routes/commands.test.ts` exercise eleven routes against plain functions.
   */
  readonly projectOf: (id: string) => Promise<string | null>;
  /**
   * Tolerate a path segment that is not a uuid, for a hook registered at `preValidation`.
   *
   * Every command route is (WP-15i): Fastify validates the **body** before `preHandler`, so a route
   * that takes one would answer an anonymous caller `400` describing its own shape instead of
   * `401`. The cost is that this hook then sees an unvalidated segment, and handing a non-uuid to a
   * `uuid` column turns a 400 into a 500. So it is left unresolved: `requirePermission` reads the
   * absent value as "organisation-scoped" and still refuses a caller who may not act, and the 400
   * arrives from the validator a moment later. The same shape `routes/kb.ts` and
   * `routes/onboarding.ts` use for their own `project` hooks.
   *
   * `false` (the default) is for a `preHandler`, where the id has already been validated and an
   * unparseable one cannot arrive.
   */
  readonly lenient?: boolean;
}

/** A uuid, as the route schemas spell it; used only to decide whether a lookup is safe to make. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const scopeToProject =
  (options: ScopeOptions) =>
  async (request: FastifyRequest): Promise<void> => {
    if (request.actor === undefined) {
      throw new UnauthorizedError('this endpoint needs an authenticated session');
    }
    const id = (request.params as Record<string, string>)[options.param] ?? '';
    if (options.lenient === true && !UUID.test(id)) {
      return;
    }
    const projectId = await options.projectOf(id);
    if (projectId === null) {
      throw new NotFoundError(`${options.what} ${id}`);
    }
    request.scopedProjectId = projectId;
  };

/** Reads what {@link scopeToProject} left behind, for `requirePermission`'s `project` hook. */
export const scopedProject = (request: FastifyRequest): string | undefined =>
  request.scopedProjectId;

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The project a run- or task-scoped route resolved from the database.
     *
     * Set by {@link scopeToProject} and read by `requirePermission`'s `project` hook. The two are
     * a pair in both directions and **the pairing is checked** by `routes/scope.test.ts`, which
     * reads every route module off disk: a `preHandler` that resolves a project and decides no
     * permission serves any signed-in caller, and one that scopes by `scopedProject` without the
     * resolver silently falls back to the organisation role. The check is syntactic and its holes
     * are listed at the top of that file — `client-census.test.ts` cannot close this one, because
     * its anonymous probe gets 401 from *either* half.
     */
    scopedProjectId?: string;
  }
}
