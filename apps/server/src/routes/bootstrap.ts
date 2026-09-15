/**
 * The history bootstrap's two endpoints — product/06 step 3b, product/18:27 (WP-35).
 *
 *   POST /api/projects/:project_id/history-bootstraps    start one, at a chosen N
 *   GET  /api/projects/:project_id/history-bootstraps    the batches, the gate and the estimate
 *
 * The **write** is WP-15i's command shape, and every clause of it is here rather than described: a
 * strict snake_case body, a maintainer capability on the project, an `Idempotency-Key` that is
 * **required** because a repeat would start a second mining of the same history, a digest of the
 * canonical request stored beside the key so a *different* body under a used key is refused, one
 * `human_actions` row per accepted command and none for a refused one, and the guards at
 * `preValidation` so an anonymous caller is refused before being told the body's shape.
 *
 * ## What a replay does, and what actually makes it safe
 *
 * There is **no stored response** (`routes/shadow.ts` and `routes/onboarding.ts` made the same
 * call). What there is is the recorded **attempt**: a replay of the same key with the same body is
 * answered from the `human_actions` row the first one wrote — {@link idempotentReplay}, WP-15i's
 * half of the header — so the command is not reached and the answer carries the batch the caller
 * already has.
 *
 * The first version let the replay reach the command and relied on `already_running`, which held
 * only while the batch was **live**: once it completed, the same key with the same body started a
 * second $20 mining of the same six months and wrote a second `human_actions` row. "A replay
 * performs nothing twice" is a claim about the key, not about the resource's current state
 * (WP-35 review round 2). A *different* body under a used key is still the `409
 * idempotency_key_reused` the digest decides, and `already_running` remains the answer for a
 * second bootstrap under a **new** key.
 *
 * A replayed answer is read back rather than recomputed, which is why the audit row carries the
 * whole estimate: what the caller is told the second time is what they were told the first time,
 * and a row written before those fields existed is **refused by name** rather than answered with a
 * placeholder (`routes/commands.ts`' `recordedBranch` and `routes/asks.ts`' ask id make the same
 * call).
 *
 * ## The gate is published on the read, not discovered on the write
 *
 * `GET …/history-bootstraps` answers `can_start`, `blocked_reason` **and the estimate for a given
 * N** from the same functions the command uses (`historyBootstrapBlocker`, `estimateFor`), so the
 * wizard states *"the history bootstrap is off for this project"* rather than offering a button that
 * answers 409 — and shows product/06's *"estimated cost before running"* without doing the
 * arithmetic itself. Two spellings of one rule would be two answers (standing rule 9).
 */
import {
  apiErrorSchema,
  historyBootstrapsResponseSchema,
  type Id,
  type JsonObject,
  MAX_BOOTSTRAP_MERGE_REQUESTS,
  type StartHistoryBootstrapResponse,
  startHistoryBootstrapRequestSchema,
  startHistoryBootstrapResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import type { HistoryBootstrapCommands } from '../bootstrap.js';
import { HttpError, NotFoundError } from '../errors.js';
import { OnboardingUnavailableError } from '../onboarding.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import { idempotentReplay, requireIdempotencyKey } from './idempotency.js';

export interface BootstrapQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<string | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  /**
   * The attempt this caller already made under this key, with the `params` it recorded.
   *
   * The `params` are what a replay is answered from — there is no stored response, so the audit
   * row is the record of what the first attempt produced (`routes/idempotency.ts`).
   */
  readonly previousAttempt: (query: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
  }) => Promise<{ readonly bodyDigest: string | null; readonly params: JsonObject } | null>;
  readonly recordAction: (input: HumanActionInput) => Promise<void>;
  /** The batches, with the gate and the estimate the caller's `merge_requests` asks for. */
  readonly listBootstraps: (projectId: string, mergeRequests: number | null) => Promise<unknown>;
}

export interface BootstrapRoutesOptions {
  readonly queries: BootstrapQueries;
  /**
   * The start command, or `null` on a process that composed no pipeline.
   *
   * `503` rather than `404`, the shape `routes/shadow.ts` and `routes/kb.ts` both use: the path
   * exists and this process cannot serve it.
   */
  readonly bootstrap: HistoryBootstrapCommands | null;
}

/** The `human_actions.action` this command records, and the scope its `Idempotency-Key` lives in. */
export const BOOTSTRAP_START_ACTION = 'project.history_bootstrap.start';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The answer a replay gets: the batch the first attempt started, and the estimate it was shown.
 *
 * It is validated by the **published** schema rather than by a second description of the same
 * fields (standing rule 9), and a row that does not satisfy it — one written before the estimate
 * was recorded in full — is a `409` naming why, never a placeholder: this endpoint's whole product
 * is a batch id and a figure somebody is about to spend money against.
 */
const replayedStart = (previous: JsonObject | null): StartHistoryBootstrapResponse => {
  // An attempt with no `params` at all is the same case as one missing a field: absent, and
  // refused below rather than filled in.
  const recorded = previous ?? {};
  const parsed = startHistoryBootstrapResponseSchema.safeParse({
    batch_id: recorded.batch_id,
    estimate: {
      merge_requests: recorded.merge_requests,
      batch_size: recorded.batch_size,
      batches: recorded.batches,
      estimated_usd: recorded.estimated_usd,
      cap_usd: recorded.cap_usd,
      stops_at_cap: recorded.stops_at_cap,
      days: recorded.days,
    },
  });
  if (!parsed.success) {
    throw new HttpError(
      409,
      'idempotency_key_reused',
      'this Idempotency-Key has already started a history bootstrap, and the attempt that did predates the batch being audited in full; use a new key',
    );
  }
  return parsed.data;
};

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });
const listQuerySchema = z.strictObject({
  /**
   * The N the estimate is for. A **query** parameter rather than a body, because this is a read:
   * the screen re-asks as the operator moves the number and the server does the arithmetic.
   */
  merge_requests: z.coerce.number().int().min(1).max(MAX_BOOTSTRAP_MERGE_REQUESTS).optional(),
});

