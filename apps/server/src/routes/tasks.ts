/**
 * `GET /api/tasks/:task_id` — technical/08's "the task, with stages, artifacts and checks" (WP-15h)
 * — and, since WP-52, `GET /api/artifacts/:artifact_id`, which serves one artifact's **body**.
 *
 * One read, and it is the one the task screen is built on: `taskDetailResponseSchema` is a
 * composite, so this route is where the projections of five tables meet the DTO the SPA parses. The
 * *commands* of technical/08 § "Tasks" (`pause`, `resume`, `retry-stage`, `answer`, …) are not
 * here — each of them writes, and a write needs the aggregate, the human-action audit row and an
 * idempotency key rather than a query. They are **served since WP-15i**, next door in
 * `routes/commands.ts`; this row was scoped to the reads (`13-implementation-plan.md`, WP-15h).
 *
 * `checks` is the other absence worth naming: `taskDetailResponseSchema` has no field for them, so
 * there is nothing here to omit — the Checks panel names the same gap in its own docblock.
 *
 * ## The artifact body, and why it could not be served until WP-52
 *
 * `GET /api/tasks/:task_id` published every artifact as `{id, artifact_type, version, url: null}`,
 * and the `null` was a literal in the projection — so every artifact on every task screen was a row
 * a reader could see and not open (PROGRESS backlog 85). The blocker was not the route: a run's
 * structured output was stored **unredacted** (backlog 35, measured with a planted model key), so a
 * read surface over `artifacts.data` was a way for a credential to leave the building. Both halves
 * land together, which is why this is one work package: the redaction happens at the write
 * (`packages/application/src/artifacts/redaction.ts`) and this route then has something safe to
 * serve.
 *
 * It is scoped and permissioned **like its task** — the project comes from the artifact's own row,
 * never from the request — and gated at `artifact.read`, which `PERMISSION_REQUIREMENTS` has
 * carried since WP-04 with no user. The task route's own comment says the artifacts' *content* is
 * "separately gated", and this is that gate.
 */
import type { TaskDetailResponse, UserRole } from '@platform/contracts';
import {
  apiErrorSchema,
  artifactBodyResponseSchema,
  taskDetailResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { ArtifactBody } from '../queries/pipeline-queries.js';
import { scopedProject, scopeToProject } from './scope.js';

/**
 * The four reads these two routes make, as **injected functions** — the shape `asks.ts`,
 * `breakdown.ts` and `commands.ts` already use.
 *
 * It exists for one reason, and the reason is worth stating because the seam was deliberately not
 * added when the artifact route landed: the route's **409 refusal** could then only be asserted in
 * the e2e tier, where it takes a database, a container and five minutes — and where it proved
 * flaky. A refusal that is the only thing standing between an unredacted body and `artifact.read`
 * has to be assertable in a tier that can run it often and deterministically. With this,
 * `tasks.test.ts` drives the real router, the real guards, the real schemas and the real error
 * handler against plain functions, and the e2e keeps the half only it can state: a body the
 * pipeline really produced.
 */
export interface TaskQueries {
  readonly taskDetail: (taskId: string) => Promise<TaskDetailResponse | null>;
  readonly taskProjectId: (taskId: string) => Promise<string | null>;
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly artifactBody: (artifactId: string) => Promise<ArtifactBody>;
  readonly artifactProjectId: (artifactId: string) => Promise<string | null>;
}

export interface TaskRoutesOptions {
  readonly queries: TaskQueries;
}

const taskParamsSchema = z.strictObject({ task_id: z.uuid() });
const artifactParamsSchema = z.strictObject({ artifact_id: z.uuid() });

export const registerTaskRoutes = async (
  app: FastifyInstance,
  options: TaskRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  const scope = scopeToProject({
    param: 'task_id',
    what: 'task',
    projectOf: options.queries.taskProjectId,
  });

  typed.get(
    '/api/tasks/:task_id',
    {
      // `task.read` is `viewer` (technical/08's capability map). The task record carries no model
      // output: the ticket reference, the state machine's position, cost totals and the ids of the
      // artifacts. The artifacts' *content* and the transcript are separately gated.
      preHandler: [scope, requirePermission(guard, 'task.read', { project: scopedProject })],
      schema: {
        summary: 'One task, with its stages, artifacts, questions, approvals and runs',
        description:
          'Ticket text, question text and stage outcomes are untrusted content (BD-022): render them, never execute them.',
        tags: ['tasks'],
        params: taskParamsSchema,
        response: { 200: taskDetailResponseSchema },
      },
    },
    async (request) => {
      const detail = await options.queries.taskDetail(request.params.task_id);
      if (detail === null) {
        // Unreachable through the preHandler, which 404s on the same question; kept because the
        // two reads are separate statements and a task deleted between them is a 404, not a 500.
        throw new NotFoundError(`task ${request.params.task_id}`);
      }
      return detail;
    },
  );

  const scopeArtifact = scopeToProject({
    param: 'artifact_id',
    what: 'artifact',
    projectOf: options.queries.artifactProjectId,
  });

  typed.get(
    '/api/artifacts/:artifact_id',
    {
      preHandler: [
        scopeArtifact,
        requirePermission(guard, 'artifact.read', { project: scopedProject }),
      ],
      schema: {
        summary: 'One artifact’s body',
        description:
          'The stored `data` of one artifact, scoped to the project that owns its task. It is model output and therefore untrusted content (BD-022): render it as text, never as markup and never as a link. Every body served has passed TD-012’s redaction at the write, with one exception: a `ShadowReport` is assembled by the platform rather than produced by a run, so it is written through an empty redactor and neither TD-012 step is applied to it (PROGRESS backlog 131) — its exposure is unchanged, because the same document is already served at `project.read` by `GET /api/shadow-batches/:id`. An artifact stored before migration 0038 — when nothing redacted one — is refused with 409 `artifact_not_redacted` rather than published.',
        tags: ['tasks'],
        params: artifactParamsSchema,
        // The 409 is declared rather than only thrown, exactly as `/prompt` declares its own: an
        // OpenAPI document describing only the 200 would omit the answer an upgraded instance gives
        // for every artifact it produced before this work package.
        response: { 200: artifactBodyResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const artifact = await options.queries.artifactBody(request.params.artifact_id);
      if (!artifact.found) {
        // Same shape as the task read above: the preHandler already 404s on this question, and the
        // two reads are separate statements.
        throw new NotFoundError(`artifact ${request.params.artifact_id}`);
      }
      if (!artifact.redacted) {
        /**
         * **The refusal, and it is the whole reason this route could not exist before.**
         *
         * `artifacts.redaction_count is null` means the row was written before migration 0038, when
         * a run's structured output was stored verbatim — PROGRESS backlog 35, measured with a
         * planted model key. Serving it would publish that credential to `artifact.read`, which is
         * `viewer`: the widest role on the instance. `artifacts` is append-only, so the row cannot
         * be repaired, and a redaction applied *here* would give the row and the response two
         * different texts (the rule `listInbox` states for `questions.text`).
         */
        throw new HttpError(
          409,
          'artifact_not_redacted',
          `artifact ${request.params.artifact_id} was stored on ${artifact.createdAt}, before migration 0038 gave artifacts.redaction_count a writer — so nothing redacted it and this instance cannot vouch for what is in it. Artifacts are append-only and are never rewritten; an artifact produced after the upgrade is served normally`,
        );
      }
      return artifact.body;
    },
  );
};
