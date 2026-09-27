/**
 * The storage gauge's samplers — database bytes and knowledge-mirror bytes (WP-65, Q63's
 * operator-facing half, product/19 §20).
 *
 * `/metrics` is scraped every few seconds by a typical Prometheus, and the mirror line is a walk of
 * every file under `APP_KNOWLEDGE_MIRROR_ROOT`. A bare mirror is a handful of pack files, so the walk
 * is short, but a scrape is not the place to find out how short: the reading is **cached** for
 * {@link MIRROR_SAMPLE_TTL_MS} and a scrape inside that window reuses it. The database line is one
 * `pg_database_size` call and is read on every scrape.
 */
import { knowledge as knowledgeAdapters } from '@platform/infrastructure';
import type pg from 'pg';

/** How long one walk of the mirror root answers scrapes for. */
export const MIRROR_SAMPLE_TTL_MS = 60_000;

export interface StorageSamplers {
  readonly database: () => Promise<number>;
  readonly mirrors: (() => Promise<knowledgeAdapters.MirrorStorage | null>) | null;
}

export const createStorageSamplers = (options: {
  readonly pool: pg.Pool;
  /** `APP_KNOWLEDGE_MIRROR_ROOT`; `null` in a process that has none, which then has no mirror line. */
  readonly mirrorRoot: string | null;
  readonly now?: () => number;
}): StorageSamplers => {
  const now = options.now ?? Date.now;
  let cached: {
    readonly at: number;
    readonly reading: knowledgeAdapters.MirrorStorage | null;
  } | null = null;
  const mirrorRoot = options.mirrorRoot;
  return {
    database: async () => {
      const { rows } = await options.pool.query<{ bytes: string }>(
        'select pg_database_size(current_database()) as bytes',
      );
      return Number(rows[0]?.bytes ?? 0);
    },
    mirrors:
      mirrorRoot === null
        ? null
        : async () => {
            const at = now();
            if (cached === null || at - cached.at >= MIRROR_SAMPLE_TTL_MS) {
              cached = { at, reading: await knowledgeAdapters.measureKnowledgeMirrors(mirrorRoot) };
            }
            return cached.reading;
          },
  };
};