export const registerBootstrapRoutes = async (
  app: FastifyInstance,
  options: BootstrapRoutesOptions,
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

  const commands = (): HistoryBootstrapCommands => {
    if (options.bootstrap === null) {
      throw new HttpError(
        503,
        'bootstrap_unavailable',
        'this process composed no history-bootstrap commands: it serves the API without a pipeline, so it cannot start one. Ask an instance that runs the workers',
      );
    }
    return options.bootstrap;
  };

  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  typed.post(
    '/api/projects/:project_id/history-bootstraps',
    {
      /**
       * `kb.bootstrap` — a maintainer capability that has existed since WP-02 and had **no caller**
       * until this row, which is the same shape `listMergedMergeRequests` was in. It is the right
       * one rather than `project.write`: what this command spends money to produce is knowledge
       * proposals, and the capability that decides them is `kb.proposal.decide` beside it.
       */
      preValidation: requirePermission(guard, 'kb.bootstrap', { project: projectOf }),
      schema: {
        summary: 'Mine this project’s merged history into knowledge proposals',
        description: `Reads the last N merged merge requests with their review comments, the closed tickets of the configured window and the commit messages, and runs a Sonnet mining agent over batches of about twenty. Every proposal cites the merge requests or tickets it was observed in and lands in the **proposal queue** — nothing is ever applied silently, whatever the project's auto-apply policy says. N defaults to the project's configured value (200) and is refused above ${MAX_BOOTSTRAP_MERGE_REQUESTS}. The batch stops when its budget cap is spent; \`GET\` this path first to see the estimate and the cap.`,
        tags: ['projects'],
        params: projectParamsSchema,
        body: startHistoryBootstrapRequestSchema,
        response: {
          202: startHistoryBootstrapResponseSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      const projectId = request.params.project_id;
      const actor = actorOf(request);
      // Reads the attempt, refuses a different body under the same key, and reports whether this
      // key has already started one. The digest is over the same canonical request the first
      // version hashed, so a row written by that build still matches its own retry.
      const replay = await idempotentReplay(options.queries.previousAttempt, {
        userId: actor.userId,
        action: BOOTSTRAP_START_ACTION,
        key,
        request: {
          project_id: projectId,
          merge_requests: request.body.merge_requests ?? null,
        },
      });
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (replay.replayed) {
        reply.code(202);
        return replayedStart(replay.previous);
      }

      let result: Awaited<ReturnType<HistoryBootstrapCommands['start']>>;
      try {
        result = await commands().start({
          projectId: projectId as Id,
          mergeRequests: request.body.merge_requests ?? null,
          userId: actor.userId as Id,
        });
      } catch (error) {
        if (error instanceof OnboardingUnavailableError) {
          throw new HttpError(503, 'bootstrap_unavailable', error.message);
        }
        throw error;
      }
      if (result.status === 'blocked') {
        throw new HttpError(409, `bootstrap_${result.blocker}`, result.detail);
      }

      // The **whole** estimate, not only the two money figures: it is what an operator was told
      // this batch would cost — the reason the row exists — and it is what a replay of this key is
      // answered with, so a field missing here would be a field this endpoint could not answer
      // twice.
      await options.queries.recordAction({
        userId: actor.userId,
        action: BOOTSTRAP_START_ACTION,
        params: {
          project_id: projectId,
          batch_id: result.batchId,
          merge_requests: result.estimate.mergeRequests,
          batch_size: result.estimate.batchSize,
          batches: result.estimate.batches,
          estimated_usd: result.estimate.estimatedUsd,
          cap_usd: result.estimate.capUsd,
          stops_at_cap: result.estimate.stopsAtCap,
          days: result.estimate.days,
          idempotency_key: key,
          ...(replay.digest === null ? {} : { body_digest: replay.digest }),
        },
      });
      reply.code(202);
      return {
        batch_id: result.batchId,
        estimate: {
          merge_requests: result.estimate.mergeRequests,
          batch_size: result.estimate.batchSize,
          batches: result.estimate.batches,
          estimated_usd: result.estimate.estimatedUsd,
          cap_usd: result.estimate.capUsd,
          stops_at_cap: result.estimate.stopsAtCap,
          days: result.estimate.days,
        },
      };
    },
  );

  typed.get(
    '/api/projects/:project_id/history-bootstraps',
    {
      preValidation: requirePermission(guard, 'project.read', { project: projectOf }),
      schema: {
        summary: 'History bootstraps for this project, newest first',
        description:
          '`can_start` and `blocked_reason` are the same answer the command refuses with, published so the screen states the reason instead of offering a button that fails. `estimate` is product/06 step 3b’s *"estimated cost before running"* for the `merge_requests` in the query (or the project’s configured N), computed by the server so the screen never multiplies two published numbers itself. `spent_usd` is summed from `cost_entries`, which is the same source the batch cap is enforced against.',
        tags: ['projects'],
        params: projectParamsSchema,
        querystring: listQuerySchema,
        response: { 200: historyBootstrapsResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if (!(await options.queries.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return (await options.queries.listBootstraps(
        projectId,
        request.query.merge_requests ?? null,
      )) as never;
    },
  );
};
