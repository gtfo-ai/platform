/**
 * The knowledge mirrors on the platform's own disk — how many bytes, whose, when last used, and
 * which to remove first (WP-65, Q63's operator-facing half).
 *
 * TD-026 put one bare mirror per project under `APP_KNOWLEDGE_MIRROR_ROOT`, cloned on the project's
 * first index run and never removed. They grow with the **customer's** repository rather than with
 * the platform's activity — a monorepo can outweigh a year of transcripts — and until this file no
 * number said so. Two things live here, and both read the same directory walk:
 *
 *  1. **the measurement** behind the storage gauge's mirror line, broken down per project because a
 *     project is the axis an operator can act on;
 *  2. **eviction by last use**, under an operator-declared ceiling (`APP_KNOWLEDGE_MIRROR_MAX_BYTES`,
 *     no default: absent is *no ceiling*, Q63's recommended default). A mirror is a rebuildable cache
 *     (BD-012) and removing one costs a re-clone and nothing else — but a ceiling that evicted by
 *     **age** would remove the mirror of the oldest, and therefore often the most active, project
 *     and turn its next index run into a full clone at the worst moment. So the order is least
 *     recently **used** first.
 *
 * ## What "used" means, and where it is written
 *
 * A read of the mirror — the index run's, or the repository-file reader's — stamps a file inside it
 * ({@link MIRROR_LAST_USED_FILE}) with the instant ({@link markMirrorUsed}, called by `git-vault.ts`
 * **before** any git work on an existing mirror and again once the read is prepared — review
 * round 1: a stamp written only after the fetch let an eviction in another process remove a
 * mirror mid-fetch). Git ignores a file it does not know in a bare repository's directory,
 * and the stamp is removed with the mirror. A mirror written before this build has no stamp; its
 * directory's own modification time stands in, labelled as such in nothing but this sentence —
 * it is the time the last fetch changed the directory, which is a use.
 *
 * ## What eviction will not do
 *
 *  - remove a mirror used within {@link MIRROR_EVICTION_MIN_IDLE_MS}. A read in flight — this
 *    process's or another's on the shared volume — holds no lock eviction can see; what protects it
 *    is that the read stamps the mirror **before** it runs git, so a read that started less than an
 *    hour ago is inside the bound. That is a bound on time, not a lock, and the residual is stated:
 *    a single fetch that runs longer than an hour, or a first **clone** (which cannot be stamped
 *    before it exists; its fresh directory's modification time stands in) whose directory stops
 *    changing for an hour, could be removed under it — the read then fails `vault_unavailable` and
 *    the next run re-clones;
 *  - remove the mirror of the project the caller names as in use (`keepProjectId`) — the one it
 *    has just read;
 *  - remove anything whose name is not a mirror key ({@link projectIdOfMirrorKey}): the root is an
 *    operator's volume, and a directory this module did not create is not its to delete.
 *
 * Bytes are **allocated** bytes (`blocks × 512`, what `du` reports) where the platform reports
 * blocks, and apparent size where it does not; symbolic links are counted as themselves and never
 * followed.
 */
import { lstat, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Id, IsoDateTime } from '@platform/contracts';
import { mirrorCacheKeyFor } from '../workspace/spec.js';

/** The stamp a read writes; a name git does not use in a bare repository. */
export const MIRROR_LAST_USED_FILE = 'agentic-last-used';

/**
 * A mirror used more recently than this is never evicted. An hour, which is four times
 * `knowledge.index`'s 15-minute job expiry: a read of another project that is still in flight when
 * the ceiling is checked is inside it by construction.
 */
export const MIRROR_EVICTION_MIN_IDLE_MS = 60 * 60 * 1000;

