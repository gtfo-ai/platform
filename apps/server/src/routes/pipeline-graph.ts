/**
 * The compiled stage graph (S-23.15, TD-033 decision 8 (a)):
 *
 *   GET /api/tasks/:task_id/pipeline                     the task's frozen pipeline
 *   GET /api/projects/:project_id/pipeline[?template=]   one template's, or every enabled one's
 *
 * Reads, gated like their neighbours: the task's at `task.read` scoped to the task's project
 * (`GET /api/tasks/:task_id`'s guard), the project's at `project.read` (`…/readiness`'s). Every
 * read is injected, so `pipeline-graph.test.ts` drives the real router, guards and schemas
 * against plain functions; `queries/pipeline-graph-queries.ts` is the database half and says what
 * each graph is compiled from.
 *
 * Refusals are typed: `404 task`/`project` not found, `404 template_not_found` for a template the
 * task or the project does not have, `409 pipeline_not_compilable` for a template (or a frozen
 * column) this release cannot compile, and `409 project_config_refused` for a project whose stored
 * settings do not parse — the graph would otherwise be drawn from the defaults standing in for them.
 */
import {
  apiErrorSchema,
  pipelineGraphSchema,
  projectPipelineQuerySchema,
  projectPipelinesResponseSchema,
  type UserRole,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { GraphRefusal } from '../queries/pipeline-graph.js';
import type { PipelineGraphReaders } from '../queries/pipeline-graph-queries.js';
import { scopedProject, scopeToProject } from './scope.js';

export interface PipelineGraphQueries extends PipelineGraphReaders {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly taskProjectId: (taskId: string) => Promise<string | null>;
}

const taskParamsSchema = z.strictObject({ task_id: z.uuid() });
const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

const refusal = (what: string, result: GraphRefusal): HttpError =>
  result.kind === 'unknown_template'
    ? new HttpError(
        404,
        'template_not_found',
        `${what} has no pipeline template "${result.template}"`,
      )
    : new HttpError(
        409,
        'pipeline_not_compilable',
        `${what}'s pipeline template "${result.template}" cannot be compiled by this release: ${result.why}`,
      );

export const registerPipelineGraphRoutes = async (
  app: FastifyInstance,
  options: { readonly queries: PipelineGraphQueries },
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  const scope = scopeToProject({
    param: 'task_id',
    what: 'task',
    projectOf: options.queries.taskProjectId,
  });

  typed.get(
    '/api/tasks/:task_id/pipeline',
    {
      preHandler: [scope, requirePermission(guard, 'task.read', { project: scopedProject })],
      schema: {
        summary: 'The task’s compiled stage graph',
        description:
          'The pipeline this task runs on: its frozen template snapshot, dial, `qa_stage` and iteration limits (S-23.15). Every stage is a node (`enabled` says which run); the edges are the transitions the interpreter would take from each enabled stage — `next`, `approve`, `return`, `pass`, `fail`, `on` (with `on_event`) — and `loop` is set on an edge that goes backwards, with `loop_limit` on its node. `model`/`effort` are the latest run’s for a stage the task has run, else the project’s configured value. 404 `template_not_found`, 409 `pipeline_not_compilable` when the frozen pipeline cannot be compiled.',
        tags: ['tasks'],
        params: taskParamsSchema,
        response: { 200: pipelineGraphSchema, 404: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const taskId = request.params.task_id;
      const result = await options.queries.taskGraph(taskId);
      switch (result.kind) {
        case 'graph':
          return result.graph;
        case 'not_found':
          // The preHandler already 404s on the same question; a task deleted between the two reads.
          throw new NotFoundError(`task ${taskId}`);
        default:
          throw refusal(`task ${taskId}`, result);
      }
    },
  );

  typed.get(
    '/api/projects/:project_id/pipeline',
    {
      preHandler: requirePermission(guard, 'project.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'The project’s compiled pipeline templates',
        description:
          'Each template as a task started now would run it — the project’s templates with its dial, `qa_stage`, iteration limits and per-stage model and effort applied (S-23.15). Without `template`, every enabled template: the ticket templates and discovery always, an opt-in template (spike, epic split, review-only, ticket linter, history bootstrap) only while its feature is on. With `template`, that one whatever its switch. 404 `template_not_found`, 409 `pipeline_not_compilable`, 409 `project_config_refused` when the project’s stored settings do not parse.',
        tags: ['projects'],
        params: projectParamsSchema,
        querystring: projectPipelineQuerySchema,
        response: { 200: projectPipelinesResponseSchema, 404: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const result = await options.queries.projectGraphs(projectId, request.query.template ?? null);
      switch (result.kind) {
        case 'graphs':
          return { items: [...result.items] };
        case 'not_found':
          throw new NotFoundError(`project ${projectId}`);
        case 'config_refused':
          throw new HttpError(
            409,
            'project_config_refused',
            `project ${projectId}'s stored settings do not parse, so no run would start on the pipeline they configure; GET /api/projects/${projectId}/config says why`,
          );
        default:
          throw refusal(`project ${projectId}`, result);
      }
    },
  );
};
