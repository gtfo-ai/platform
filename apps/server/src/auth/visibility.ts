/**
 * **Which projects a person sees** — BD-035, TD-022's 2026-11-26 visibility amendment, item 1.
 *
 * Visibility is a second question asked **before** the role: the role (`can()`, `effectiveRole`)
 * decides what a person may do, and this module decides what exists for them. A hidden project
 * answers like one that does not exist — `404` — and every list leaves it out. It is a **focus
 * filter, not a confidentiality boundary** (BD-035's rationale): anybody at `member` or above may
 * widen their own worker and see the project again.
 *
 * ## The rule, in the order it is decided
 *
 *  1. `project.read_all` (an organisation `admin`) — every project.
 *  2. Any worker that is not revoked whose `claim_project_ids` is `null` (every project) or a legacy
 *     `'{}'` (migration 0108, which reads as `null` wherever the project list narrows) — every
 *     project, whatever the other sources say: the union with "every project" is every project.
 *  3. **Nothing narrows** — no worker that is not revoked and no `project_members` row — every
 *     project. An owned task never narrows by itself: it only *adds* to a set something else
 *     narrowed, which is why a person whose only source is an owned task still sees everything.
 *  4. Otherwise the union of the workers' projects, the memberships and the projects of the
 *     person's **unfinished** owned tasks.
 *
 * The rule is {@link visibleProjectsOf}, pure; the three sources are one statement
 * (`queries/project-visibility-queries.ts`); and {@link visibilityFor} memoises the answer on the
 * request, so a route that asks twice (the guard, then a list filter) reads once.
 */
import type { UserRole } from '@platform/contracts';
import { can } from '@platform/domain';
import type { FastifyRequest } from 'fastify';
import type { Actor } from './rbac.js';

/** Every project, or exactly these. */
export type VisibleProjects =
  | { readonly all: true }
  | { readonly all: false; readonly ids: ReadonlySet<string> };

export const EVERY_PROJECT: VisibleProjects = Object.freeze({ all: true as const });

/** The three sources of BD-035's rule, as one person's rows. */
export interface VisibilitySources {
  /** Each worker of theirs that is not revoked: its `claim_project_ids` (`null`: every project). */
  readonly workerScopes: readonly (readonly string[] | null)[];
  /** The projects of their `project_members` rows. */
  readonly memberships: readonly string[];
  /** The projects where they own a task that is neither `done` nor `cancelled`. */
  readonly ownedTaskProjects: readonly string[];
}

/** Reads one person's {@link VisibilitySources}. */
export type VisibilitySourceReader = (userId: string) => Promise<VisibilitySources>;

/** The rule of BD-035 over a person's role and sources; see the module note for its order. */
export const visibleProjectsOf = (role: UserRole, sources: VisibilitySources): VisibleProjects => {
  if (can(role, 'project.read_all')) {
    return EVERY_PROJECT;
  }
  if (sources.workerScopes.some((scope) => scope === null || scope.length === 0)) {
    return EVERY_PROJECT;
  }
  if (sources.workerScopes.length === 0 && sources.memberships.length === 0) {
    return EVERY_PROJECT;
  }
  const ids = new Set<string>();
  for (const scope of sources.workerScopes) {
    for (const id of scope ?? []) {
      ids.add(id);
    }
  }
  for (const id of sources.memberships) {
    ids.add(id);
  }
  for (const id of sources.ownedTaskProjects) {
    ids.add(id);
  }
  return { all: false, ids };
};

/** `visibleProjects(actor)`: the one function every surface asks (TD-022's amendment, item 1). */
export type VisibleProjectsReader = (actor: Actor) => Promise<VisibleProjects>;

/** Composes {@link VisibleProjectsReader} over the statement that reads the sources. */
export const createVisibleProjects =
  (read: VisibilitySourceReader): VisibleProjectsReader =>
  async (actor) =>
    can(actor.role, 'project.read_all')
      ? EVERY_PROJECT
      : visibleProjectsOf(actor.role, await read(actor.userId));

/** Whether a project is in the set. */
export const isProjectVisible = (visible: VisibleProjects, projectId: string): boolean =>
  visible.all || visible.ids.has(projectId);

/**
 * The set as a list filter takes it: `null` for every project, otherwise the ids. A list over an
 * empty list returns nothing — never everything.
 */
export const visibleIdsOf = (visible: VisibleProjects): readonly string[] | null =>
  visible.all ? null : [...visible.ids].sort();

/**
 * The request's set, read once per request (TD-022's amendment, item 1: "memoised on the
 * request"). The promise is kept rather than the value, so two hooks asking at once share a read.
 */
export const visibilityFor = (
  request: FastifyRequest,
  actor: Actor,
  read: VisibleProjectsReader,
): Promise<VisibleProjects> => {
  const held = request.visibleProjects;
  if (held !== undefined) {
    return held;
  }
  const answer = read(actor);
  request.visibleProjects = answer;
  return answer;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** The caller's visible projects, once something asked (BD-035). */
    visibleProjects?: Promise<VisibleProjects>;
  }
}