/** `mirrorCacheKeyFor`'s output shape for a uuid: `p` and 32 lower-case hex digits. */
const MIRROR_KEY_FOR_UUID = /^p([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;

/** The project a mirror directory belongs to, or `null` for a name this module did not create. */
export const projectIdOfMirrorKey = (key: string): Id | null => {
  const match = MIRROR_KEY_FOR_UUID.exec(key);
  return match === null ? null : (match.slice(1).join('-') as Id);
};

export interface MirrorUsage {
  readonly projectId: Id;
  /** The directory name under the root. */
  readonly key: string;
  readonly bytes: number;
  readonly lastUsedAt: IsoDateTime;
}

export interface MirrorStorage {
  readonly totalBytes: number;
  /** Largest first. */
  readonly mirrors: readonly MirrorUsage[];
}

/** Stamps a mirror as used now. A failure is the caller's to log: a read must not fail on it. */
export const markMirrorUsed = async (mirror: string, at: Date): Promise<void> => {
  await writeFile(path.join(mirror, MIRROR_LAST_USED_FILE), `${at.toISOString()}\n`, 'utf8');
};

/** `ENOENT`: the path went away between listing it and reading it. */
const vanished = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Bytes under `target`, not following symbolic links.
 *
 * A path that **vanishes** between `readdir` and `lstat` counts as 0 bytes rather than failing the
 * walk (review round 1): git replaces pack files and lock files while a fetch runs, and an eviction
 * may remove a whole mirror, so a file listed a moment ago is not an error — it is no longer on
 * the disk this measures. Any other error still throws.
 */
export const bytesUnder = async (target: string): Promise<number> => {
  let total = 0;
  const pending = [target];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let facts: Awaited<ReturnType<typeof lstat>>;
    try {
      facts = await lstat(current);
    } catch (cause) {
      if (vanished(cause)) {
        continue;
      }
      throw cause;
    }
    total += facts.blocks > 0 ? facts.blocks * 512 : facts.size;
    if (facts.isDirectory()) {
      let entries: string[];
      try {
        entries = await readdir(current);
      } catch (cause) {
        if (vanished(cause)) {
          continue;
        }
        throw cause;
      }
      for (const entry of entries) {
        pending.push(path.join(current, entry));
      }
    }
  }
  return total;
};

const lastUsedOf = async (mirror: string): Promise<IsoDateTime> => {
  try {
    const stamp = (await readFile(path.join(mirror, MIRROR_LAST_USED_FILE), 'utf8')).trim();
    const parsed = Date.parse(stamp);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString() as IsoDateTime;
    }
  } catch {
    // No stamp: a mirror from before this build. The directory's mtime is the fallback, below.
  }
  return (await stat(mirror)).mtime.toISOString() as IsoDateTime;
};

/**
 * Every mirror under `root`, measured — or `null` when `root` is not a directory this process can
 * read, which is a different answer from "no mirrors" (standing rule 16: absent is not zero).
 */
export const measureKnowledgeMirrors = async (root: string): Promise<MirrorStorage | null> => {
  let names: string[];
  try {
    if (!(await stat(root)).isDirectory()) {
      return null;
    }
    names = await readdir(root);
  } catch {
    return null;
  }
  const mirrors: MirrorUsage[] = [];
  for (const key of names.sort()) {
    const projectId = projectIdOfMirrorKey(key);
    const mirror = path.join(root, key);
    try {
      if (projectId === null || !(await lstat(mirror)).isDirectory()) {
        continue;
      }
      mirrors.push({
        projectId,
        key,
        bytes: await bytesUnder(mirror),
        lastUsedAt: await lastUsedOf(mirror),
      });
    } catch (cause) {
      // A mirror evicted (or never finished) between the listing and its measurement is not on
      // the disk any more; it is left out rather than failing the gauge.
      if (!vanished(cause)) {
        throw cause;
      }
    }
  }
  mirrors.sort((left, right) => right.bytes - left.bytes);
  return { totalBytes: mirrors.reduce((sum, entry) => sum + entry.bytes, 0), mirrors };
};

export interface MirrorEviction {
  /** What was removed, least recently used first. */
  readonly evicted: readonly MirrorUsage[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  /**
   * `true` when the mirrors are still over the ceiling after every mirror eviction was allowed to
   * remove — they are all recent, or the one in use is itself larger than the ceiling. Reported
   * rather than resolved by removing an active mirror.
   */
  readonly stillOver: boolean;
}

/**
 * Removes least-recently-used mirrors until the total is at or under `ceilingBytes`.
 *
 * `null` when the root cannot be measured. Never removes the `keep` key, a mirror used within
 * {@link MIRROR_EVICTION_MIN_IDLE_MS} of `now`, or a directory whose name is not a mirror key.
 */
export const evictKnowledgeMirrors = async (input: {
  readonly root: string;
  readonly ceilingBytes: number;
  readonly now: Date;
  /** The project whose mirror the caller has just read, which is by definition in use. */
  readonly keepProjectId?: Id;
}): Promise<MirrorEviction | null> => {
  const keep =
    input.keepProjectId === undefined ? undefined : mirrorCacheKeyFor(input.keepProjectId);
  const storage = await measureKnowledgeMirrors(input.root);
  if (storage === null) {
    return null;
  }
  let remaining = storage.totalBytes;
  const evicted: MirrorUsage[] = [];
  const idleSince = input.now.getTime() - MIRROR_EVICTION_MIN_IDLE_MS;
  const candidates = [...storage.mirrors]
    .filter((entry) => entry.key !== keep && Date.parse(entry.lastUsedAt) <= idleSince)
    .sort((left, right) => (left.lastUsedAt < right.lastUsedAt ? -1 : 1));
  for (const candidate of candidates) {
    if (remaining <= input.ceilingBytes) {
      break;
    }
    await rm(path.join(input.root, candidate.key), { recursive: true, force: true });
    remaining -= candidate.bytes;
    evicted.push(candidate);
  }
  return {
    evicted,
    bytesBefore: storage.totalBytes,
    bytesAfter: remaining,
    stillOver: remaining > input.ceilingBytes,
  };
};
