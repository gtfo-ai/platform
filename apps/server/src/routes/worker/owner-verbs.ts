/**
 * **The worker protocol's two owner verbs** — WP-292, TD-031's 2026-11-04 worker-UI amendment §4–5:
 *
 *   POST /api/worker/v1/manual-pause        worker credential, protocol ≥ 2 — `{ paused }`
 *   POST /api/worker/v1/runs/:id/cancel     run token, protocol ≥ 2, `Idempotency-Key` — `{ reason? }`
 *
 * Both are a person's act on the worker's local page, carried by the worker; **the core decides
 * each**, because each changes shared state.
 *
 * - **`manual-pause`** is a state assertion stored in `workers.manually_paused_at`: one
 *   `human_actions` row per change (`worker.pause` / `worker.resume`, `via: worker_ui`, the worker's
 *   user), none for a repeat. The claim and the online-assignee rule leave a held worker out.
 * - **`runs/:id/cancel`** performs the **same application command** as `POST
 *   /api/runs/:run_id/cancel` — `TaskCommands.cancelRun` — as the worker's user, under the same
 *   `run.cancel` permission (a user below it is `403` and the run continues), with the same
 *   idempotency record (`(user, 'run.cancel', key)`) and the same `human_actions` row plus `via:
 *   'worker_ui'` and the worker's id. The worker holds the lease, so it is the `202` branch: a
 *   `run_commands` row the worker's own heartbeat delivers, and the task is paused (Q126).
 *
 * **A version-1 request is `426`** on both: the verbs do not exist at protocol 1, and a worker that
 * reaches them speaking 1 is a worker that cannot read their answers' context.
 */
import type { RunTokenSubject } from '@platform/application';
import {
  ACCEPTED_WORKER_PROTOCOLS,
  apiErrorSchema,
  type Id,
  type JsonObject,
  parseWorkerProtocolHeader,
  type UserRole,
  WORKER_PATHS,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_LOCAL_UI,
  type WorkerUpgradeRequiredBody,
  workerManualPauseRequestSchema,
  workerManualPauseResponseSchema,
  workerRunCancelRequestSchema,
  workerRunCancelResponseSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import { can } from '@platform/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { effectiveRole } from '../../auth/rbac.js';
import type { TaskCommands } from '../../commands.js';
import { commandRefusal, ForbiddenError, HttpError } from '../../errors.js';
import type { WorkerStore } from '../../queries/worker-queries.js';
import type { CommandQueries } from '../commands.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  requireIdempotencyKey,
} from '../idempotency.js';

/**
 * What the worker's cancel needs from the core besides the worker store: the task page's command,
 * the reads its guard makes, and the idempotency record and audit row the command routes write.
 * Injected so this module names no database (`routes/commands.ts`'s reason).
 */
export interface WorkerRunCancelPort extends IdempotencyRecords {
  readonly cancelRun: TaskCommands['cancelRun'];
  readonly runProjectId: CommandQueries['runProjectId'];
  readonly runPosition: CommandQueries['runPosition'];
  readonly projectRole: CommandQueries['projectRole'];
  /** The user's organisation role, or `null` for no such user. */
  readonly userRole: (userId: string) => Promise<UserRole | null>;
  readonly recordAction: CommandQueries['recordAction'];
}

export interface WorkerOwnerVerbOptions {
  readonly store: WorkerStore;
  /** `null`: this process composed no task commands — `503` by name after authentication. */
  readonly runCancel: WorkerRunCancelPort | null;
  readonly path: (verb: string) => string;
  /** `protocol.ts`'s `426` body for the version a request spoke (its `accepted`, `compose_url`, …). */
  readonly upgradeBody: (presented: number | null) => WorkerUpgradeRequiredBody;
  readonly authenticateWorker: (request: FastifyRequest) => Promise<void>;
  readonly authenticateRun: (request: FastifyRequest) => Promise<void>;
  /** The authenticated worker, its contact recorded (`protocol.ts`). */
  readonly workerOf: (request: FastifyRequest) => Promise<{ readonly workerId: Id }>;
  readonly runHolder: (request: FastifyRequest) => RunTokenSubject;
  readonly now: () => Date;
}

const runParamsSchema = z.strictObject({ id: z.uuid() });

/**
 * `426` for a request below {@link WORKER_PROTOCOL_LOCAL_UI} — `preValidation`, before the
 * credential is read. The generic check (`registerWorkerProtocolCheck`) has already admitted the
 * version as one this core serves; this refusal is the verb's.
 */
const requireLocalUiProtocol =
  (upgradeBody: WorkerOwnerVerbOptions['upgradeBody'], verb: string) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const version = parseWorkerProtocolHeader(request.headers[WORKER_PROTOCOL_HEADER]);
    if (version !== null && version >= WORKER_PROTOCOL_LOCAL_UI) {
      return undefined;
    }
    const body = upgradeBody(version);
    return reply.code(426).send(
      workerUpgradeRequiredBodySchema.parse({
        ...body,
        error: {
          code: 'upgrade_required',
          message: `${verb} is a worker protocol ${WORKER_PROTOCOL_LOCAL_UI} verb; this request spoke ${version ?? 'no version'} (this core serves ${ACCEPTED_WORKER_PROTOCOLS.join(', ')}) — update the worker`,
        },
      }),
    );
  };

