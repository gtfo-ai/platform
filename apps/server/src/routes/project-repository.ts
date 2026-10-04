/**
 * A project's repository settings the platform must not assume — WP-139.
 *
 *   GET /api/projects/:project_id/repository       the stored default branch beside the provider's
 *   PUT /api/projects/:project_id/default-branch   change the stored default branch
 *
 * `projects.default_branch` is what a run checks out (`apps/server/src/workspaces.ts`), what a merge
 * request targets (`merge-request-tool.ts`) and what the mirror reads (`git-vault.ts`). Until this
 * row nothing wrote it but the create, and the wizard never sent it, so every project was `main`
 * (migration 0003's default) — Autix (`develop`) and GoParking (`dev`) would have failed at the
 * checkout or opened a merge request against the wrong branch.
 *
 * ## The read
 *
 * `provider` is what the git binding's provider says (GitLab's project `default_branch` and
 * `ci_config_path`), read **through `IntegrationActionExecutor`** outside any transaction, so it is
 * audited and rate-limited like the wizard's probe. The wizard prefills the default-branch field
 * from it; it is never written anywhere by this read. A project with no git binding, or a read the
 * provider refused, answers `provider: null` and says which in `provider_unavailable` — the field
 * is then required of the person rather than guessed (rule 16).
 *
 * ## The command
 *
 * A maintainer's (`project.pipeline.write`). The row's ruling names `project.settings.write` *and*
 * "a maintainer can change it" *and* "403 below maintainer"; on this build that capability is
 * **admin** (`permissions.ts`), so taking the name would have made the change an administrator's.
 * The role is what the ruling decided — the same reading WP-94 made for the re-evaluate button
 * (`routes/rediscovery.ts`). Recorded under WP-139.
 *
 * It is WP-15i's shape: an optional `Idempotency-Key`, claimed before the write; one
 * `human_actions` row per accepted request (before and after); none for a refused one. It is
 * **refused `409 project_has_live_tasks`** while any of the project's tasks is not `done` or
 * `cancelled`: a live task's branch, merge request, rebase gate and CI file were all made against
 * the old branch. The write and the check are one statement (`writeProjectDefaultBranch`).
 *
 * **What a change resets** (WP-142, backlog 441/442): in the same transaction it clears every git
 * binding's `mr_poll_default_head`, so the next poll takes a baseline of the new branch and records
 * no `default_branch.moved` comparing two branches; after the commit it asks for a knowledge index of
 * the new branch. **It also marks the old branch's configuration reading `invalid` in that
 * transaction (runs are refused until the new branch is read; WP-147 review round 1) and, after the
 * commit, reads the new branch's `.agentic/config.yml` and asks for a readiness re-check
 * pinned to the commit read** (WP-147), so neither waits for the index run. A task cannot be created
 * at the instant of a change: task creation takes the project row `for share` (the Postgres
 * `tasks.insert`), which this write's `for update` waits for, and the reverse.
 */
import {
  apiErrorSchema,
  type JsonObject,
  type ProjectRecord,
  type ProjectRepositoryResponse,
  projectRepositoryResponseSchema,
  setDefaultBranchRequestSchema,
  setDefaultBranchResponseSchema,
  type UserRole,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  readIdempotencyKey,
} from './idempotency.js';

export const SET_DEFAULT_BRANCH_ACTION = 'project.default_branch.write';

/** What the provider says about the project's repository, or why it cannot be asked. */
export type ProviderRepositoryAnswer =
  | { readonly status: 'ok'; readonly provider: NonNullable<ProjectRepositoryResponse['provider']> }
  | { readonly status: 'unavailable'; readonly reason: string };

export type DefaultBranchWrite =
  | { readonly status: 'written'; readonly before: string; readonly project: ProjectRecord }
  | { readonly status: 'not_found' }
  | { readonly status: 'live_tasks'; readonly count: number };

export interface ProjectRepositoryQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  /** The stored default branch and the count of tasks that are not finished, or `null`. */
  readonly projectRepository: (
    projectId: string,
  ) => Promise<{ readonly defaultBranch: string; readonly liveTasks: number } | null>;
  readonly project: (projectId: string) => Promise<ProjectRecord | null>;
  readonly writeDefaultBranch: (projectId: string, branch: string) => Promise<DefaultBranchWrite>;
  readonly claimAttempt: IdempotencyRecords['claimAttempt'];
  readonly releaseAttempt: IdempotencyRecords['releaseAttempt'];
  readonly recordAction: (input: HumanActionInput) => Promise<void>;
}

