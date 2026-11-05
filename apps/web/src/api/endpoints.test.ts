/**
 * The client half of S-23.15's two graph reads: the paths they name (the server's census compares
 * them with the router) and the published schemas they parse with.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEndpoints } from './endpoints.js';
import { createApiClient } from './http.js';

const GRAPH = {
  template: 'feature',
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
  ],
  edges: [],
};

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const answering = (body: unknown) =>
  vi.fn<FetchMock>(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

describe('the stage-graph endpoints (S-23.15)', () => {
  it('reads a task’s graph from /api/tasks/:id/pipeline', async () => {
    const fetchImpl = answering(GRAPH);
    const endpoints = createEndpoints(
      createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await expect(endpoints.taskPipeline('task-1')).resolves.toEqual(GRAPH);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/tasks/task-1/pipeline');
  });

  it('reads a project’s graphs, with the template only when one is named', async () => {
    const fetchImpl = answering({ items: [GRAPH] });
    const endpoints = createEndpoints(
      createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await expect(endpoints.projectPipelines('project-1')).resolves.toEqual({ items: [GRAPH] });
    await endpoints.projectPipelines('project-1', 'bug');
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/projects/project-1/pipeline',
      '/api/projects/project-1/pipeline?template=bug',
    ]);
  });

  it('refuses an answer that does not match the published graph', async () => {
    const endpoints = createEndpoints(
      createApiClient({
        fetchImpl: answering({
          ...GRAPH,
          edges: [{ from: 'a', to: 'b', kind: 'jump' }],
        }) as unknown as typeof fetch,
      }),
    );
    await expect(endpoints.taskPipeline('task-1')).rejects.toThrow();
  });
});
