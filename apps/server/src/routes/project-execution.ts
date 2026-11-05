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
 *
 * **And who would run it** (S-22.19, the worker UX review's N2): each registered worker the reader
 * may see, whether it takes this project's runs by itself, only when picked, or not at all, and why
 * — the Workers screen's blockers (`coreClaimBlockersOf`) and the project's own reason — plus the
 * open offers and how many no worker may take now. All reads; nothing here changes routing.
 */
import {
  apiErrorSchema,
  type JsonObject,
  type ProjectExecutionResponse,
  type ProjectExecutionWaiting,
  type ProjectExecutionWorker,
  projectExecutionResponseSchema,
  putProjectExecutionRequestSchema,
  putProjectExecutionResponseSchema,
  type UserRole,
} from '@platform/contracts';
import {
  can,
  coreClaimBlockersOf,
  DEFAULT_EXECUTION_SETTINGS,
  type ExecutionSettings,
  effectiveFallbackAfterSeconds,
  executionNotice,
  type RunImageDigests,
} from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { ExecutionWrite } from '../queries/execution-queries.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import type { ProjectWorkerRow } from '../queries/worker-queries.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  readIdempotencyKey,
} from './idempotency.js';
import { claimFactsOf } from './workers.js';

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
  /**
   * The registered workers (not revoked) and whether each one's user may run here — every worker
   * for `userId: null` (an administrator), the user's own otherwise (S-22.19, N2).
   */
  readonly workersFor: (projectId: string, userId: string | null) => Promise<ProjectWorkerRow[]>;
  /** The project's open offers, and how many have no `workers_from` / one still ahead (N2). */
  readonly waitingOffers: (
    projectId: string,
  ) => Promise<{ readonly open: number; readonly never: number; readonly later: number }>;
  /** The core's current run and egress digests, or `null` (`routes/workers.ts`'s same option). */
  readonly coreDigests?: () => RunImageDigests | null;
}

/** What the read adds to the setting (S-22.19, N2): who would take the runs, and what waits. */
export interface ExecutionAudience {
  readonly workers: readonly ProjectExecutionWorker[];
  readonly waiting: ProjectExecutionWaiting;
}

/**
 * One worker against one project (S-22.19, N2). The project's reason comes first in the order the
 * claim would refuse it — the project's mode, its run credential, the worker's user's role — then
 * the claim scope, which keeps the worker from taking the runs **by itself** only: its owner may
 * still pick one, so a scope that leaves the project out is `picked_only` (and *pick only*, `[]`,
 * leaves every project out). Any blocker of the worker's own is `no`, whatever the project says.
 */
export const projectWorkerOf = (
  row: ProjectWorkerRow,
  input: {
    readonly projectId: string;
    readonly settings: ExecutionSettings;
    readonly credentialRefused: boolean;
    readonly coreDigests: RunImageDigests | null;
    readonly now: Date;
  },
): ProjectExecutionWorker => {
  const blockers = coreClaimBlockersOf({
    ...claimFactsOf(row, input.coreDigests, input.now),
    eligibleProjects: null,
  });
  const scope = row.claimProjects;
  const reason: ProjectExecutionWorker['project_reason'] =
    input.settings.mode === 'server_only'
      ? 'server_only'
      : input.credentialRefused
        ? 'credential_refused'
        : !row.mayRunInProject
          ? 'role'
          : scope !== null && !scope.some((project) => project.id === input.projectId)
            ? 'scope_excludes'
            : null;
  const takes: ProjectExecutionWorker['takes'] =
    blockers.length > 0 || (reason !== null && reason !== 'scope_excludes')
      ? 'no'
      : reason === 'scope_excludes'
        ? 'picked_only'
        : 'automatically';
  return {
    worker_id: row.id,
    name: row.name,
    owner: { id: row.userId, name: row.userName, email: row.userEmail },
    takes,
    blockers,
    project_reason: reason,
  };
};

/**
 * The open offers no worker may take now, each under the first reason that holds (N2): the
 * project's run credential refuses every one that routing would give a worker; otherwise one with
 * no `workers_from` was routed to the server only, and one whose `workers_from` is ahead waits out
 * the server's head start.
 */
export const waitingOf = (
  counts: { readonly open: number; readonly never: number; readonly later: number },
  credentialRefused: boolean,
): ProjectExecutionWaiting => ({
  open: counts.open,
  closed_to_workers: {
    credential_refused: credentialRefused ? counts.open - counts.never : 0,
    server_only: counts.never,
    server_first: credentialRefused ? 0 : counts.later,
  },
});

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
  audience: ExecutionAudience = {
    workers: [],
    waiting: {
      open: 0,
      closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
    },
  },
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
    workers: audience.workers,
    waiting: audience.waiting,
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
  const current = async (
    projectId: string,
    request: FastifyRequest,
  ): Promise<ProjectExecutionResponse> => {
    if (!(await queries.projectExists(projectId))) {
      throw new NotFoundError(`project ${projectId}`);
    }
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`; whose workers to list is not optional.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    const stored = await queries.execution(projectId);
    const refused = (await queries.remoteRunCredentialRefused?.(projectId)) ?? false;
    const settings = stored ?? DEFAULT_EXECUTION_SETTINGS;
    const coreDigests = queries.coreDigests?.() ?? null;
    const now = new Date();
    // Another person's machine is theirs to name: an administrator sees every worker (the Workers
    // screen's own rule, `org.workers.manage`), anyone else their own.
    const rows = await queries.workersFor(
      projectId,
      can(actor.role, 'org.workers.manage') ? null : actor.userId,
    );
    return executionDocument(stored, await queries.serverClaimantRunning(), refused, {
      workers: rows.map((row) =>
        projectWorkerOf(row, { projectId, settings, credentialRefused: refused, coreDigests, now }),
      ),
      waiting: waitingOf(await queries.waitingOffers(projectId), refused),
    });
  };

  typed.get(
    '/api/projects/:project_id/execution',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'Where this project’s agent runs execute',
        description:
          'TD-031 decision 8. `stored: false` is the defaults (`hybrid`, the server preferred, a 120 s assignee window, a 24 h offer timeout); `fallback_after_seconds: null` is the preference’s default (15 s for the server, 300 s for workers), and `effective_fallback_after_seconds` is what it resolves to. `server_claimant` is whether **this instance** has a server runner claiming offers now; with `none`, `notice` says what that does to this project’s mode — a `hybrid` project opens its runs to workers at once, a `server_only` project’s runs wait. Never set by `.agentic/config.yml`. **Who would run it** (S-22.19): `workers` — every registered worker for an administrator, your own otherwise — each `automatically`, `picked_only` or `no`, with its own `blockers` and the project’s `project_reason`; `waiting` — the open offers, and how many no worker may take now and why.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: projectExecutionResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => current(request.params.project_id, request),
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
        return { execution: await current(projectId, request), performed: false };
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
      return { execution: await current(projectId, request), performed: true };
    },
  );
};
