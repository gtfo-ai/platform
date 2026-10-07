/**
 * A maintainer's **re-evaluate** — discovery run again (WP-94, PROGRESS backlog 230, Q107 (a)).
 *
 *   POST /api/projects/:project_id/rediscovery   open a new one-off discovery task
 *   GET  /api/projects/:project_id/rediscovery   the gate and the estimate the button shows
 *
 * The command is WP-15i's shape, clause by clause: a maintainer capability on the project, an
 * `Idempotency-Key` that is **required** (a repeat would spend a second discovery budget), claimed
 * before the command performs, one `human_actions` row per accepted command and none for a refused
 * one, and the guards at `preValidation` so an anonymous caller is refused before learning a shape.
 *
 * ## The capability, decided
 *
 * `discovery.run` (maintainer) — the capability the first discovery already asks for, and the one
 * act this is. Q107's recommendation names `project.settings.write` *(maintainer)*; on this build
 * that capability is **admin** (`permissions.ts`), so taking the name would have made the button an
 * administrator's, against the recommendation's stated intent that a maintainer may press it. The
 * role is what the recommendation decided; the name was a slip, recorded under WP-94.
 *
 * ## What the answers are
 *
 * `202` with `started: true` for a new task; `200` with `started: false` and the live task's id when
 * a discovery is already running or parked (the first discovery's `already_started` shape — the
 * caller is told which task to follow, not refused); `409` with a typed code for the three refusals
 * the gate names (`discovery_not_started`, `discovery_unavailable`, `rediscovery_attempts_spent`).
 * A replay under the same key answers from the audit row and performs nothing.
 *
 * ## The gate is on the read
 *
 * `GET` answers `can_start`, the blocker and the estimate from `readRediscoveryGate` — the same
 * function the command decides with — so the screen disables the button with the reason instead of
 * offering one that answers 409 (`routes/bootstrap.ts`' rule). The estimate is the stage's run
 * budget (a ceiling) beside what the last discovery cost; the screen shows both.
 */
import {
  apiErrorSchema,
  type Id,
  rediscoveryGateResponseSchema,
  startDiscoveryResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { OnboardingCommands } from '../onboarding.js';
import { OnboardingUnavailableError } from '../onboarding.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  requireIdempotencyKey,
} from './idempotency.js';

export interface RediscoveryQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<string | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  readonly claimAttempt: IdempotencyRecords['claimAttempt'];
  readonly releaseAttempt: IdempotencyRecords['releaseAttempt'];
  readonly recordAction: (input: HumanActionInput) => Promise<void>;
}

/** The application's gate, as the composition root reads it (`createRediscoveryGate`). */
export type RediscoveryGateReader = (projectId: string) => Promise<{
  readonly ceilingUsd: number;
  readonly lastDiscovery: {
    readonly taskId: string;
    readonly state: string;
    readonly costUsd: number;
    /** WP-124: why this task's findings were never recorded, when the recovery gave up. */
    readonly findingsUnrecorded?: { readonly at: string; readonly reason: string } | null;
    /** WP-155: the newest escalation, while the task is `needs_human`. */
    readonly escalation?: {
      readonly at: string;
      readonly reason: string;
      readonly brief: string;
    } | null;
  } | null;
  readonly blocker: {
    readonly code: string;
    readonly detail: string;
    readonly taskId?: string;
  } | null;
}>;

export interface RediscoveryRoutesOptions {
  readonly queries: RediscoveryQueries;
  /** The re-evaluate command, or `null` on a process that composed no onboarding commands. */
  readonly commands: Pick<OnboardingCommands, 'startRediscovery'> | null;
  /** The gate, or `null` on a process that cannot read settings — the read then answers 503. */
  readonly gate: RediscoveryGateReader | null;
}

/** The `human_actions.action` this command records, and the scope its `Idempotency-Key` lives in. */
export const REDISCOVERY_START_ACTION = 'project.discovery.rerun';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

