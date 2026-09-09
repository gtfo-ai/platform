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
    expect(roleCapabilities('runner').unimplemented).toEqual([expect.stringContaining('WP-12')]);
    expect(roleCapabilities('indexer').unimplemented).toEqual([expect.stringContaining('WP-16')]);
    expect(roleCapabilities('api').unimplemented).toEqual([]);
    expect(roleCapabilities('worker').unimplemented).toEqual([]);
  });

  it('reports the roles that have nothing to do in this build', () => {
    expect(roleIsIdle('runner')).toBe(true);
    expect(roleIsIdle('indexer')).toBe(true);
    expect(roleIsIdle('all')).toBe(false);
    expect(roleIsIdle('api')).toBe(false);
    expect(roleIsIdle('worker')).toBe(false);
  });
});
