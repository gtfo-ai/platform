/**
 * The knowledge mirrors on disk — measured per project, and evicted by **last use**, never by age
 * (WP-65, Q63). Real directories under a temporary root: the walk and the removal are the code
 * under test, and a double of the filesystem would be a double of exactly that.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Id } from '@platform/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mirrorCacheKeyFor } from '../workspace/spec.js';
import {
  bytesUnder,
  evictKnowledgeMirrors,
  MIRROR_EVICTION_MIN_IDLE_MS,
  MIRROR_LAST_USED_FILE,
  markMirrorUsed,
  measureKnowledgeMirrors,
  projectIdOfMirrorKey,
} from './mirror-storage.js';

const OLD = '00000000-0000-4000-8000-0000000000a1' as Id;
const ACTIVE = '00000000-0000-4000-8000-0000000000a2' as Id;
const IDLE = '00000000-0000-4000-8000-0000000000a3' as Id;
const NOW = new Date('2026-06-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agentic-mirrors-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A mirror of `bytes` bytes of pack, last used at `usedAt` (or unstamped, dated by mtime). */
const mirror = async (
  projectId: Id,
  bytes: number,
  usedAt: Date | null,
  directoryTime: Date = usedAt ?? NOW,
): Promise<string> => {
  const directory = path.join(root, mirrorCacheKeyFor(projectId));
  await mkdir(path.join(directory, 'objects', 'pack'), { recursive: true });
  await writeFile(path.join(directory, 'objects', 'pack', 'pack-1.pack'), Buffer.alloc(bytes, 1));
  if (usedAt !== null) {
    await markMirrorUsed(directory, usedAt);
  }
  await utimes(directory, directoryTime, directoryTime);
  return directory;
};

describe('the mirror key', () => {
  it('maps back to the project it was derived from, and refuses a name it did not create', () => {
    expect(projectIdOfMirrorKey(mirrorCacheKeyFor(OLD))).toBe(OLD);
    expect(projectIdOfMirrorKey('lost+found')).toBeNull();
    expect(projectIdOfMirrorKey('p1234')).toBeNull();
  });
});

describe('measuring the mirrors', () => {
  it('reports each project’s bytes and their total, largest first', async () => {
    await mirror(OLD, 50_000, new Date(NOW.getTime() - 10 * HOUR));
    await mirror(ACTIVE, 200_000, NOW);
    const storage = await measureKnowledgeMirrors(root);
    expect(storage?.mirrors.map((entry) => entry.projectId)).toEqual([ACTIVE, OLD]);
    expect(storage?.mirrors[0]?.bytes).toBeGreaterThanOrEqual(200_000);
    expect(storage?.totalBytes).toBe(
      (storage?.mirrors ?? []).reduce((sum, entry) => sum + entry.bytes, 0),
    );
    expect(storage?.mirrors.find((entry) => entry.projectId === OLD)?.lastUsedAt).toBe(
      new Date(NOW.getTime() - 10 * HOUR).toISOString(),
    );
  });

  it('ignores a directory whose name is not a mirror key', async () => {
    await mkdir(path.join(root, 'lost+found'));
    await writeFile(path.join(root, 'lost+found', 'x'), Buffer.alloc(10_000, 1));
    expect((await measureKnowledgeMirrors(root))?.mirrors).toEqual([]);
  });

  it('answers null for a root that does not exist — absent, not zero', async () => {
    expect(await measureKnowledgeMirrors(path.join(root, 'missing'))).toBeNull();
  });

  it('dates an unstamped mirror by its directory', async () => {
    const at = new Date(NOW.getTime() - 5 * HOUR);
    await mirror(IDLE, 1_000, null, at);
    const storage = await measureKnowledgeMirrors(root);
    expect(storage?.mirrors[0]?.lastUsedAt).toBe(at.toISOString());
  });
});

describe('a file that vanishes during the walk', () => {
  it('counts as zero bytes rather than failing the measurement', async () => {
    expect(await bytesUnder(path.join(root, 'never-there'))).toBe(0);
    const directory = await mirror(IDLE, 4_096, NOW);
    const before = await bytesUnder(directory);
    await rm(path.join(directory, 'objects', 'pack', 'pack-1.pack'));
    const after = await bytesUnder(directory);
    expect(after).toBeLessThan(before);
    expect((await measureKnowledgeMirrors(root))?.mirrors).toHaveLength(1);
  });
});

describe('eviction by last use', () => {
  it('removes the least recently used mirror first — not the oldest — until under the ceiling', async () => {
    // OLD was cloned first (its directory is the oldest) but was used an hour and a half ago;
    // IDLE was cloned later and has not been used for ten hours. Age would evict OLD.
    await mirror(OLD, 100_000, new Date(NOW.getTime() - 1.5 * HOUR), new Date('2026-01-01'));
    await mirror(IDLE, 100_000, new Date(NOW.getTime() - 10 * HOUR), new Date('2026-05-01'));
    await mirror(ACTIVE, 100_000, NOW);
    const before = await measureKnowledgeMirrors(root);
    const ceiling = (before?.totalBytes ?? 0) - 1;

    const eviction = await evictKnowledgeMirrors({ root, ceilingBytes: ceiling, now: NOW });

    expect(eviction?.evicted.map((entry) => entry.projectId)).toEqual([IDLE]);
    expect(eviction?.stillOver).toBe(false);
    const left = await readdir(root);
    expect(left.sort()).toEqual([mirrorCacheKeyFor(OLD), mirrorCacheKeyFor(ACTIVE)].sort());
  });

  it('never removes the mirror just read, nor one used within the hour, and says it is still over', async () => {
    await mirror(ACTIVE, 100_000, new Date(NOW.getTime() - 3 * HOUR));
    await mirror(IDLE, 100_000, new Date(NOW.getTime() - MIRROR_EVICTION_MIN_IDLE_MS / 2));
    const eviction = await evictKnowledgeMirrors({
      root,
      ceilingBytes: 1,
      now: NOW,
      keepProjectId: ACTIVE,
    });
    expect(eviction?.evicted).toEqual([]);
    expect(eviction?.stillOver).toBe(true);
    expect((await readdir(root)).length).toBe(2);
  });

  it('removes nothing when the mirrors are already under the ceiling', async () => {
    await mirror(IDLE, 1_000, new Date(NOW.getTime() - 10 * HOUR));
    const eviction = await evictKnowledgeMirrors({ root, ceilingBytes: 10_000_000, now: NOW });
    expect(eviction?.evicted).toEqual([]);
    expect(await readdir(root)).toEqual([mirrorCacheKeyFor(IDLE)]);
  });

  it('writes the stamp a read leaves, which is what eviction orders by', async () => {
    const directory = await mirror(IDLE, 1_000, null);
    await markMirrorUsed(directory, NOW);
    expect(await readdir(directory)).toContain(MIRROR_LAST_USED_FILE);
    expect((await measureKnowledgeMirrors(root))?.mirrors[0]?.lastUsedAt).toBe(NOW.toISOString());
  });
});