export interface ProjectRepositoryRoutesOptions {
  readonly queries: ProjectRepositoryQueries;
  /**
   * The provider read, or `null` on a process that composed no integration stack: the read then
   * answers `provider: null` with that sentence, and the command still works.
   */
  readonly providerRepository: ((projectId: string) => Promise<ProviderRepositoryAnswer>) | null;
  /**
   * Asks for a knowledge index of the project's (new) default branch after a change commits
   * (WP-142, backlog 442), or `null` on a process that composed no integration stack. The index run
   * reads the stored branch when it fires and re-reads the repository configuration at the commit
   * it indexed. **After** the commit, not inside it: `Jobs.enqueue` joins no transaction, so an
   * enqueue made inside one would exist for a change that rolled back. A lost request is recovered
   * by the next task start, which requests an index of its own (`knowledge.index.task-start`).
   */
  readonly requestKnowledgeIndex: ((projectId: string) => Promise<void>) | null;
  /**
   * Reads the new default branch **at once** after a change commits (WP-147, backlog 442): the
   * repository configuration from the new branch's head, and a readiness re-check pinned to the
   * commit that read answered — so neither waits for the index run. `null` on a process that
   * composed no integration stack. A failure is logged and the change stands: the change already
   * marked the old branch's reading `invalid`, so runs wait, and the index run re-reads both. The
   * response waits on this read (a mirror fetch).
   */
  readonly readNewDefaultBranch:
    | ((projectId: string) => Promise<{
        readonly config: string;
        readonly commitSha: string | null;
        readonly recheckRequested: boolean;
      }>)
    | null;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

/** The sentence a live task's refusal carries; the count is the read's `live_tasks`. */
export const liveTasksRefusal = (count: number): string =>
  `this project has ${count} task${count === 1 ? '' : 's'} that ${count === 1 ? 'is' : 'are'} not finished; a live task's branch, merge request and gates were made against the current default branch, so finish or cancel ${count === 1 ? 'it' : 'them'} first`;

/**
 * WP-142: the index request that follows a committed change. A failure is logged and does not undo
 * the change, which has committed and been recorded; the next task start requests one again.
 */
const requestIndexAfterChange = async (
  options: ProjectRepositoryRoutesOptions,
  request: FastifyRequest,
  projectId: string,
): Promise<void> => {
  if (options.requestKnowledgeIndex === null) {
    request.log.warn(
      { project_id: projectId },
      'the default branch changed on a process that composed no integrations; no knowledge index was requested, so the next task start will index the new branch',
    );
    return;
  }
  try {
    await options.requestKnowledgeIndex(projectId);
  } catch (error) {
    request.log.error(
      { project_id: projectId, err: error },
      'the default branch changed but the knowledge index of the new branch could not be requested; the next task start requests one',
    );
  }
};

/**
 * WP-147: the new branch's configuration and readiness reads that follow a committed change. Like
 * the index request, a failure is logged and does not undo the change.
 */
const readNewBranchAfterChange = async (
  options: ProjectRepositoryRoutesOptions,
  request: FastifyRequest,
  projectId: string,
): Promise<void> => {
  if (options.readNewDefaultBranch === null) {
    return;
  }
  try {
    const reading = await options.readNewDefaultBranch(projectId);
    const fields = {
      project_id: projectId,
      config: reading.config,
      commit_sha: reading.commitSha,
      recheck_requested: reading.recheckRequested,
    };
    if (reading.config === 'recorded') {
      request.log.info(fields, 'the new default branch’s configuration was read');
    } else {
      request.log.warn(
        fields,
        'the new default branch’s configuration could not be read now; the knowledge index run reads it',
      );
    }
  } catch (error) {
    request.log.error(
      { project_id: projectId, err: error },
      'the default branch changed but its configuration could not be read now; the knowledge index run reads it',
    );
  }
};

export const registerProjectRepositoryRoutes = async (
  app: FastifyInstance,
  options: ProjectRepositoryRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  /** The guards run before validation (`routes/settings.ts`): a non-uuid is organisation-scoped. */
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  typed.get(
    '/api/projects/:project_id/repository',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'The project’s default branch, beside what its git provider says',
        description:
          '`default_branch` is the stored branch every run checks out, every merge request targets and the mirror reads. `provider` is the git binding’s provider’s own answer — its default branch and where its CI configuration lives (`repository` path, `external` for another project’s file or a URL, `unknown` when it does not say) — read through the integration executor; `null` with `provider_unavailable` when the project has no git binding or the read failed. Provider text is untrusted. `live_tasks` counts the tasks that would refuse a change of the default branch.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: projectRepositoryResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const stored = await options.queries.projectRepository(projectId);
      if (stored === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      const answer: ProviderRepositoryAnswer =
        options.providerRepository === null
          ? {
              status: 'unavailable',
              reason:
                'this process composed no integrations, so it cannot ask the git provider; type the branch',
            }
          : await options.providerRepository(projectId);
      return projectRepositoryResponseSchema.parse({
        default_branch: stored.defaultBranch,
        provider: answer.status === 'ok' ? answer.provider : null,
        provider_unavailable: answer.status === 'ok' ? null : answer.reason.slice(0, 1024),
        live_tasks: stored.liveTasks,
      });
    },
  );

  typed.put(
    '/api/projects/:project_id/default-branch',
    {
      preValidation: requirePermission(guard, 'project.pipeline.write', { project: projectOf }),
      schema: {
        summary: 'Change the project’s default branch',
        description:
          'Writes `projects.default_branch` — the branch runs check out, merge requests target and the mirror reads — and, when it changes, forgets the poll’s last head and marks the old branch’s `.agentic/config.yml` reading `invalid` (runs are refused until the new branch is read) in the same transaction; once committed it requests a knowledge index of the new branch and reads the new branch’s file and a readiness re-check pinned to that commit — **the response waits on that read, which may fetch the platform’s mirror from the git host**; a failed read is logged and the change stands. Maintainer. Refused `409 project_has_live_tasks` while any of the project’s tasks is not done or cancelled. One `human_actions` row per accepted request, with the branch before and after; `Idempotency-Key` is optional and honoured, so a replay writes no second row. The branch is not checked against the provider: `GET …/repository` shows what the provider says.',
        tags: ['projects'],
        params: projectParamsSchema,
        body: setDefaultBranchRequestSchema,
        response: {
          200: setDefaultBranchResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const actor = request.actor;
      if (actor === undefined) {
        // Unreachable through `requirePermission`; the audit row's user is not optional.
        throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
      }
      const projectId = request.params.project_id;
      const branch = request.body.default_branch;
      const key = readIdempotencyKey(request);
      const claim = await claimIdempotentAttempt(options.queries, {
        userId: actor.userId,
        action: SET_DEFAULT_BRANCH_ACTION,
        key,
        request: { project_id: projectId, body: request.body },
      });
      if (claim.replayed) {
        // A replay performs nothing and answers with the project as it is now.
        const current = await options.queries.project(projectId);
        if (current === null) {
          throw new NotFoundError(`project ${projectId}`);
        }
        return { project: current, performed: false };
      }
      const project = await claim.run(async (effectReturned) => {
        const written = await options.queries.writeDefaultBranch(projectId, branch);
        if (written.status === 'not_found') {
          throw new NotFoundError(`project ${projectId}`);
        }
        if (written.status === 'live_tasks') {
          throw new HttpError(409, 'project_has_live_tasks', liveTasksRefusal(written.count));
        }
        effectReturned();
        const params: JsonObject = {
          project_id: projectId,
          before: written.before,
          after: branch,
          ...(key === null ? {} : { idempotency_key: key }),
          ...(claim.digest === null ? {} : { body_digest: claim.digest }),
        };
        await options.queries.recordAction({
          userId: actor.userId,
          action: SET_DEFAULT_BRANCH_ACTION,
          params,
        });
        return written.project;
      });
      await requestIndexAfterChange(options, request, projectId);
      await readNewBranchAfterChange(options, request, projectId);
      return { project, performed: true };
    },
  );
};
