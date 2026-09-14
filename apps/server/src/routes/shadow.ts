/**
 * Shadow mode's three endpoints — product/10:20's *"Shadow — shadow-mode runs: comparison with the
 * human MR, predicted cost, similarity"* (WP-34).
 *
 *   POST /api/projects/:project_id/shadow-batches    start a batch on N closed tickets
 *   GET  /api/projects/:project_id/shadow-batches    the project's batches, newest first
 *   GET  /api/shadow-batches/:batch_id               one batch, its tickets and its aggregate
 *
 * The **write** is WP-15i's command shape, and every clause of it is here rather than described:
 * a strict snake_case body, `shadow.run` (maintainer) on the project, an `Idempotency-Key` that is
 * **required** because a repeat would create a second batch of N tasks, a digest of the canonical
 * request stored beside the key so a *different* body under a used key is refused, one
 * `human_actions` row per accepted command and none for a refused one, and the guards at
 * `preValidation` so an anonymous caller is refused before being told the body's shape.
 *
 * ## Why the replay answer is the batch, and what is idempotent underneath it
 *
 * There is **no stored response** (`routes/onboarding.ts` made the same call): a replayed key with
 * the same body performs nothing twice because the underlying unique index does the deciding —
 * `tasks (project_id, ticket_key, mode)`, which is what turns the second attempt at a ticket into
 * the batch's own `already_shadowed` refusal. So a replay creates a batch **row** whose tickets are
 * all refusals, which is honest (somebody asked twice, and the second ask ran nothing) and is
 * countable: N tasks after the first call, N after the second. The `409 idempotency_key_reused`
 * guard is what stops the *different-body* case, which is the one that would otherwise create new
 * tasks under a key the caller believed was spent.
 *
 * ## The gate is published on the read, not discovered on the write
 *
 * `GET …/shadow-batches` answers `can_start` and `blocked_reason` from the same function the
 * command refuses with (`shadowBatchBlocker`), so the screen states *"shadow mode is off for this
 * project"* rather than offering a button that answers 409. Two spellings of one rule would be two
 * answers (standing rule 9), which is why the route calls the application's own predicate rather
 * than re-reading the configuration itself.
 */
import {
  apiErrorSchema,
  type Id,
  MAX_SHADOW_BATCH_TICKETS,
  shadowBatchesResponseSchema,
  shadowBatchResponseSchema,
  startShadowBatchRequestSchema,
  startShadowBatchResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import { OnboardingUnavailableError } from '../onboarding.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import type { ShadowBatchRead } from '../queries/shadow-queries.js';
import type { ShadowCommands } from '../shadow.js';
import { assertIdempotentRequest, configHashOf, requireIdempotencyKey } from './idempotency.js';
import { scopedProject, scopeToProject } from './scope.js';

/**
 * Everything these routes read or write outside the application ring, as seven functions.
 *
 * Injected rather than imported, exactly as `routes/commands.ts` takes its seven: the decisions
 * this file owns — the key policy, the replay, which capability each route asks for, which refusal
 * maps to which status and what lands in the audit row — are decisions, and *"a decision that needs
 * a PostgreSQL container to exercise is a decision no fast tier asserts"*.
 */
export interface ShadowQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<string | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  readonly previousAttempt: (query: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
  }) => Promise<{ readonly bodyDigest: string | null } | null>;
  readonly recordAction: (input: HumanActionInput) => Promise<void>;
  readonly listBatches: (
    projectId: string,
    gate: { readonly canStart: boolean; readonly blockedReason: string | null },
  ) => Promise<unknown>;
  readonly findBatch: (batchId: string) => Promise<ShadowBatchRead>;
  /**
   * The project a batch belongs to, or `null` when no such batch exists.
   *
   * `GET /api/shadow-batches/:batch_id` is project-scoped in the read and had to be project-scoped
   * in the guard too; this is what `scopeToProject` resolves it with (WP-34 review round 2).
   */
  readonly projectOfBatch: (batchId: string) => Promise<string | null>;
}

export interface ShadowRoutesOptions {
  readonly queries: ShadowQueries;
  /**
   * The batch command, or `null` on a process that composed no pipeline.
   *
   * `503` rather than `404`, the shape `routes/kb.ts` and `routes/onboarding.ts` both use: the path
   * exists and this process cannot serve it.
   */
  readonly shadow: ShadowCommands | null;
  /**
   * Whether this project may start a batch, and why not — asked for the **read** endpoint.
   *
   * Injected rather than imported so this module names no settings source, exactly as
   * `routes/commands.ts` takes its seven queries: the predicate is the application's
   * (`shadowBatchBlocker`) and the *settings* it is applied to are the composition root's.
   */
  readonly gate:
    | ((projectId: string) => Promise<{ canStart: boolean; blockedReason: string | null }>)
    | null;
}

/** The `human_actions.action` this command records, and the scope its `Idempotency-Key` lives in. */
export const SHADOW_START_ACTION = 'project.shadow.start';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });
const batchParamsSchema = z.strictObject({ batch_id: z.uuid() });

