/**
 * Where a project's agent runs execute — WP-278, TD-031 decision 8, BD-032 decisions 3 and 5.
 *
 *   GET /api/projects/:project_id/execution   the setting (or the defaults), and the instance's claimant
 *   PUT /api/projects/:project_id/execution   replace it
 *
 * **An administrator's** (`project.settings.write`): where code runs and whose subscription pays is a
 * trust decision, which is also why it is never a key of `.agentic/config.yml` (the file's schema
 * refuses `execution` by name). The read is `project.read`, like every other project setting.
 *
 * The write is WP-15i's shape (`./project-repository.ts` set it for settings): an optional
 * `Idempotency-Key`, claimed before the write, so a replay writes nothing twice and a different body
 * under a used key is refused; one `human_actions` row per accepted request with the setting
 * **before** and **after**; none for a refused one. It changes the routing of offers written
 * **after** it — an offer already open keeps the timestamps it was written with (TD-031 §8 computes
 * them at offer time).
 *
 * The read says whether the instance has a server claimant **now** (`server_claimants`, renewed by
 * every running claimant) and, when it has none, what that does to this project's mode (TD-031 §8:
 * *"says so on the settings screen"*) — `executionNotice` in `@platform/domain` is the sentence.
 */
import {
  apiErrorSchema,
  type JsonObject,
  type ProjectExecutionResponse,
  projectExecutionResponseSchema,
  putProjectExecutionRequestSchema,
  putProjectExecutionResponseSchema,
  type UserRole,
} from '@platform/contracts';
import {
  DEFAULT_EXECUTION_SETTINGS,
  type ExecutionSettings,
  effectiveFallbackAfterSeconds,
  executionNotice,
} from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { ExecutionWrite } from '../queries/execution-queries.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  readIdempotencyKey,
} from './idempotency.js';

export const SET_EXECUTION_ACTION = 'project.execution.write';

export interface ProjectExecutionQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  /** The stored settings, or `null` (the defaults). */
  readonly execution: (projectId: string) => Promise<ExecutionSettings | null>;
  readonly writeExecution: (
    projectId: string,
    settings: ExecutionSettings,
  ) => Promise<ExecutionWrite>;
  /** Whether the instance has a server claimant running now (`server_claimants`). */
  readonly serverClaimantRunning: () => Promise<boolean>;
  /**
   * Whether the project's run credential keeps remote workers off its runs (WP-283, Q124 (a)): a
   * static token or a deploy key without `remote_run_credential: allow`. Absent answers `false`.
   */
  readonly remoteRunCredentialRefused?: (projectId: string) => Promise<boolean>;
  readonly claimAttempt: IdempotencyRecords['claimAttempt'];
  readonly releaseAttempt: IdempotencyRecords['releaseAttempt'];
  readonly recordAction: (input: HumanActionInput) => Promise<void>;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

/** The settings on the wire (snake_case, whole seconds). */
const wireOf = (settings: ExecutionSettings): JsonObject => ({
  mode: settings.mode,
  prefer: settings.prefer,
  fallback_after_seconds: settings.fallbackAfterSeconds,
  assignee_window_seconds: settings.assigneeWindowSeconds,
  offer_timeout_seconds: settings.offerTimeoutSeconds,
});

/** The read's document: the setting, the fallback it resolves to, and the instance's claimant. */
export const executionDocument = (
  stored: ExecutionSettings | null,
  serverClaimant: boolean,
  workersRefused = false,
): ProjectExecutionResponse => {
  const settings = stored ?? DEFAULT_EXECUTION_SETTINGS;
  const notices = [
    executionNotice(settings.mode, serverClaimant),
    // WP-283 (TD-031 decision 5, Q124 (a)): the claim's own clause, said where the setting is read.
    workersRefused && settings.mode !== 'server_only' ? REMOTE_CREDENTIAL_REFUSED_NOTICE : null,
  ].filter((notice): notice is string => notice !== null);
  return projectExecutionResponseSchema.parse({
    ...wireOf(settings),
    effective_fallback_after_seconds: effectiveFallbackAfterSeconds(settings),
    stored: stored !== null,
    server_claimant: serverClaimant ? 'running' : 'none',
    notice: notices.length === 0 ? null : notices.join(' '),
  });
};

