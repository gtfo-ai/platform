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
    param: 'run_id',
    what: 'run',
    projectOf: async (runId) => findRunProjectId(options.database, runId),
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
          'The assembled prompt the run was started with, redacted at the write (TD-012). It is untrusted content (BD-022) — it contains the ticket’s own words and the context pack — so render it, never execute it. A run created before migration 0038 has no stored prompt and is refused with 409 `prompt_not_recorded`; the prompt is never re-derived, because the nonce is drawn per prompt and the pack is a point-in-time read.',
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
         * What it says narrowed at WP-52 from a statement about the *build* to one about the
         * *row*. Until then `RunRepository.insert` named twelve columns, neither prompt was among
         * them, and `runs.system_prompt`/`user_prompt` had been null for every run this repository
         * had ever executed (Q64). Both `runs.insert` call sites now store the assembled prompt at
         * run creation, redacted (migration 0038) — so a null here means the run predates that
         * writer, and it will never have one: the nonce `assemblePrompt` draws is per prompt and
         * the context pack is a point-in-time read, so re-deriving the prompt later would answer
         * with a different document. Returning `{system_prompt: "", user_prompt: ""}` would render
         * as "this run had no prompt", which is a claim about the agent rather than about the row.
         */
        throw new HttpError(
          409,
          'prompt_not_recorded',
          `run ${request.params.run_id} has no stored prompt: it was created before migration 0038 gave runs.system_prompt / runs.user_prompt a writer. The prompt is not re-derivable — the delimiter nonce is drawn per prompt and the context pack is a point-in-time read — so this run's assembled prompt is gone rather than merely unfetched`,
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
          'The record the run’s planner built — the same one `run.started` carries — stored when the run was created (migration 0041). An empty pack answers 200 with empty tiers. Refuses with 409 `context_pack_not_recorded`, carrying the row count, for a run created before that migration, whose pack was never recorded. Every `path` is a vault path somebody committed (BD-022).',
        tags: ['runs'],
        params: runParamsSchema,
        response: { 200: contextPackRecordSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const pack = await findRunContextPack(options.database, request.params.run_id);
      if (!pack.found) {
        throw new NotFoundError(`run ${request.params.run_id}`);
      }
      if (pack.recorded) {
        return pack.pack;
      }
      /**
       * **The refusal is now a statement about the row, not about the build** (WP-57).
       *
       * Until migration 0041 this endpoint always refused, because `run_context_pack` could not
       * hold the record and nothing wrote it. Both are fixed; what is left is a run whose header
       * (`runs.context_budget_tokens`) is null — created before the writer existed — and answering
       * it would mean inventing the budget and the total. The row count is in the message so `0`
       * ("never recorded") and a non-zero count ("rows written outside `RunRepository.insert`")
       * stay distinguishable (standing rule 18).
       */
      throw new HttpError(
        409,
        'context_pack_not_recorded',
        `run ${request.params.run_id} has no recorded context pack (${pack.rows} run_context_pack rows and no budget_tokens on the run): it was created before migration 0041 gave the pack a writer, and the budget and total it was assembled against cannot be recovered from rows alone`,
      );
    },
  );
};
