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
import type { Database } from '../queries/identity-queries.js';

export interface ScopeOptions {
  readonly database: Database;
  /** The URL parameter holding the resource id. */
  readonly param: string;
  /** What the id names, for the 404 message: `run`, `task`. */
  readonly what: string;
  /** The project the resource belongs to, or `null` when there is no such resource. */
  readonly projectOf: (database: Database, id: string) => Promise<string | null>;
}

export const scopeToProject =
  (options: ScopeOptions) =>
  async (request: FastifyRequest): Promise<void> => {
    if (request.actor === undefined) {
      throw new UnauthorizedError('this endpoint needs an authenticated session');
    }
    const id = (request.params as Record<string, string>)[options.param] ?? '';
    const projectId = await options.projectOf(options.database, id);
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