/** Why no remote worker takes this project's runs, as the settings screen says it (WP-283). */
export const REMOTE_CREDENTIAL_REFUSED_NOTICE =
  'Remote workers take none of this project’s runs: its git integration gives runs a static token or a deploy key, and only an administrator’s remote_run_credential: allow on that integration lets either reach a developer’s machine.';

export const registerProjectExecutionRoutes = async (
  app: FastifyInstance,
  options: { readonly queries: ProjectExecutionQueries },
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { queries } = options;
  const guard = { projectRole: queries.projectRole };
  /** The guards run before validation (`routes/settings.ts`): a non-uuid is organisation-scoped. */
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };
  const current = async (projectId: string): Promise<ProjectExecutionResponse> => {
    if (!(await queries.projectExists(projectId))) {
      throw new NotFoundError(`project ${projectId}`);
    }
    return executionDocument(
      await queries.execution(projectId),
      await queries.serverClaimantRunning(),
      (await queries.remoteRunCredentialRefused?.(projectId)) ?? false,
    );
  };

  typed.get(
    '/api/projects/:project_id/execution',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'Where this project’s agent runs execute',
        description:
          'TD-031 decision 8. `stored: false` is the defaults (`hybrid`, the server preferred, a 120 s assignee window, a 24 h offer timeout); `fallback_after_seconds: null` is the preference’s default (15 s for the server, 300 s for workers), and `effective_fallback_after_seconds` is what it resolves to. `server_claimant` is whether **this instance** has a server runner claiming offers now; with `none`, `notice` says what that does to this project’s mode — a `hybrid` project opens its runs to workers at once, a `server_only` project’s runs wait. Never set by `.agentic/config.yml`.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: projectExecutionResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => current(request.params.project_id),
  );

  typed.put(
    '/api/projects/:project_id/execution',
    {
      preValidation: requirePermission(guard, 'project.settings.write', { project: projectOf }),
      schema: {
        summary: 'Set where this project’s agent runs execute',
        description:
          'The **whole** setting (TD-031 decision 8, BD-032 decisions 3 and 5): `mode` (`server_only`, `workers_only`, `hybrid`), `prefer` (which side of `hybrid` may claim first), `fallback_after_seconds` (how long the other side waits; `null` for the preference’s default), `assignee_window_seconds` (the head start the ticket’s assignee’s — or an ask’s asker’s — online worker gets; `0` for none) and `offer_timeout_seconds` (how long an offer may wait for any claimant before it is withdrawn and its task escalated). Administrator. Applies to offers written after it; an open offer keeps its timestamps. One `human_actions` row per accepted request, with the setting before and after; `Idempotency-Key` is optional and honoured.',
        tags: ['projects'],
        params: projectParamsSchema,
        body: putProjectExecutionRequestSchema,
        response: {
          200: putProjectExecutionResponseSchema,
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
      const body = request.body;
      const settings: ExecutionSettings = {
        mode: body.mode,
        prefer: body.prefer,
        fallbackAfterSeconds: body.fallback_after_seconds,
        assigneeWindowSeconds: body.assignee_window_seconds,
        offerTimeoutSeconds: body.offer_timeout_seconds,
      };
      const key = readIdempotencyKey(request);
      const claim = await claimIdempotentAttempt(queries, {
        userId: actor.userId,
        action: SET_EXECUTION_ACTION,
        key,
        request: { project_id: projectId, body },
      });
      if (claim.replayed) {
        // A replay performs nothing and answers with the setting as it is now.
        return { execution: await current(projectId), performed: false };
      }
      await claim.run(async (effectReturned) => {
        const written = await queries.writeExecution(projectId, settings);
        if (written.status === 'not_found') {
          throw new NotFoundError(`project ${projectId}`);
        }
        effectReturned();
        await queries.recordAction({
          userId: actor.userId,
          action: SET_EXECUTION_ACTION,
          params: {
            project_id: projectId,
            before: written.before === null ? null : wireOf(written.before),
            after: wireOf(settings),
            ...(key === null ? {} : { idempotency_key: key }),
            ...(claim.digest === null ? {} : { body_digest: claim.digest }),
          },
        });
      });
      return { execution: await current(projectId), performed: true };
    },
  );
};
