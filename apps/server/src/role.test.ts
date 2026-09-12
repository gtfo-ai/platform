import { describe, expect, it } from 'vitest';
import { isRole, ROLES, roleCapabilities, roleIsIdle } from './role.js';

describe('ROLE bootstrap', () => {
  it('knows exactly the roles technical/01 names', () => {
    expect([...ROLES]).toEqual(['all', 'api', 'worker', 'runner', 'indexer']);
    expect(isRole('api')).toBe(true);
    expect(isRole('API')).toBe(false);
    expect(isRole('wizard')).toBe(false);
  });

  it('gives ROLE=all everything', () => {
    const all = roleCapabilities('all');
    expect(all.api && all.worker).toBe(true);
  });

  it('splits the API from the workers', () => {
    expect(roleCapabilities('api')).toMatchObject({ api: true, worker: false });
    expect(roleCapabilities('worker')).toMatchObject({ api: false, worker: true });
  });

  it('says which workloads no work package has built yet, rather than pretending', () => {
    // A container that looks healthy and does no work is the failure mode this avoids.
    expect(roleCapabilities('indexer').unimplemented).toEqual([expect.stringContaining('WP-18')]);
    expect(roleCapabilities('api').unimplemented).toEqual([]);
    expect(roleCapabilities('worker').unimplemented).toEqual([]);
  });

  /**
   * WP-15g. The old claim — *runner (WP-12: Claude SDK runner)* — was stale from the day WP-12
   * landed, and the flag it set gated nothing: `runtime.ts` reads `api` and `worker` only, and a run
   * happens in the `stage.execute` job, which is the worker's queue. So `runner` **is** a worker, and
   * whether it can run an agent is a question about its configuration (`agent.ts`), never about its
   * role — because pg-boss would otherwise hand half the agent stages to a worker that composes no
   * runner.
   */
  it('treats ROLE=runner as a worker, and names no work package for it', () => {
    expect(roleCapabilities('runner')).toEqual({
      api: false,
      worker: true,
      indexer: false,
      unimplemented: [],
    });
    expect(JSON.stringify(roleCapabilities('runner'))).not.toContain('WP-12');
  });

  it('reports the roles that have nothing to do in this build', () => {
    expect(roleIsIdle('indexer')).toBe(true);
    // Not idle since WP-15g: it dispatches events and runs every pipeline job queue.
    expect(roleIsIdle('runner')).toBe(false);
    expect(roleIsIdle('all')).toBe(false);
    expect(roleIsIdle('api')).toBe(false);
    expect(roleIsIdle('worker')).toBe(false);
  });
});
