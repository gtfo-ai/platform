/**
 * **The positive assertion for the kindest divergence in `memory-knowledge.ts`** — register row 1d,
 * standing rules 1 and 12.
 *
 * The in-memory store accepts a `U+0000` in a chunk's text, as any `Map` would. PostgreSQL refuses
 * it outright — `invalid byte sequence for encoding "UTF8": 0x00` — so **one** such character in
 * **one** vault page fails the `INSERT` and takes an entire index run with it. That is the shape
 * rule 12 is about: the place a fake is most permissive is the place a later work package leans
 * hardest, and documenting it is necessary and not sufficient.
 *
 * ## Why this is a file of its own
 *
 * The pair lived in `context-pack.integration.test.ts` first, and measured, that did not work:
 * deleting `sanitiseDocumentText` makes that file's `beforeAll` throw while writing the hostile
 * fixture, and vitest then reports
 * `FAIL |integration| test/…/context-pack.integration.test.ts [ … ]` — a failure naming a **file**,
 * which standing rule 62 says is not a failure naming a **test**. Here the `beforeAll` writes
 * nothing but a project row, so each assertion below fails by its own name.
 *
 * ## The pair, and which mutation kills which
 *
 * - *refuses an unsanitised NUL* pins the **refusal**. It plants the byte after the parser, so it
 *   is independent of the sanitiser and would fail if someone closed the gap by quietly stripping
 *   NULs in the adapter instead — which would hide the divergence rather than guard it.
 * - *accepts the same bytes once the sanitiser has run* pins the **guard**. Deleting
 *   `sanitiseDocumentText` fails it by name.
 *
 * Two sides, because a boundary asserted from one side is half a test (rule 42).
 */
import type { Transaction } from '@platform/application';
import { FIXTURE_KNOWLEDGE_DIR, FIXTURE_PROJECT_KEY } from '@platform/application';
import type { Id } from '@platform/contracts';
import { parseKbDocument } from '@platform/domain';
import { knowledge } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: Id;

const PATH = `${FIXTURE_KNOWLEDGE_DIR}/technical/raw-nul.md`;

beforeAll(async () => {
  database = await createMigratedDatabase('nul-refusal');
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('nul') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'demo', 'Demo', 'https://git.example.test/acme/demo.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as Id;
  } finally {
    await client.end();
  }
}, 180_000);

afterAll(async () => {
  await database?.drop();
});

const parsed = (source: string) => {
  const result = parseKbDocument({
    path: PATH,
    vaultRelativePath: 'technical/raw-nul.md',
    source,
    projectKey: FIXTURE_PROJECT_KEY,
  });
  if (result.status !== 'ok') throw new Error('fixture should parse');
  return result.document;
};

const inTransaction = async (
  body: (
    store: knowledge.PostgresKnowledgeStore,
    tx: Transaction,
    client: pg.Client,
  ) => Promise<void>,
): Promise<void> => {
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await body(
      new knowledge.PostgresKnowledgeStore(client),
      { adapter: 'postgres', client } as unknown as Transaction,
      client,
    );
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
};

describe('a NUL byte, and what stands between the two stores', () => {
  it('refuses an unsanitised NUL, which is what the domain sanitiser stands between', async () => {
    const document = parsed('# Raw\n\nbody');
    // Put the byte back *after* the parser: the sanitiser is the only thing that removes it, so
    // this is the only way to reach the adapter with one.
    const withNul = {
      ...document,
      chunks: document.chunks.map((chunk) => ({ ...chunk, text: `${chunk.text}\u{0000}tail` })),
    };
    await inTransaction(async (store, tx) => {
      await expect(
        store.write(tx, {
          projectId,
          commitSha: 'abc1234',
          documents: [{ document: withNul, blobSha: 'raw-nul-1' }],
          removedPaths: [],
        }),
      ).rejects.toThrow(/0x00|invalid byte sequence/i);
    });
  });

  it('accepts the same bytes once the sanitiser has run, so the guard is the difference', async () => {
    const document = parsed('# Raw\n\nbody\u{0000}tail');
    expect(document.sanitised).toBe(1);
    await inTransaction(async (store, tx, client) => {
      await store.write(tx, {
        projectId,
        commitSha: 'abc1234',
        documents: [{ document, blobSha: 'raw-nul-2' }],
        removedPaths: [],
      });
      const { rows } = await client.query<{ count: string }>(
        'select count(*)::text as count from kb_documents where project_id = $1 and path = $2',
        [projectId, PATH],
      );
      expect(rows[0]?.count).toBe('1');
    });
  });

  it('refuses it as a bare bind parameter too, so the refusal is PostgreSQL and not the adapter', async () => {
    // Narrowing the claim to what was measured: the driver and the server reject the byte, so no
    // amount of adapter care would have made an unsanitised document storable.
    await inTransaction(async (_store, _tx, client) => {
      await expect(client.query('select $1::text as v', ['a\u{0000}b'])).rejects.toThrow(
        /0x00|invalid byte sequence/i,
      );
    });
  });
});
