/**
 * The context pack, assembled over a **real PostgreSQL** — the half the acceptance figure does not
 * cover.
 *
 * `packages/application/src/knowledge/context-pack.test.ts` produces WP-16's acceptance number
 * against the in-memory store, and review asked the question that follows from that: the figure is
 * a property of a fake whose own divergence register says its ordering differs from Postgres, and
 * nothing pinned pack *composition* against the real thing. It was cheap, so it is pinned here.
 *
 * The figure is pinned **separately** from the in-memory one rather than shared, because the two
 * rankers are free to disagree and the divergence register says so. Measured, on this corpus they
 * do **not**: both spend 10 552 tokens. That is a stronger result than the file was written
 * expecting and it is recorded as a measurement, not promoted into a guarantee — a vault change can
 * separate them, and then two independent expectations move independently instead of one shared
 * expectation hiding which store moved. What must agree in every case is everything that is not
 * the ranking:
 *
 *  - tier 0 is the same four documents;
 *  - the path-matched lesson is admitted with score 1.0 and reason `paths` in both;
 *  - a billing query admits no session page and a session query admits no billing page;
 *  - the budget is respected, and the pack is not empty.
 *
 * The last one is the point of the file. Round 1's assembler passed raw task text to
 * `websearch_to_tsquery`, which ANDs bare words: the acceptance query matched **zero** documents
 * here while the double returned fifteen, so a green unit tier was describing a retrieval path
 * production did not have. A pack test against the real store is what makes that impossible to
 * repeat.
 */
import type { Transaction } from '@platform/application';
import {
  createContextPackAssembler,
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_REPO_PATHS,
  FIXTURE_TOUCHED_PATHS,
  FIXTURE_VAULT,
  silentLogger,
  vaultRelativePath,
} from '@platform/application';
import type { Id, IsoDate } from '@platform/contracts';
import { DEFAULT_CONTEXT_BUDGET_TOKENS, parseKbDocument } from '@platform/domain';
import { knowledge } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: Id;
let client: pg.Client;

const TODAY = '2026-09-11' as IsoDate;

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

beforeAll(async () => {
  database = await createMigratedDatabase('context-pack');
  client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  const org = await client.query<{ id: string }>(
    "insert into organizations (name) values ('pack') returning id",
  );
  const project = await client.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'demo', 'Demo', 'https://git.example.test/acme/demo.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
  const tx = { adapter: 'postgres', client } as unknown as Transaction;
  await new knowledge.PostgresKnowledgeStore(client).write(tx, {
    projectId,
    commitSha: 'abc1234',
    documents: parsedFixture(),
    removedPaths: [],
  });
}, 180_000);

afterAll(async () => {
  await client?.end();
  await database?.drop();
});

const packOver = async (
  overrides: { taskText?: string; touchedPaths?: readonly string[] } = {},
) => {
  const assembler = createContextPackAssembler({
    store: new knowledge.PostgresKnowledgeStore(client),
    logger: silentLogger,
  });
  const result = await assembler.assemble({
    projectId,
    stage: 'implementation',
    taskText:
      overrides.taskText ?? 'the session service fails its tests with a foreign key violation',
    touchedPaths: overrides.touchedPaths ?? FIXTURE_TOUCHED_PATHS,
    repoPaths: FIXTURE_REPO_PATHS,
    today: TODAY,
    knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
  });
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result.pack;
};

describe('pack composition against PostgreSQL', () => {
  it('retrieves at all — the defect a fake-only tier could not see', async () => {
    const pack = await packOver();
    expect(pack.queryTerms.length).toBeGreaterThan(0);
    expect(pack.record.tier1.length).toBeGreaterThan(0);
    expect(pack.documents.some((document) => document.tier === 1)).toBe(true);
  });

  it('respects the shipped budget, and produces its own figure', async () => {
    const pack = await packOver();
    expect(pack.record.budget_tokens).toBe(DEFAULT_CONTEXT_BUDGET_TOKENS);
    expect(pack.record.total_tokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET_TOKENS);
    // Pinned separately from the in-memory figure. Measured equal on this corpus — the two
    // rankers admit the same tier 1 here — and kept as its own literal so that the day they
    // diverge, the failing test names which store moved.
    expect(pack.record.total_tokens).toBe(10_552);
  });

  it('makes the same four documents tier 0', async () => {
    const pack = await packOver();
    expect(pack.documents.filter((document) => document.tier === 0).map((d) => d.path)).toEqual([
      '.agentic/knowledge/index.md',
      '.agentic/rules/commit-style.md',
      '.agentic/rules/no-direct-sql.md',
      'CLAUDE.md',
    ]);
  });

  it('scores the path-matched lesson at 1.0 with reason `paths`', async () => {
    const pack = await packOver();
    const top = pack.record.tier1.find((entry) => entry.validated);
    expect(top?.path).toBe('.agentic/knowledge/lessons/L-2026-01-04-session-fixtures.md');
    expect(top?.reason).toBe('paths');
    expect(top?.score).toBe(1);
  });

  it('keeps a billing task away from the session pages, and the reverse', async () => {
    const billing = await packOver({
      taskText: 'Fix the flaky billing invoice tax rounding for EUR',
      touchedPaths: ['src/billing/tax.ts'],
    });
    const billingPaths = billing.documents.map((document) => document.path);
    expect(billingPaths).toContain(`${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2025-06-10-tax-rounding.md`);
    expect(billingPaths).not.toContain(
      `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
    );
    expect(billingPaths).not.toContain(`${FIXTURE_KNOWLEDGE_DIR}/technical/session-service.md`);

    const session = await packOver();
    const sessionPaths = session.documents.map((document) => document.path);
    expect(sessionPaths).toContain(
      `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
    );
    expect(sessionPaths).not.toContain(`${FIXTURE_KNOWLEDGE_DIR}/technical/billing.md`);
  });

  it('gives a degenerate query no text candidates, against the real ranker too', async () => {
    // `"the"` ranks four padded pages at 0.947 here — higher than any real query scores its own
    // answer — which is why the guard is at the query and not at the score (`retrieval.ts`).
    const pack = await packOver({ taskText: 'the', touchedPaths: [] });
    expect(pack.queryTerms).toEqual([]);
    expect(pack.record.tier1).toEqual([]);
  });

  it('stores a document whose source contained a NUL, which PostgreSQL would otherwise refuse', async () => {
    // The correctness half of `sanitise.ts`: one NUL anywhere in a vault page fails the INSERT and
    // takes the whole index run with it. The hostile fixture carries one, and it is in this write.
    const { rows } = await client.query<{ count: string }>(
      'select count(*)::text as count from kb_documents where project_id = $1 and path = $2',
      [projectId, `${FIXTURE_KNOWLEDGE_DIR}/technical/hostile-document.md`],
    );
    expect(rows[0]?.count).toBe('1');
  });
});
