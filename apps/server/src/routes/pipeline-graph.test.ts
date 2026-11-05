/**
 * `GET /api/tasks/:task_id/pipeline` and `GET /api/projects/:project_id/pipeline` (S-23.15)
 * through the real router, guards, schemas and error handler, over plain functions.
 *
 * **A 403 is unreachable on both, and that is asserted as what it is** — the reasoning
 * `tasks.test.ts` gives for `artifact.read`: `task.read` and `project.read` are `viewer`, the floor
 * every signed-in caller has, and a project membership only ever promotes. What is real is 401 for
 * an anonymous caller *before* anything is read, and *which project* the guard is asked about:
 * the task's own, from its row, never one the request names.
 */
import type { PipelineGraph, UserRole } from '@platform/contracts';
import { pipelineGraphSchema, projectPipelinesResponseSchema } from '@platform/contracts';
import { can } from '@platform/domain';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { ProjectGraphsResult, TaskGraphResult } from '../queries/pipeline-graph-queries.js';
import { registerPipelineGraphRoutes } from './pipeline-graph.js';

const TASK = '00000000-0000-4000-8000-0000002315d1';
const PROJECT = '00000000-0000-4000-8000-0000002315e1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000002315e2';
const USER = '00000000-0000-4000-8000-0000002315a9';

const GRAPH: PipelineGraph = {
  template: 'review_only',
  nodes: [
    {
      id: 'intake',
      kind: 'system',
      role: null,
      enabled: true,
      advisory: false,
      model: null,
      effort: null,
      loop: null,
      loop_limit: null,
    },
    {
      id: 'done',
      kind: 'system',
      role: null,
      enabled: true,
      advisory: false,
      model: null,
      effort: null,
      loop: null,
      loop_limit: null,
    },
  ],
  edges: [{ from: 'intake', to: 'done', kind: 'next', on_event: null, loop: null }],
};

interface World {
  signedIn: boolean;
  orgRole: UserRole;
  task: TaskGraphResult;
  project: ProjectGraphsResult;
  taskProject: string | null;
  readonly reads: string[];
  readonly guardedFor: string[];
}

let app: FastifyInstance;
let world: World;

beforeEach(async () => {
  world = {
    signedIn: true,
    orgRole: 'viewer',
    task: { kind: 'graph', graph: GRAPH },
    project: { kind: 'graphs', items: [GRAPH] },
    taskProject: PROJECT,
    reads: [],
    guardedFor: [],
  };
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.signedIn) {
      request.actor = {
        userId: USER,
        email: 'viewer@example.test',
        name: 'Viewer',
        role: world.orgRole,
        sessionId: 'session-1',
      };
    }
  });
  await registerPipelineGraphRoutes(app, {
    queries: {
      projectRole: async (projectId) => {
        world.guardedFor.push(projectId);
        return null;
      },
      taskProjectId: async (taskId) => {
        world.reads.push(`project-of:${taskId}`);
        return world.taskProject;
      },
      taskGraph: async (taskId) => {
        world.reads.push(`task:${taskId}`);
        return world.task;
      },
      projectGraphs: async (projectId, template) => {
        world.reads.push(`project:${projectId}:${template ?? '*'}`);
        return world.project;
      },
    },
  });
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('GET /api/tasks/:task_id/pipeline', () => {
  it('answers the graph to a viewer, guarded against the task’s own project', async () => {
    const reply = await get(`/api/tasks/${TASK}/pipeline`);
    expect(reply.statusCode, reply.body).toBe(200);
    expect(pipelineGraphSchema.parse(reply.json())).toEqual(GRAPH);
    expect(world.guardedFor).toEqual([PROJECT]);
    // The floor: the role every signed-in caller has may read it, so a 403 cannot be reached.
    expect(can('viewer', 'task.read')).toBe(true);
  });

  it('refuses an anonymous caller with 401 before it reads anything', async () => {
    world.signedIn = false;
    const reply = await get(`/api/tasks/${TASK}/pipeline`);
    expect(reply.statusCode).toBe(401);
    expect(world.reads).toEqual([]);
  });

  it('answers 404 for a task that does not exist, without reading a graph', async () => {
    world.taskProject = null;
    const reply = await get(`/api/tasks/${TASK}/pipeline`);
    expect(reply.statusCode).toBe(404);
    expect(world.reads).toEqual([`project-of:${TASK}`]);
  });

  it('refuses rather than invents: an unknown template is 404, an uncompilable one 409', async () => {
    world.task = { kind: 'unknown_template', template: 'nightly' };
    const unknown = await get(`/api/tasks/${TASK}/pipeline`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('template_not_found');

    world.task = { kind: 'not_compilable', template: 'feature', why: 'its frozen dial is unread' };
    const broken = await get(`/api/tasks/${TASK}/pipeline`);
    expect(broken.statusCode).toBe(409);
    expect(broken.json().error).toMatchObject({ code: 'pipeline_not_compilable' });
    expect(broken.json().error.message).toContain('its frozen dial is unread');
  });

  it('rejects an id that is not a uuid without reading anything', async () => {
    const reply = await get('/api/tasks/not-a-uuid/pipeline');
    expect(reply.statusCode).toBe(400);
    expect(world.reads).toEqual([]);
  });
});

describe('GET /api/projects/:project_id/pipeline', () => {
  it('lists the enabled templates’ graphs to a viewer, or the one named', async () => {
    const all = await get(`/api/projects/${PROJECT}/pipeline`);
    expect(all.statusCode, all.body).toBe(200);
    expect(projectPipelinesResponseSchema.parse(all.json())).toEqual({ items: [GRAPH] });
    const one = await get(`/api/projects/${PROJECT}/pipeline?template=review_only`);
    expect(one.statusCode).toBe(200);
    expect(world.reads).toEqual([`project:${PROJECT}:*`, `project:${PROJECT}:review_only`]);
    expect(world.guardedFor).toEqual([PROJECT, PROJECT]);
    expect(can('viewer', 'project.read')).toBe(true);
  });

  it('refuses an anonymous caller with 401 before it reads anything', async () => {
    world.signedIn = false;
    const reply = await get(`/api/projects/${OTHER_PROJECT}/pipeline`);
    expect(reply.statusCode).toBe(401);
    expect(world.reads).toEqual([]);
    expect(world.guardedFor).toEqual([]);
  });

  it('refuses a template name that is not a slug, and an unknown query key, with 400', async () => {
    expect(
      (await get(`/api/projects/${PROJECT}/pipeline?template=Not%20A%20Slug`)).statusCode,
    ).toBe(400);
    expect((await get(`/api/projects/${PROJECT}/pipeline?stage=qa`)).statusCode).toBe(400);
    expect(world.reads).toEqual([]);
  });

  it.each([
    [{ kind: 'not_found' } as const, 404, 'not_found'],
    [{ kind: 'unknown_template', template: 'nightly' } as const, 404, 'template_not_found'],
    [{ kind: 'config_refused' } as const, 409, 'project_config_refused'],
    [
      { kind: 'not_compilable', template: 'feature', why: 'stage x points nowhere' } as const,
      409,
      'pipeline_not_compilable',
    ],
  ])('answers %o as %i %s', async (result, status, code) => {
    world.project = result;
    const reply = await get(`/api/projects/${PROJECT}/pipeline`);
    expect(reply.statusCode).toBe(status);
    expect(reply.json().error.code).toBe(code);
  });
});
