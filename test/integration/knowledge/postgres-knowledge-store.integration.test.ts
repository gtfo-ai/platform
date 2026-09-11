/**
 * The `KnowledgeStore` contract against a real PostgreSQL 18, plus the half no fake can stand in
 * for (technical/10 integration tier).
 *
 * The shared suite runs against the in-memory store in the contract tier. Here it runs against the
 * SQL, which is what makes WP-16's whole unit tier — the indexer's tests and the context pack's
 * acceptance figure, both of which drive the in-memory store — a claim about the product.
 *
 * Four things only this tier can check, each of them a divergence the in-memory store's register
 * declares:
 *
 *  - the **generated** `kb_chunks.search` column really is a `tsvector` and really is queried by
 *    `websearch_to_tsquery('simple', …)`;
 *  - `ts_rank_cd`'s normalisation puts the rank in `[0, 1]`, which `contextPackRecordSchema`
 *    requires and which the TypeScript side never enforces;
 *  - a write is **transactional**: a rolled-back index run leaves the previous documents in place,
 *    which the in-memory store cannot show because it ignores the handle;
 *  - `loadTier0`'s `where` clause agrees with `isTier0Path`, the TypeScript predicate the contract
 *    suite runs over the same corpus (standing rule 41 — one rule, two spellings, neither trusted).
 */
import type { Transaction } from '@platform/application';
import {
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_VAULT,
  vaultRelativePath,
} from '@platform/application';
import { extractQueryTerms, parseKbDocument } from '@platform/domain';
import { knowledge } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKnowledgeStoreContract } from '../../contract/support/knowledge-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;

const termsOf = (text: string): readonly string[] => extractQueryTerms(text);

const connect = async (): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  return client;
};