const unauthenticated = (what: string): HttpError =>
  new HttpError(401, 'unauthenticated', `${what} (TD-031 §7)`);

export const registerWorkerOwnerVerbs = (
  app: FastifyInstance,
  options: WorkerOwnerVerbOptions,
): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    options.path(WORKER_PATHS.manualPause),
    {
      preValidation: [
        requireLocalUiProtocol(options.upgradeBody, WORKER_PATHS.manualPause),
        options.authenticateWorker,
      ],
      schema: {
        summary: 'Hold or release the worker’s claiming — its owner, from the local page (WP-292)',
        description:
          'Worker credential, protocol ≥ 2. A state assertion over `workers.manually_paused_at`: `paused: true` sets it (kept when already set), `false` clears it. One `human_actions` row per change (`worker.pause` / `worker.resume`, `params: {worker_id, via: worker_ui}`, the worker’s user), none for a repeat (`performed: false`). While held, the claim and the online-assignee rule leave the worker out; runs it holds continue. `426` below protocol 2.',
        tags: ['worker'],
        body: workerManualPauseRequestSchema,
        response: {
          200: workerManualPauseResponseSchema,
          401: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
        },
      },
    },
    async (request): Promise<z.output<typeof workerManualPauseResponseSchema>> => {
      const { workerId } = await options.workerOf(request);
      const result = await options.store.setManualPause({
        workerId,
        paused: request.body.paused,
        now: options.now(),
      });
      if (result.status === 'not_found') {
        throw unauthenticated('the worker credential names no worker');
      }
      return {
        manually_paused_at:
          result.manuallyPausedAt === null
            ? null
            : (result.manuallyPausedAt.toISOString() as never),
        performed: result.performed,
      };
    },
  );

  typed.post(
    options.path(WORKER_PATHS.runCancel),
    {
      preValidation: [
        requireLocalUiProtocol(options.upgradeBody, WORKER_PATHS.runCancel),
        options.authenticateRun,
      ],
      schema: {
        summary: 'Cancel a run from the worker’s local page — the task page’s cancel (WP-292)',
        description:
          'Run token, protocol ≥ 2, `Idempotency-Key` required. The same application command as `POST /api/runs/:run_id/cancel`, as the worker’s user and under the same `run.cancel` permission — a user below it is `403` and the run continues. The worker holds the lease, so the stop is recorded for its heartbeat (`202`, `command_id`) and the task is paused; with no live lease the run is ended here (`200`, `command_id: null`). One `human_actions` row `run.cancel` with `via: worker_ui`; a replay under the key performs nothing and answers the first attempt. `426` below protocol 2.',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerRunCancelRequestSchema,
        response: {
          200: workerRunCancelResponseSchema,
          202: workerRunCancelResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const runId = request.params.id;
      const subject = options.runHolder(request);
      const port = options.runCancel;
      if (port === null) {
        throw new HttpError(
          503,
          'commands_unavailable',
          'this process composed no pipeline, so it cannot cancel a run; ask another API replica',
        );
      }
      const key = requireIdempotencyKey(request);
      // The worker's user, re-read now: the token authenticated the run, the credential row says
      // whose machine it is and whether that person may still act.
      const owner = await options.store.findCredentialSubject(subject.workerId);
      const orgRole = owner === null || !owner.usable ? null : await port.userRole(owner.userId);
      if (owner === null || orgRole === null) {
        throw unauthenticated('the worker’s user may not act');
      }
      const projectId = await port.runProjectId(runId);
      const role = effectiveRole(
        orgRole,
        projectId === null ? null : await port.projectRole(projectId, owner.userId),
      );
      if (!can(role, 'run.cancel')) {
        throw new ForbiddenError('run.cancel', role);
      }
      const attempt = await claimIdempotentAttempt(port, {
        userId: owner.userId,
        action: 'run.cancel',
        key,
        request: { run_id: runId, body: request.body },
      });
      let commandId: string | null = null;
      if (attempt.replayed) {
        const previous = attempt.previous?.command_id;
        commandId = typeof previous === 'string' ? previous : null;
      } else {
        commandId = await attempt.run(async (effectReturned) => {
          let result: Awaited<ReturnType<TaskCommands['cancelRun']>>;
          try {
            result = await port.cancelRun({ runId, userId: owner.userId, idempotencyKey: key });
          } catch (error) {
            throw commandRefusal(error) ?? error;
          }
          effectReturned();
          const params: JsonObject = {
            run_id: runId,
            via: 'worker_ui',
            worker_id: subject.workerId,
            command_id: result.commandId,
            idempotency_key: key,
            ...(attempt.digest === null ? {} : { body_digest: attempt.digest }),
          };
          await port.recordAction({
            userId: owner.userId,
            action: 'run.cancel',
            params,
            taskId: result.taskId,
          });
          return result.commandId;
        });
      }
      const position = await port.runPosition(runId);
      if (position === null) {
        throw new HttpError(404, 'not_found', `run ${runId} does not exist`);
      }
      return reply.code(commandId === null ? 200 : 202).send({
        run_id: runId,
        task_id: position.taskId,
        status: position.status,
        task_state: position.taskState,
        performed: !attempt.replayed,
        command_id: commandId,
      });
    },
  );
};