export const registerShadowRoutes = async (
  app: FastifyInstance,
  options: ShadowRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      (await options.queries.projectRole(projectId, userId)) as never,
  };
  // The guards run before validation, so this copes with a segment the schema has not checked yet
  // (`routes/onboarding.ts` carries the argument).
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  const scopeBatch = scopeToProject({
    param: 'batch_id',
    what: 'shadow batch',
    projectOf: async (batchId) => options.queries.projectOfBatch(batchId),
  });

  const commands = (): ShadowCommands => {
    if (options.shadow === null) {
      throw new HttpError(
        503,
        'shadow_unavailable',
        'this process composed no shadow commands: it serves the API without a pipeline, so it cannot start a shadow batch. Ask an instance that runs the workers',
      );
    }
    return options.shadow;
  };

  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  typed.post(
    '/api/projects/:project_id/shadow-batches',
    {
      preValidation: requirePermission(guard, 'shadow.run', { project: projectOf }),
      schema: {
        summary: 'Run the pipeline on closed tickets without touching anything external',
        description: `Creates one task per ticket key with \`mode = "shadow"\`, on this project's ordinary ticket templates — so every run goes through the same admission guard, cost ledger, transcript and budget cap, and every outbound write is refused and recorded as \`would_have\`. At most ${MAX_SHADOW_BATCH_TICKETS} keys per batch. A ticket may be **refused by name** rather than run: its human merge request publishes no merge base (a comparison against today's default branch would measure drift), the provider does not know the key, or this project already has a shadow task for it — the answer lists every key with its outcome. The batch may be refused as a whole when shadow mode is off for the project or its autonomy dial is past Observe; \`GET\` this path first to learn which.`,
        tags: ['projects'],
        params: projectParamsSchema,
        body: startShadowBatchRequestSchema,
        response: {
          202: startShadowBatchResponseSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      const projectId = request.params.project_id;
      const actor = actorOf(request);
      // The whole request, so a key reused for a different ticket list is the reuse this guard
      // exists to catch. The keys are **not** sorted: a caller that asked for a different order
      // asked a different question as far as this digest is concerned, and normalising here would
      // silently accept one request as another.
      const digest = configHashOf({
        project_id: projectId,
        ticket_keys: [...request.body.ticket_keys],
      });
      const previous = await options.queries.previousAttempt({
        userId: actor.userId,
        action: SHADOW_START_ACTION,
        key,
      });
      assertIdempotentRequest({
        action: SHADOW_START_ACTION,
        key,
        previousDigest: previous?.bodyDigest ?? null,
        digest,
      });
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }

      let result: Awaited<ReturnType<ShadowCommands['startBatch']>>;
      try {
        result = await commands().startBatch({
          projectId: projectId as Id,
          ticketKeys: request.body.ticket_keys,
          userId: actor.userId as Id,
        });
      } catch (error) {
        if (error instanceof OnboardingUnavailableError) {
          throw new HttpError(503, 'shadow_unavailable', error.message);
        }
        throw error;
      }
      if (result.status === 'blocked') {
        throw new HttpError(409, `shadow_${result.blocker}`, result.detail);
      }

      const started = result.tickets.filter((ticket) => ticket.taskId !== null).length;
      await options.queries.recordAction({
        userId: actor.userId,
        action: SHADOW_START_ACTION,
        params: {
          project_id: projectId,
          batch_id: result.batchId,
          tickets: result.tickets.length,
          started,
          idempotency_key: key,
          body_digest: digest,
        },
      });
      reply.code(202);
      return {
        batch_id: result.batchId,
        tickets: result.tickets.map((ticket) => ({
          ticket_key: ticket.ticketKey,
          task_id: ticket.taskId,
          refused_reason: ticket.refusedReason,
        })),
        started,
        refused: result.tickets.length - started,
      };
    },
  );

  typed.get(
    '/api/projects/:project_id/shadow-batches',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'Shadow batches for this project, newest first',
        description:
          "`can_start` and `blocked_reason` are the same answer the command refuses with, published so the screen states the reason instead of offering a button that fails. `spent_usd` is summed from the batch's tasks.",
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: shadowBatchesResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      /**
       * A process with no settings port cannot answer the gate, and says so rather than guessing.
       *
       * `can_start: false` with a named reason is the fail-closed direction: a screen that offered
       * the button would send the caller into a `503` from the command.
       */
      const gate =
        options.gate === null
          ? {
              canStart: false,
              blockedReason:
                'this process cannot read the project’s settings, so it cannot say whether a shadow batch may start',
            }
          : await options.gate(projectId);
      return options.queries.listBatches(projectId, {
        canStart: gate.canStart,
        blockedReason: gate.blockedReason,
      }) as never;
    },
  );

  typed.get(
    '/api/shadow-batches/:batch_id',
    {
      /**
       * Project-scoped, resolved from the row — the position `GET /api/runs/:id` is in, and now
       * the same mechanism.
       *
       * The batch's project is not in the path, so the project is read first by `scopeToProject`
       * and the guard scopes by what it left behind (`routes/scope.ts` owns the order: 401 before
       * the lookup, then 404, then the permission). Round 1 asked `project.read` at its
       * *organisation* minimum and cited runs as the same position, which was not true of them —
       * runs have used the resolver since WP-15h — so a maintainer of project A decided a read of
       * project B's batch on their organisation role alone. Membership promotes and never demotes
       * (`auth/rbac.ts`), so the effect of the change is that a project role can now raise the
       * answer for the project the batch is actually in.
       */
      preHandler: [
        scopeBatch,
        requirePermission(guard, 'project.read', { project: scopedProject }),
      ],
      schema: {
        summary: 'One shadow batch: its tickets, their comparisons and the aggregate',
        description:
          'The aggregate is computed from the batch’s `shadow_reports` rows on every read — product/19 §13’s cost-by-size, similarity distribution and launch candidates — and is not stored.',
        tags: ['projects'],
        params: batchParamsSchema,
        response: { 200: shadowBatchResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const read = await options.queries.findBatch(request.params.batch_id);
      if (!read.found) {
        throw new NotFoundError(`shadow batch ${request.params.batch_id}`);
      }
      return read.response;
    },
  );
};