beforeAll(async () => {
  database = await createMigratedDatabase('knowledge-store');
  const client = await connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('knowledge-store') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'demo', 'Demo', 'https://git.example.test/acme/demo.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

runKnowledgeStoreContract({
  name: 'postgres',
  create: async () => {
    const client = await connect();
    await client.query('begin');
    return {
      store: new knowledge.PostgresKnowledgeStore(client),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId,
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

const parsedFixture = () =>
  FIXTURE_VAULT.flatMap((document) => {
    const parse = parseKbDocument({
      path: document.path,
      vaultRelativePath: vaultRelativePath(document.path, FIXTURE_KNOWLEDGE_DIR),
      source: document.source,
      projectKey: FIXTURE_PROJECT_KEY,
    });
    return parse.status === 'ok'
      ? [{ document: parse.document, blobSha: document.contentHash }]
      : [];
  });

describe('PostgresKnowledgeStore — what only a real database shows', () => {
  it('ranks with ts_rank_cd, normalised into the unit interval the contract requires', async () => {
    const client = await connect();
    try {
      await client.query('begin');
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = new knowledge.PostgresKnowledgeStore(client);
      await store.write(tx, {
        projectId,
        commitSha: 'abc1234',
        documents: parsedFixture(),
        removedPaths: [],
      });

      const result = await store.search({
        projectId,
        terms: termsOf('seeded fixture user session tests'),
        limit: 10,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(hit.rank).toBeGreaterThan(0);
        // `ts_rank_cd` is unbounded above; normalisation flag 32 is what makes the score a unit
        // interval, and `contextPackRecordSchema.score` refuses anything else.
        expect(hit.rank).toBeLessThanOrEqual(1);
      }
      // Descending, which the query's `order by` promises and the in-memory store does not share.
      const ranks = result.hits.map((hit) => hit.rank);
      expect([...ranks].sort((left, right) => right - left)).toEqual(ranks);
      expect(result.hits[0]?.path).toContain('lessons/L-2026-01-04-session-fixtures');
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });

  it('generates kb_chunks.search from the text column rather than trusting the writer', async () => {
    const client = await connect();
    try {
      await client.query('begin');
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = new knowledge.PostgresKnowledgeStore(client);
      await store.write(tx, {
        projectId,
        commitSha: 'abc1234',
        documents: parsedFixture(),
        removedPaths: [],
      });
      const { rows } = await client.query<{ generated: boolean; nonempty: number }>(
        `select (select is_generated from information_schema.columns
                  where table_name = 'kb_chunks' and column_name = 'search') = 'ALWAYS' as generated,
                (select count(*) from kb_chunks where search is not null and search <> '')::int as nonempty`,
      );
      expect(rows[0]?.generated).toBe(true);
      expect(rows[0]?.nonempty).toBeGreaterThan(0);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });

  it('stores the confidence label as its retrieval weight, and keeps the label in frontmatter', async () => {
    // product/05 writes `confidence: confirmed`; technical/03's column is a real in [0, 1]. Both
    // are right and this is where they are reconciled.
    const client = await connect();
    try {
      await client.query('begin');
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = new knowledge.PostgresKnowledgeStore(client);
      await store.write(tx, {
        projectId,
        commitSha: 'abc1234',
        documents: parsedFixture(),
        removedPaths: [],
      });
      const { rows } = await client.query<{
        confidence: number;
        frontmatter: { confidence?: string };
      }>('select confidence, frontmatter from kb_documents where project_id = $1 and path = $2', [
        projectId,
        `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
      ]);
      expect(rows[0]?.confidence).toBe(1);
      expect(rows[0]?.frontmatter.confidence).toBe('confirmed');
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });

  it('resolves a wikilink to the document it names, and leaves a dangling one unresolved', async () => {
    const client = await connect();
    try {
      await client.query('begin');
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = new knowledge.PostgresKnowledgeStore(client);
      await store.write(tx, {
        projectId,
        commitSha: 'abc1234',
        documents: [
          ...parsedFixture(),
          ...(() => {
            const parse = parseKbDocument({
              path: `${FIXTURE_KNOWLEDGE_DIR}/technical/links.md`,
              vaultRelativePath: 'technical/links.md',
              source:
                '# Links\n\nSee [[decisions/D-0001-postgres-sessions.md]] and [[nowhere/missing.md]].\n',
              projectKey: FIXTURE_PROJECT_KEY,
            });
            return parse.status === 'ok' ? [{ document: parse.document, blobSha: 'links-1' }] : [];
          })(),
        ],
        removedPaths: [],
      });
      const { rows } = await client.query<{ to_path: string; resolved: string | null }>(
        `select l.to_path, l.resolved_document_id as resolved
           from kb_links l join kb_documents d on d.id = l.from_document_id
          where d.project_id = $1 and d.path = $2 order by l.to_path`,
        [projectId, `${FIXTURE_KNOWLEDGE_DIR}/technical/links.md`],
      );
      const byPath = new Map(rows.map((row) => [row.to_path, row.resolved]));
      expect(byPath.get('decisions/D-0001-postgres-sessions.md')).not.toBeNull();
      expect(byPath.get('nowhere/missing.md')).toBeNull();
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });

  it('is transactional: a rolled-back index run leaves the previous documents in place', async () => {
    // The one divergence the in-memory store cannot show, because it ignores the handle.
    const first = await connect();
    try {
      const tx = { adapter: 'postgres', client: first } as unknown as Transaction;
      await first.query('begin');
      await new knowledge.PostgresKnowledgeStore(first).write(tx, {
        projectId,
        commitSha: 'abc1234',
        documents: parsedFixture(),
        removedPaths: [],
      });
      await first.query('commit');
    } finally {
      await first.end();
    }

    const attempted = await connect();
    try {
      const tx = { adapter: 'postgres', client: attempted } as unknown as Transaction;
      await attempted.query('begin');
      await new knowledge.PostgresKnowledgeStore(attempted).write(tx, {
        projectId,
        commitSha: 'def5678',
        documents: [],
        removedPaths: [],
      });
      await attempted.query('rollback');
    } finally {
      await attempted.end();
    }

    const reader = await connect();
    try {
      const store = new knowledge.PostgresKnowledgeStore(reader);
      const blobs = await store.readIndexedBlobs(projectId);
      expect(blobs.size).toBe(parsedFixture().length);
      expect((await store.readIndexState(projectId))?.commitSha).toBe('abc1234');
      await reader.query('delete from kb_documents where project_id = $1', [projectId]);
      await reader.query('delete from kb_index_state where project_id = $1', [projectId]);
    } finally {
      await reader.end();
    }
  });
});
