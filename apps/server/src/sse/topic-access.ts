/**
 * Who may subscribe to which SSE topic (technical/08 § "Auth and RBAC": "project scoping on every
 * route").
 *
 * `/events` used to take any well-formed topic from any authenticated caller. That was wrong for a
 * reason that outlives the current data model: the `run:<id>` topic carries **transcript** frames,
 * and `transcript.read` is one of the seven capabilities technical/08 spells out by hand — at
 * `member`, not `viewer`. A viewer with a valid session could therefore have subscribed to an
 * agent's transcript and, the moment WP-12 starts publishing, received it.
 *
 * The mapping is one line per topic kind:
 *
 * | topic | capability | scope |
 * |---|---|---|
 * | `org` | `org.read` | organisation |
 * | `project:<id>` | `project.read` | that project |
 * | `task:<id>` | `task.read` | the task's project |
 * | `run:<id>` | `transcript.read` | the run's project |
 *
 * The decision itself is `packages/domain`'s `can()`, and the role handed to it is the same
 * `effectiveRole(org, membership)` the HTTP guards use — one rule, one place, both entry points.
 *
 * Everything the check needs from the database arrives as a function, so the whole policy is
 * testable without a schema; `sse/routes.ts` binds those functions to the real queries.
 */
import type { UserRole } from '@platform/contracts';
import { can, type PermissionAction } from '@platform/domain';
import { effectiveRole } from '../auth/rbac.js';
import { ForbiddenError, NotFoundError } from '../errors.js';

export interface TopicAccessDependencies {
  /** The caller's role in a project, or `null` when they hold no membership in it. */
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  /** Whether a project exists. */
  readonly projectExists: (projectId: string) => Promise<boolean>;
  /** The project a task belongs to, or `null` when there is no such task. */
  readonly taskProjectId: (taskId: string) => Promise<string | null>;
  /** The project a run belongs to, or `null` when there is no such run. */
  readonly runProjectId: (runId: string) => Promise<string | null>;
}

export interface TopicSubject {
  /** The capability the topic needs. */
  readonly action: PermissionAction;
  /** The project the topic belongs to, or `null` for an organisation-wide topic. */
  readonly projectId: string | null;
}

/** Splits `task:<uuid>` into its parts. Topics are validated by the route schema before this. */
const partsOf = (topic: string): { kind: string; id: string | undefined } => {
  const separator = topic.indexOf(':');
  return separator === -1
    ? { kind: topic, id: undefined }
    : { kind: topic.slice(0, separator), id: topic.slice(separator + 1) };
};

/**
 * Resolves a topic to the capability it needs and the project it belongs to.
 *
 * A topic naming a project, task or run that does not exist is a `NotFoundError`, not a silent
 * subscription to nothing: a client that mistypes an id should learn it now rather than watch an
 * empty stream and conclude the platform is broken.
 *
 * **Recorded rather than hidden:** the existence check runs *before* `can()`, so any signed-in user
 * can tell an id that exists from one that does not — 404 versus 403 — for a run or task they may
 * not read. The ids are UUIDv7 (technical/03: `uuidv7()` defaults), so they are not enumerable and
 * the oracle answers a question an attacker would already have had to know the answer to. Closing
 * it means answering 403 for a topic that does not exist, which makes a client's own typo
 * indistinguishable from a permission problem; that trade goes the other way here, deliberately.
 */
export const resolveTopic = async (
  dependencies: TopicAccessDependencies,
  topic: string,
): Promise<TopicSubject> => {
  const { kind, id } = partsOf(topic);

  if (kind === 'org') {
    return { action: 'org.read', projectId: null };
  }
  if (id === undefined) {
    throw new NotFoundError(`topic ${topic}`);
  }

  if (kind === 'project') {
    if (!(await dependencies.projectExists(id))) {
      throw new NotFoundError(`topic ${topic}`);
    }
    return { action: 'project.read', projectId: id };
  }

  if (kind === 'task') {
    const projectId = await dependencies.taskProjectId(id);
    if (projectId === null) {
      throw new NotFoundError(`topic ${topic}`);
    }
    return { action: 'task.read', projectId };
  }

  if (kind === 'run') {
    const projectId = await dependencies.runProjectId(id);
    if (projectId === null) {
      throw new NotFoundError(`topic ${topic}`);
    }
    // A run's stream is its transcript, and technical/08 puts `transcript.read` at `member`.
    return { action: 'transcript.read', projectId };
  }

  throw new NotFoundError(`topic ${topic}`);
};

/**
 * Refuses the whole subscription unless every topic in it is allowed.
 *
 * All or nothing on purpose: silently dropping the topics a caller may not have would give them a
 * stream that looks subscribed and is quietly missing half of what they asked for, which is the
 * failure mode hardest to notice from a UI.
 */
export const authoriseTopics = async (
  dependencies: TopicAccessDependencies,
  actor: { readonly userId: string; readonly role: UserRole },
  topics: readonly string[],
): Promise<void> => {
  // One membership lookup per project, not per topic: a tab watching a board plus five of its
  // tasks is six topics in one project.
  const membership = new Map<string, UserRole | null>();
  const roleFor = async (projectId: string | null): Promise<UserRole> => {
    if (projectId === null) {
      return actor.role;
    }
    if (!membership.has(projectId)) {
      membership.set(projectId, await dependencies.projectRole(projectId, actor.userId));
    }
    return effectiveRole(actor.role, membership.get(projectId) ?? null);
  };

  for (const topic of topics) {
    const subject = await resolveTopic(dependencies, topic);
    const role = await roleFor(subject.projectId);
    if (!can(role, subject.action)) {
      throw new ForbiddenError(`${subject.action} on ${topic}`, role);
    }
  }
};