export const registerRediscoveryRoutes = async (
  app: FastifyInstance,
  options: RediscoveryRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      (await options.queries.projectRole(projectId, userId)) as never,
  };
  // The guards run before validation (`routes/onboarding.ts` carries the argument).
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };
  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };
  const commands = (): Pick<OnboardingCommands, 'startRediscovery'> => {
    if (options.commands === null) {
      throw new HttpError(
        503,
        'onboarding_unavailable',
        'this process composed no onboarding commands: it serves the API without a pipeline, so it cannot run discovery again. Ask an instance that runs the workers',
      );
    }
    return options.commands;
  };

  typed.post(
    '/api/projects/:project_id/rediscovery',
    {
      preValidation: requirePermission(guard, 'discovery.run', { project: projectOf }),
      schema: {
        summary: 'Run discovery again on this project (a maintainer’s re-evaluate)',
        description:
          'Opens a **new** one-off task on the `discovery` template beside the first, so the run is admitted by the same budget guard, charged to the same cost ledger, transcribed and escalated like every run; its evaluation is recorded with `source: rediscovery` and the first run’s record stands. Spends up to the `discovery` stage’s run budget — `GET` this path first for the ceiling and what the last discovery cost. Answers `started: false` with the live task while a discovery is running or parked, and `409` when the project never ran discovery, has no discovery template, or three re-evaluations since the latest evaluation recorded nothing. Requires `Idempotency-Key`; a replay performs nothing.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: {
          200: startDiscoveryResponseSchema,
          202: startDiscoveryResponseSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      const projectId = request.params.project_id;
      const actor = actorOf(request);
      // The body is empty, so the request *is* the project the path names.
      const replay = await claimIdempotentAttempt(options.queries, {
        userId: actor.userId,
        action: REDISCOVERY_START_ACTION,
        key,
        request: { project_id: projectId },
      });
      if (replay.replayed) {
        const taskId = replay.previous?.task_id;
        if (typeof taskId !== 'string') {
          throw new HttpError(
            409,
            'idempotency_key_reused',
            'this Idempotency-Key has already run discovery again, and its audit row names no task; use a new key',
          );
        }
        return {
          task_id: taskId,
          started: false,
          detail: 'this Idempotency-Key already ran discovery again; follow the task',
        };
      }
      return replay.run(async (performed) => {
        if (!(await options.queries.projectExists(projectId))) {
          throw new NotFoundError(`project ${projectId}`);
        }
        let result: Awaited<ReturnType<OnboardingCommands['startRediscovery']>>;
        try {
          result = await commands().startRediscovery({
            projectId: projectId as Id,
            userId: actor.userId as Id,
          });
        } catch (error) {
          if (error instanceof OnboardingUnavailableError) {
            throw new HttpError(503, 'onboarding_unavailable', error.message);
          }
          throw error;
        }
        if (result.status === 'refused') {
          throw new HttpError(409, result.code, result.detail);
        }
        if (result.status === 'in_flight') {
          // Nothing performed: the key is given back and nothing is audited.
          return { task_id: result.taskId, started: false, detail: result.detail };
        }
        performed();
        await options.queries.recordAction({
          userId: actor.userId,
          action: REDISCOVERY_START_ACTION,
          params: {
            project_id: projectId,
            task_id: result.taskId,
            // What the maintainer was spending against, in the audit (product/09).
            ceiling_usd: result.ceilingUsd,
            idempotency_key: key,
            ...(replay.digest === null ? {} : { body_digest: replay.digest }),
          },
          taskId: result.taskId,
        });
        reply.code(202);
        return { task_id: result.taskId, started: true, detail: result.detail };
      });
    },
  );

  typed.get(
    '/api/projects/:project_id/rediscovery',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'Whether discovery may run again on this project, and what it may cost',
        description:
          '`can_start` and `blocker` are the answer the command decides with, published so the screen states the reason instead of offering a button that fails. `ceiling_usd` is the `discovery` stage’s run budget — the figure the admission guard reserves, a cap and not a prediction; `last_discovery.cost_usd` is what the project’s most recent discovery task actually cost, and `last_discovery.escalation` why it waits for a person while it is `needs_human`.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: rediscoveryGateResponseSchema, 404: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (options.gate === null) {
        throw new HttpError(
          503,
          'onboarding_unavailable',
          'this process cannot read the project’s settings, so it cannot say whether discovery may run again',
        );
      }
      const gate = await options.gate(projectId);
      return {
        can_start: gate.blocker === null,
        blocker:
          gate.blocker === null
            ? null
            : {
                code: gate.blocker.code as never,
                detail: gate.blocker.detail,
                task_id: gate.blocker.taskId ?? null,
              },
        ceiling_usd: gate.ceilingUsd,
        last_discovery:
          gate.lastDiscovery === null
            ? null
            : {
                task_id: gate.lastDiscovery.taskId,
                state: gate.lastDiscovery.state as never,
                cost_usd: gate.lastDiscovery.costUsd,
                findings_unrecorded: gate.lastDiscovery.findingsUnrecorded ?? null,
                escalation: gate.lastDiscovery.escalation ?? null,
              },
      };
    },
  );
};
