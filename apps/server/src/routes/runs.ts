/**
 * The four run reads of technical/08 § "Runs" (WP-15h).
 *
 * `GET /api/runs/:id`, `/messages`, `/prompt` and `/context-pack` — the endpoints
 * `apps/web/src/api/endpoints.ts` has called since WP-20 and the server has answered 404 to ever
 * since. They go first because they are the only part of the read surface with a producer already
 * writing rows: WP-15g's `createPostgresTranscriptSink` writes `run_messages`, and until this file
 * existed nothing could read one back.
 *
 * ## Project scoping needs a query, so it is a preHandler of its own
 *
 * `requirePermission`'s `project` hook is synchronous — every route that had it until now takes the
 * project id out of the URL. A run's project is a column, so {@link scopeToRunProject} resolves it
 * first and the permission guard reads what it left behind. The order matters and is asserted:
 * **an unauthenticated request is 401 before the lookup runs**, so an unknown id and a wrong id are
 * indistinguishable to a caller with no session (they are both 401, never 404).
 *
 * ## Which permission, and why they are not all the same one
 *
 * `run.read` is `viewer` and `transcript.read` is `member` (technical/08 fixes the second one by
 * name). The split is what the run's *content* is: the record is metadata — status, model, cost,
 * token counts — while the transcript and the prompt are the model's own text and the ticket's own
 * words, which is what technical/08 gates at `member`. The context pack is a list of document paths
 * and scores, so it goes with the record.
 */
import {
  apiErrorSchema,
  contextPackRecordSchema,
  runMessagesQuerySchema,
  runMessagesResponseSchema,
  runPromptResponseSchema,
  runRecordSchema,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectRole, findRunProjectId } from '../queries/identity-queries.js';
import {
  findRun,
  findRunContextPack,
  findRunPrompt,
  listRunMessages,
} from '../queries/pipeline-queries.js';
import { scopedProject, scopeToProject } from './scope.js';

export interface RunRoutesOptions {
  readonly database: Database;
}

const runParamsSchema = z.strictObject({ run_id: z.uuid() });

/** Default page size for the transcript. The client asks for 1 000, which is also the cap. */
const DEFAULT_MESSAGE_LIMIT = 200;

