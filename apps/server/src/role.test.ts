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

  it('names no unbuilt workload for any role, now that the index job is registered', () => {
    // It said `indexer (WP-18: the knowledge indexer job is not registered)` until WP-18a, which
    // registered it. A container that looks healthy and does no work is the failure mode the field
    // exists for, and the honest state of this build is that no role is in it.
    for (const role of ROLES) {
      expect(roleCapabilities(role).unimplemented).toEqual([]);
    }
    expect(JSON.stringify(roleCapabilities('indexer'))).not.toContain('WP-18');
  });

  /**
   * WP-18a, and the same reasoning `runner` got at WP-15g: an index run happens in the
   * `knowledge.index` job, which is a pg-boss queue the **worker** subscribes to, so a role that
   * did not dispatch or work would take no index job — it would serve ops endpoints and wait.
   */
  it('treats ROLE=indexer as a worker', () => {
    expect(roleCapabilities('indexer')).toEqual({
      api: false,
      worker: true,
      indexer: true,
      unimplemented: [],
    });
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

  it('reports the roles that have nothing to do in this build — none of them, today', () => {
    // Not idle since WP-18a: it runs the `knowledge.index` queue (and every other worker queue).
    expect(roleIsIdle('indexer')).toBe(false);
    // Not idle since WP-15g: it dispatches events and runs every pipeline job queue.
    expect(roleIsIdle('runner')).toBe(false);
    expect(roleIsIdle('all')).toBe(false);
    expect(roleIsIdle('api')).toBe(false);
    expect(roleIsIdle('worker')).toBe(false);
  });
});
