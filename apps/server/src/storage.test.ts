/**
 * The storage gauge's samplers (WP-65, Q63): the mirror walk answers scrapes for a minute, and a
 * process with no mirror root has no mirror sampler at all.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageSamplers, MIRROR_SAMPLE_TTL_MS } from './storage.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agentic-storage-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pool = (bytes: string) =>
  ({
    query: async () => ({ rows: [{ bytes }] }),
  }) as unknown as pg.Pool;

describe('the storage samplers', () => {
  it('reads the database size on every scrape', async () => {
    const samplers = createStorageSamplers({ pool: pool('4096'), mirrorRoot: null });
    expect(await samplers.database()).toBe(4096);
    expect(samplers.mirrors).toBeNull();
  });

  it('walks the mirror root once per window, and again after it', async () => {
    let now = 0;
    const samplers = createStorageSamplers({ pool: pool('1'), mirrorRoot: root, now: () => now });
    const first = await samplers.mirrors?.();
    expect(first).toEqual({ totalBytes: 0, mirrors: [] });
    // The root disappears; a scrape inside the window still answers the cached reading.
    await rm(root, { recursive: true, force: true });
    now = MIRROR_SAMPLE_TTL_MS - 1;
    expect(await samplers.mirrors?.()).toBe(first);
    now = MIRROR_SAMPLE_TTL_MS;
    expect(await samplers.mirrors?.(), 'an unreadable root is absent, not zero').toBeNull();
  });
});