export const registerRunRoutes = async (
  app: FastifyInstance,
  options: RunRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    // The run's project has already been read by the preHandler; this is the caller's membership
    // in it, which is the question `effectiveRole` asks.
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };
  const scope = scopeToProject({
    database: options.database,
    param: 'run_id',
    what: 'run',
    projectOf: findRunProjectId,
  });

  typed.get(
    '/api/runs/:run_id',
    {
      preHandler: [scope, requirePermission(guard, 'run.read', { project: scopedProject })],
      schema: {
        summary: 'One run',
        tags: ['runs'],
        params: runParamsSchema,
        response: { 200: runRecordSchema },
      },
    },
    async (request) => {
      const run = await findRun(options.database, request.params.run_id);
      if (run === null) {
        // Unreachable through the preHandler, which 404s first; kept because the two reads are
        // separate statements and a run deleted between them must not become a 500.
        throw new NotFoundError(`run ${request.params.run_id}`);
      }
      return run;
    },
  );

  typed.get(
    '/api/runs/:run_id/messages',
    {
      preHandler: [scope, requirePermission(guard, 'transcript.read', { project: scopedProject })],
      schema: {
        summary: 'A page of the run’s transcript',
        description:
          'Cursor-paginated over `run_messages.seq`, which is zero-based (migration 0016): `after` is exclusive, so the first page carries `seq: 0`. `next_seq` is the `after` value for the next page, or null on the last one. Every entry has already passed the redaction path (TD-012) and is untrusted content (BD-022): render it, never execute it.',
        tags: ['runs'],
        params: runParamsSchema,
        querystring: runMessagesQuerySchema,
        response: { 200: runMessagesResponseSchema },
      },
    },
    async (request) => {
      const page = await listRunMessages(options.database, request.params.run_id, {
        limit: request.query.limit ?? DEFAULT_MESSAGE_LIMIT,
        ...(request.query.after === undefined ? {} : { after: request.query.after }),
        partials: request.query.partials !== '0',
      });
      return { items: [...page.items], next_seq: page.nextSeq };
    },
  );

  typed.get(
    '/api/runs/:run_id/prompt',
    {
      preHandler: [scope, requirePermission(guard, 'transcript.read', { project: scopedProject })],
      schema: {
        summary: 'The prompt a run was given',
        description:
          'Refuses with 409 `prompt_not_recorded` while nothing writes `runs.system_prompt` / `runs.user_prompt`.',
        tags: ['runs'],
        params: runParamsSchema,
        // The 409 is declared, not just thrown: an OpenAPI document that described only the 200
        // would describe the answer this endpoint never gives (see the refusal below).
        response: { 200: runPromptResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const prompt = await findRunPrompt(options.database, request.params.run_id);
      if (!prompt.found) {
        throw new NotFoundError(`run ${request.params.run_id}`);
      }
      if (!prompt.recorded) {
        /**
         * **The refusal is the honest answer, and it is 409 rather than an empty document.**
         *
         * `createStageRunPlanner` assembles a real prompt for every run (WP-17) and hands it to the
         * runner in the `RunSpec`; **no writer stores it**. `RunRepository.insert` carries eleven
         * columns and neither prompt is among them, and `StoredRun` has no field for them at all,
         * so `runs.system_prompt` and `runs.user_prompt` have been null for every run this
         * repository has ever executed. Returning `{system_prompt: "", user_prompt: ""}` would
         * render as "this run had no prompt", which is a claim about the agent rather than about
         * the schema.
         */
        throw new HttpError(
          409,
          'prompt_not_recorded',
          `run ${request.params.run_id} has no stored prompt: the planner assembles one per run and hands it to the runner in the RunSpec, but nothing writes runs.system_prompt / runs.user_prompt. Storing them is the work package that adds a writer; until then the assembled prompt exists only in the run's own process`,
        );
      }
      return {
        prompt_version: prompt.promptVersion,
        system_prompt: prompt.systemPrompt,
        user_prompt: prompt.userPrompt,
      };
    },
  );

  typed.get(
    '/api/runs/:run_id/context-pack',
    {
      preHandler: [scope, requirePermission(guard, 'run.read', { project: scopedProject })],
      schema: {
        summary: 'The context pack a run was assembled with',
        description:
          'Refuses with 409 `context_pack_not_recorded` while nothing writes `run_context_pack`.',
        tags: ['runs'],
        params: runParamsSchema,
        // `200` is the shape this endpoint will answer with once the schema can hold a pack; today
        // it answers `409` and nothing else, so both are published.
        response: { 200: contextPackRecordSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const pack = await findRunContextPack(options.database, request.params.run_id);
      if (!pack.found) {
        throw new NotFoundError(`run ${request.params.run_id}`);
      }
      /**
       * **This endpoint always refuses, and the refusal is a statement about the schema.**
       *
       * `run_context_pack` has no column for `budget_tokens` and stores `reason`/`score` as
       * nullable where the published tier-1 entry requires them, so the record cannot be filled
       * from the table *however many rows exist* — summing the rows into `budget_tokens` would
       * publish "budget equals total" as a fact, and `apps/web/src/features/run-detail.tsx` renders
       * it as one. The row count is in the message so the reason is diagnosable: `0` is "no
       * producer yet", anything else is "a producer exists and the schema gap is still open".
       */
      throw new HttpError(
        409,
        'context_pack_not_recorded',
        `run ${request.params.run_id} has no readable context pack (${pack.rows} run_context_pack rows): the table has no column for the pack's budget_tokens and stores reason/score as nullable where the published record requires them, so it cannot be projected from rows alone, and nothing in this repository inserts into it yet. Giving this endpoint an answer is a schema change plus a writer, not a reader. The pack is built per run (WP-17) and currently lives only in the prompt it produced`,
      );
    },
  );
};
