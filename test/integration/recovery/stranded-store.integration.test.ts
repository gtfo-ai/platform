/**
 * The two queries of the lost-wake-up table and the two endings that bound them, against a real
 * PostgreSQL 18 (WP-36, backlog 101 and **105**).
 *
 * The unit tier drives the pass through a double, so the *predicates* — which is the whole of what
 * these queries are — are unexercised there. Each case asserts both directions (standing rule 42):
 * the stranded row is found, and the row that is merely *in flight*, already finished, already
 * attempted or **already running** is not, because a recovery that re-enqueued everything would be
 * a recovery that re-runs a batch nobody lost and pays for a second run of a question somebody is
 * already answering.
 */
import type { Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { recovery as recoveryAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: string;
let taskId: string;
let userId: string;

const store = recoveryAdapters.createPostgresStrandedWorkStore();
const OLDER_THAN = '2026-09-15T10:00:00.000Z' as IsoDateTime;
const LONG_AGO = '2026-09-15T09:00:00.000Z';
/**
 * **After** the cutoff, which is what "in flight" means here: the pass asks for rows *older than*
 * `now - grace`, so a row created inside the grace window still has its own job coming. Written
 * 09:59:59 in the first version of this file — a second *before* the cutoff — and both cases
 * therefore failed with two rows where they expected one, which is the query being right and the
 * fixture being wrong.
 */
const IN_FLIGHT = '2026-09-15T10:00:30.000Z';
/**
 * The second cutoff (backlog 105): a row whose one recovery attempt is older than this has had a
 * whole ending window to move and has not, so the pass ends it instead of re-enqueueing it. An
 * attempt **after** this instant is the row the pass must leave alone — its job may still be queued.
 */
const ENDING_BEFORE = '2026-09-15T09:00:00.000Z' as IsoDateTime;
const ATTEMPTED_LONG_AGO = '2026-09-15T08:30:00.000Z';
const ATTEMPTED_RECENTLY = '2026-09-15T09:30:00.000Z';

const query = { olderThan: OLDER_THAN, endingBefore: ENDING_BEFORE, limit: 10 };

const withTx = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    return await fn({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.end();
  }
};

beforeAll(async () => {
  database = await createMigratedDatabase('stranded');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('stranded') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'strand', 'Stranded', 'https://git.example.test/acme/strand.git')
     returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as string;
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
     values ($1, 'jira', 'STR-1', 'https://jira.example.test/browse/STR-1', 'feature', 'normal')
     returning id`,
    [projectId],
  );
  taskId = task.rows[0]?.id as string;
  const user = await pool.query<{ id: string }>(
    "insert into users (email, name) values ('strand@example.test', 'Asker') returning id",
  );
  userId = user.rows[0]?.id as string;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/**
 * **One batch per project**, which the database insisted on:
 * `history_bootstrap_batches_one_live` is `unique (project_id) where completed_at is null`, and it
 * is the index that turns this loss into a permanent `already_running` — so a case that seeded four
 * live batches on one project failed on insert rather than testing the query.
 */
const seedBatch = async (input: {
  readonly status: string;
  readonly createdAt: string;
  readonly withChunk: boolean;
  readonly completed?: boolean;
  readonly attemptedAt?: string;
  readonly key: string;
}): Promise<{ id: string; projectId: string }> => {
  const owner = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     select org_id, $2, $2, repo_url from projects where id = $1
     returning id`,
    [projectId, input.key],
  );
  const ownerId = owner.rows[0]?.id as string;
  const row = await pool.query<{ id: string }>(
    `insert into history_bootstrap_batches
       (project_id, merge_requests, batch_size, days, cap_usd, estimated_usd, status, created_at,
        completed_at, recovery_attempted_at)
     values ($1, 20, 20, 183, 20, 4, $2, $3, $4, $5)
     returning id`,
    [
      ownerId,
      input.status,
      input.createdAt,
      input.completed === true ? input.createdAt : null,
      input.attemptedAt ?? null,
    ],
  );
  const id = row.rows[0]?.id as string;
  if (input.withChunk) {
    await pool.query(
      `insert into history_bootstrap_chunks
         (batch_id, chunk_index, task_id, merge_requests, tickets, commits, redaction_count, truncated)
       values ($1, 0, $2, 20, 0, 0, 0, false)`,
      [id, taskId],
    );
  }
  return { id, projectId: ownerId };
};

/**
 * `task_asks_answered_triple` makes "answered" one fact with three columns, so an answered row has
 * to be seeded as one — a status alone would be refused by the database.
 */
const seedAsk = async (input: {
  readonly status: string;
  readonly createdAt: string;
  readonly runId?: string;
  readonly attemptedAt?: string;
}): Promise<string> => {
  const answered = input.status === 'answered';
  const row = await pool.query<{ id: string }>(
    `insert into task_asks
       (task_id, project_id, source, asked_by_user_id, question, status, created_at, answer,
        answered_at, run_id, recovery_attempted_at)
     values ($1, $2, 'ui', $3, 'why?', $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      taskId,
      projectId,
      userId,
      input.status,
      input.createdAt,
      answered ? 'because' : null,
      answered ? input.createdAt : null,
      input.runId ?? null,
      input.attemptedAt ?? null,
    ],
  );
  return row.rows[0]?.id as string;
};

/** A run to attach: enough columns to satisfy `runs`' own `not null`s and nothing more. */
const seedRun = async (input: { readonly endedAt?: string } = {}): Promise<string> => {
  const row = await pool.query<{ id: string }>(
    `insert into runs (task_id, project_id, role, model, prompt_version, status, terminal_reason,
                       ended_at)
     values ($1, $2, 'ask', 'claude-sonnet-4-5', 'ask@1',
             $3::run_status, $4::run_terminal_reason, $5)
     returning id`,
    [
      taskId,
      projectId,
      input.endedAt === undefined ? 'running' : 'failed',
      input.endedAt === undefined ? null : 'lease_expired',
      input.endedAt ?? null,
    ],
  );
  return row.rows[0]?.id as string;
};

/** A task of its own, so a chunk or an artifact hangs off one this suite is not sharing. */
const seedTask = async (key: string, owner: string = projectId): Promise<string> => {
  const row = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
     values ($1, 'jira', $2, 'https://jira.example.test/browse/' || $2, 'feature', 'normal')
     returning id`,
    [owner, key],
  );
  return row.rows[0]?.id as string;
};

const seedArtifact = async (input: {
  readonly taskId: string;
  readonly type: string;
  readonly createdAt: string;
}): Promise<string> => {
  const row = await pool.query<{ id: string }>(
    `insert into artifacts (task_id, type, data, schema_version, created_at)
     values ($1, $2::artifact_type, '{}'::jsonb, '1', $3)
     returning id`,
    [input.taskId, input.type, input.createdAt],
  );
  return row.rows[0]?.id as string;
};

/** A mining chunk of its own batch, with the `HistoryFindings` artifact its run stored. */
const seedMiningRun = async (input: {
  readonly key: string;
  readonly artifactCreatedAt: string;
  readonly recorded?: boolean;
  readonly attemptedAt?: string;
  readonly withArtifact?: boolean;
}): Promise<{
  batchId: string;
  chunkId: string;
  taskId: string;
  projectId: string;
  artifactId: string | null;
}> => {
  const batch = await seedBatch({
    status: 'mining',
    createdAt: LONG_AGO,
    withChunk: false,
    key: input.key,
  });
  // In the **batch's** project, so the payload the pass builds names one project throughout.
  const chunkTaskId = await seedTask(`${input.key.toUpperCase()}-1`, batch.projectId);
  const chunk = await pool.query<{ id: string }>(
    `insert into history_bootstrap_chunks
       (batch_id, chunk_index, task_id, merge_requests, tickets, commits, redaction_count,
        truncated, recorded_at, recovery_attempted_at)
     values ($1, 0, $2, 20, 0, 0, 0, false, $3, $4)
     returning id`,
    [batch.id, chunkTaskId, input.recorded === true ? LONG_AGO : null, input.attemptedAt ?? null],
  );
  const artifactId =
    input.withArtifact === false
      ? null
      : await seedArtifact({
          taskId: chunkTaskId,
          type: 'HistoryFindings',
          createdAt: input.artifactCreatedAt,
        });
  return {
    batchId: batch.id,
    chunkId: chunk.rows[0]?.id as string,
    taskId: chunkTaskId,
    projectId: batch.projectId,
    artifactId,
  };
};

describe('a history bootstrap whose collect job was lost', () => {
  it('is found only when it is old, collecting and has no chunk of its own', async () => {
    // The loss: committed, never collected, and old enough that its own job would have run.
    const stranded = await seedBatch({
      status: 'collecting',
      createdAt: LONG_AGO,
      withChunk: false,
      key: 'lost',
    });
    // In flight: the same shape, a second ago. Re-enqueuing it would race the job it is waiting for.
    await seedBatch({
      status: 'collecting',
      createdAt: IN_FLIGHT,
      withChunk: false,
      key: 'inflight',
    });
    // It ran: the chunks are what `collectHistory` writes for every task it creates.
    await seedBatch({ status: 'mining', createdAt: LONG_AGO, withChunk: true, key: 'mining' });
    // …and a batch that finished with nothing to mine is not stranded either: the status half of
    // the predicate carries weight on its own.
    await seedBatch({
      status: 'empty',
      createdAt: LONG_AGO,
      withChunk: false,
      completed: true,
      key: 'empty',
    });
    // The bound (backlog 105): a batch this pass re-enqueued a moment ago is **invisible**, because
    // its collect job may still be queued. Without this the pass re-enqueued it every minute.
    await seedBatch({
      status: 'collecting',
      createdAt: LONG_AGO,
      withChunk: false,
      attemptedAt: ATTEMPTED_RECENTLY,
      key: 'attempted-recently',
    });

    await withTx(async (tx) => {
      const found = await store.strandedBootstraps(tx, query);
      expect(found.map((row) => row.batchId)).toEqual([stranded.id as Id]);
      expect(found[0]?.projectId).toBe(stranded.projectId);
      expect(found[0]?.recoveryAttemptedAt).toBeNull();
    });
  });

  it('comes back with its mark once, and then with the attempt the pass reads to end it', async () => {
    const batch = await seedBatch({
      status: 'collecting',
      createdAt: LONG_AGO,
      withChunk: false,
      key: 'marked',
    });
    const at = '2026-09-15T08:45:00.000Z' as IsoDateTime;

    await withTx(async (tx) => {
      await store.markBootstrapAttempt(tx, { batchId: batch.id as Id, at });
    });

    await withTx(async (tx) => {
      const found = await store.strandedBootstraps(tx, query);
      const marked = found.find((row) => row.batchId === (batch.id as Id));
      // The mark is what turns the second sighting into an ending rather than a second attempt.
      expect(marked?.recoveryAttemptedAt).toBe(at);
    });
  });

  it('ends a batch whose attempt did not take, and the ending removes it from the query', async () => {
    const batch = await seedBatch({
      status: 'collecting',
      createdAt: LONG_AGO,
      withChunk: false,
      attemptedAt: ATTEMPTED_LONG_AGO,
      key: 'ended',
    });

    await withTx(async (tx) => {
      const found = await store.strandedBootstraps(tx, query);
      expect(found.map((row) => row.batchId)).toContain(batch.id as Id);
      await store.endBootstrap(tx, {
        batchId: batch.id as Id,
        reason: 'its collect job never ran',
        at: OLDER_THAN,
      });
    });

    const [row] = (
      await pool.query<{ status: string; detail: string | null; completed_at: Date | null }>(
        'select status, detail, completed_at from history_bootstrap_batches where id = $1',
        [batch.id],
      )
    ).rows;
    // `markEmpty`'s own write, reached through the feature's store rather than re-spelled here: the
    // batch says why it is over **and** releases `history_bootstrap_batches_one_live`, which is the
    // whole reason this ending exists — the operator can start another bootstrap.
    expect(row?.status).toBe('empty');
    expect(row?.detail).toBe('its collect job never ran');
    expect(row?.completed_at).not.toBeNull();

    await withTx(async (tx) => {
      const found = await store.strandedBootstraps(tx, query);
      expect(found.map((batchRow) => batchRow.batchId)).not.toContain(batch.id as Id);
    });
  });
});

describe('an ask whose run job was lost', () => {
  it('is found only when it is old, still pending and has no run attached', async () => {
    const stranded = await seedAsk({ status: 'pending', createdAt: LONG_AGO });
    // In flight, and already answered: neither is a question nobody will ever pick up.
    await seedAsk({ status: 'pending', createdAt: IN_FLIGHT });
    await seedAsk({ status: 'answered', createdAt: LONG_AGO });
    /**
     * **The measurement this predicate was added for** (backlog 105). `attachRun` fills `run_id` in
     * the transaction that creates the run, and a run takes minutes while the grace is one minute —
     * so without `run_id is null` every ask being answered right now was "stranded", and one left
     * `pending` by a run another writer ended got a **second paid run** on the next pass.
     */
    await seedAsk({ status: 'pending', createdAt: LONG_AGO, runId: await seedRun() });
    // And the bound: an ask this pass re-enqueued a moment ago is invisible until the ending window.
    await seedAsk({
      status: 'pending',
      createdAt: LONG_AGO,
      attemptedAt: ATTEMPTED_RECENTLY,
    });

    await withTx(async (tx) => {
      const found = await store.strandedAsks(tx, query);
      expect(found.map((row) => row.askId)).toEqual([stranded as Id]);
      expect(found[0]).toMatchObject({ taskId, projectId });
      expect(found[0]?.recoveryAttemptedAt).toBeNull();
    });
  });

  it('comes back with its mark, so the next pass ends it instead of paying for another run', async () => {
    const ask = await seedAsk({ status: 'pending', createdAt: LONG_AGO });
    const at = '2026-09-15T08:45:00.000Z' as IsoDateTime;

    await withTx(async (tx) => {
      await store.markAskAttempt(tx, { askId: ask as Id, at });
      const found = await store.strandedAsks(tx, query);
      expect(found.find((row) => row.askId === (ask as Id))?.recoveryAttemptedAt).toBe(at);
    });
  });

  it('ends an ask whose attempt did not take, and the ending removes it from the query', async () => {
    const ask = await seedAsk({
      status: 'pending',
      createdAt: LONG_AGO,
      attemptedAt: ATTEMPTED_LONG_AGO,
    });

    await withTx(async (tx) => {
      expect((await store.strandedAsks(tx, query)).map((row) => row.askId)).toContain(ask as Id);
      await store.endAsk(tx, { askId: ask as Id, reason: 'no run ever started' });
    });

    const [row] = (
      await pool.query<{ status: string; refusal_reason: string | null }>(
        'select status, refusal_reason from task_asks where id = $1',
        [ask],
      )
    ).rows;
    // `recordRefusal`'s own write: `failed` is *"a run that started and produced nothing usable"*
    // rather than `refused`, which is the platform declining before a run exists — and this is the
    // first of the two, because the platform did try.
    expect(row?.status).toBe('failed');
    expect(row?.refusal_reason).toBe('no run ever started');

    await withTx(async (tx) => {
      expect((await store.strandedAsks(tx, query)).map((row2) => row2.askId)).not.toContain(
        ask as Id,
      );
    });
  });
});

/**
 * **PROGRESS backlog 106** — the second lost wake-up of the same feature: a mining run that
 * *reported* and whose findings never became proposals. The chunk is the stuck row and the
 * `HistoryFindings` artifact is the platform's own evidence that the run finished, which is what
 * separates this from a run that is simply still going.
 */
describe('a mining run whose record job was lost', () => {
  it('is found only when the chunk has no report and its artifact is old enough', async () => {
    const stranded = await seedMiningRun({ key: 'rec-lost', artifactCreatedAt: LONG_AGO });
    // Reported: the recorder ran, so there is nothing to recover.
    await seedMiningRun({ key: 'rec-done', artifactCreatedAt: LONG_AGO, recorded: true });
    // In flight: the artifact landed a moment ago and its own job is still coming.
    await seedMiningRun({ key: 'rec-inflight', artifactCreatedAt: IN_FLIGHT });
    // Still running: no artifact at all, which is the ordinary state of a mining run and must not
    // be read as a loss — the wake-up cannot have been lost before it existed.
    await seedMiningRun({ key: 'rec-running', artifactCreatedAt: LONG_AGO, withArtifact: false });
    // The bound (backlog 105): a chunk this pass re-enqueued a moment ago is invisible.
    await seedMiningRun({
      key: 'rec-attempted',
      artifactCreatedAt: LONG_AGO,
      attemptedAt: ATTEMPTED_RECENTLY,
    });

    await withTx(async (tx) => {
      const found = await store.strandedHistoryRecords(tx, query);
      expect(found.map((row) => row.chunkId)).toEqual([stranded.chunkId as Id]);
      expect(found[0]).toMatchObject({
        batchId: stranded.batchId as Id,
        projectId: stranded.projectId as Id,
        taskId: stranded.taskId as Id,
        // The artifact the run stored, which is what the re-enqueued job's payload names — a
        // guess here would be a job the handler answers `skipped` to, which reads like success.
        artifactId: stranded.artifactId as Id,
        recoveryAttemptedAt: null,
      });
    });
  });

  it('comes back with its mark, so the next pass ends it instead of enqueuing again', async () => {
    const run = await seedMiningRun({ key: 'rec-marked', artifactCreatedAt: LONG_AGO });
    const at = '2026-09-15T08:45:00.000Z' as IsoDateTime;

    await withTx(async (tx) => {
      await store.markHistoryRecordAttempt(tx, { chunkId: run.chunkId as Id, at });
      const found = await store.strandedHistoryRecords(tx, query);
      expect(found.find((row) => row.chunkId === (run.chunkId as Id))?.recoveryAttemptedAt).toBe(
        at,
      );
    });
  });

  it('ends the chunk and completes its batch, which is what un-bricks the project', async () => {
    const run = await seedMiningRun({
      key: 'rec-ended',
      artifactCreatedAt: LONG_AGO,
      attemptedAt: ATTEMPTED_LONG_AGO,
    });

    await withTx(async (tx) => {
      expect((await store.strandedHistoryRecords(tx, query)).map((row) => row.chunkId)).toContain(
        run.chunkId as Id,
      );
      await store.endHistoryRecord(tx, {
        chunkId: run.chunkId as Id,
        batchId: run.batchId as Id,
        reason: 'its findings never reached the queue',
        at: OLDER_THAN,
      });
    });

    const [chunk] = (
      await pool.query<{
        abandoned_at: Date | null;
        detail: string | null;
        recorded_at: Date | null;
        proposals: number;
      }>(
        'select abandoned_at, detail, recorded_at, proposals from history_bootstrap_chunks where id = $1',
        [run.chunkId],
      )
    ).rows;
    // Abandoned, **not** recorded: a stamped `recorded_at` would publish `proposals = 0` as a
    // finding rather than as the silence it is (standing rule 18, migration 0036).
    expect(chunk?.abandoned_at).not.toBeNull();
    expect(chunk?.detail).toBe('its findings never reached the queue');
    expect(chunk?.recorded_at).toBeNull();
    expect(chunk?.proposals).toBe(0);

    const [batch] = (
      await pool.query<{ status: string; completed_at: Date | null }>(
        'select status, completed_at from history_bootstrap_batches where id = $1',
        [run.batchId],
      )
    ).rows;
    // The whole point of the ending: `history_bootstrap_batches_one_live` is `unique (project_id)
    // where completed_at is null`, so a batch that never completes is a permanent
    // `already_running` for that project — which is backlog 101's brick, one wake-up later.
    expect(batch?.status).toBe('completed');
    expect(batch?.completed_at).not.toBeNull();

    await withTx(async (tx) => {
      expect(
        (await store.strandedHistoryRecords(tx, query)).map((row) => row.chunkId),
      ).not.toContain(run.chunkId as Id);
    });
  });
});

/**
 * **PROGRESS backlog 36** — the site that needed a mark before it could be a row at all: a curation
 * that ran and proposed nothing writes no `kb_proposals` row, so `knowledge_curations`
 * (migration 0036) is what tells it from one whose wake-up was lost.
 */
describe('an artifact whose curation was lost', () => {
  const curationArtifact = async (input: {
    readonly key: string;
    readonly type?: string;
    readonly createdAt?: string;
    readonly curatedAt?: string;
    readonly attemptedAt?: string;
    readonly abandonedAt?: string;
  }): Promise<string> => {
    const owner = await seedTask(input.key);
    const artifactId = await seedArtifact({
      taskId: owner,
      type: input.type ?? 'LibrarianProposals',
      createdAt: input.createdAt ?? LONG_AGO,
    });
    if (
      input.curatedAt !== undefined ||
      input.attemptedAt !== undefined ||
      input.abandonedAt !== undefined
    ) {
      await pool.query(
        `insert into knowledge_curations
           (artifact_id, curated_at, proposals, recovery_attempted_at, abandoned_at, detail)
         values ($1, $2, 0, $3, $4, $5)`,
        [
          artifactId,
          input.curatedAt ?? null,
          input.attemptedAt ?? null,
          input.abandonedAt ?? null,
          input.abandonedAt === undefined ? null : 'given up on',
        ],
      );
    }
    return artifactId;
  };

  it('is found only when nothing has curated it and it is old enough', async () => {
    const stranded = await curationArtifact({ key: 'CUR-1' });
    // The research page rides the same queue and the same mark, so it is the same site.
    const research = await curationArtifact({ key: 'CUR-2', type: 'ResearchReport' });
    // Curated **with nothing to propose**: the case that made this query impossible before the
    // mark existed, and the one a `kb_proposals`-shaped query would re-run for ever.
    await curationArtifact({ key: 'CUR-3', curatedAt: LONG_AGO });
    // In flight, and an artifact of a type nothing curates.
    await curationArtifact({ key: 'CUR-4', createdAt: IN_FLIGHT });
    await curationArtifact({ key: 'CUR-5', type: 'ImplementationPlan' });
    // The bound, and the ending: neither is offered again.
    await curationArtifact({ key: 'CUR-6', attemptedAt: ATTEMPTED_RECENTLY });
    await curationArtifact({ key: 'CUR-7', abandonedAt: ATTEMPTED_LONG_AGO });

    await withTx(async (tx) => {
      const found = await store.strandedCurations(tx, query);
      expect(found.map((row) => row.artifactId).toSorted()).toEqual(
        [stranded as Id, research as Id].toSorted(),
      );
      // The type is what the job dispatches on: a `ResearchReport` curated as a Librarian artifact
      // would be refused by the schema parse and reported as a skip.
      expect(found.find((row) => row.artifactId === (research as Id))?.artifactType).toBe(
        'ResearchReport',
      );
      expect(found.every((row) => row.projectId === (projectId as Id))).toBe(true);
    });
  });

  it('marks its attempt on a row that did not exist, and reads it back', async () => {
    const artifactId = await curationArtifact({ key: 'CUR-8' });
    const at = '2026-09-15T08:45:00.000Z' as IsoDateTime;

    await withTx(async (tx) => {
      // The mark is an insert here and an update at the other sites: the curation's row does not
      // exist until something writes one, which is exactly what makes its absence readable.
      await store.markCurationAttempt(tx, { artifactId: artifactId as Id, at });
      const found = await store.strandedCurations(tx, query);
      expect(found.find((row) => row.artifactId === (artifactId as Id))?.recoveryAttemptedAt).toBe(
        at,
      );
    });
  });

  it('ends a curation whose attempt did not take, and leaves a curation that arrived alone', async () => {
    const lost = await curationArtifact({ key: 'CUR-9', attemptedAt: ATTEMPTED_LONG_AGO });
    const arrived = await curationArtifact({
      key: 'CUR-10',
      attemptedAt: ATTEMPTED_LONG_AGO,
      curatedAt: OLDER_THAN,
    });

    await withTx(async (tx) => {
      await store.endCuration(tx, {
        artifactId: lost as Id,
        reason: 'its curation never ran',
        at: OLDER_THAN,
      });
      // Both directions (standing rule 42): a curation that landed between the pass's read and
      // this write keeps its row, because `curated_at is null` is in the predicate — labelling it
      // "given up on" would be the platform contradicting a curation that happened.
      await store.endCuration(tx, {
        artifactId: arrived as Id,
        reason: 'its curation never ran',
        at: OLDER_THAN,
      });
    });

    const rows = (
      await pool.query<{ artifact_id: string; abandoned_at: Date | null; detail: string | null }>(
        'select artifact_id, abandoned_at, detail from knowledge_curations where artifact_id = any($1)',
        [[lost, arrived]],
      )
    ).rows;
    expect(rows.find((row) => row.artifact_id === lost)?.detail).toBe('its curation never ran');
    expect(rows.find((row) => row.artifact_id === arrived)?.abandoned_at).toBeNull();

    await withTx(async (tx) => {
      expect((await store.strandedCurations(tx, query)).map((row) => row.artifactId)).not.toContain(
        lost as Id,
      );
    });
  });
});

/**
 * **PROGRESS backlog 121** — not a lost wake-up: a question still `pending` whose run is already
 * over. `strandedAsks` cannot see it by construction (that query is *"pending with no run"*), and
 * nothing else ever moved it.
 */
describe('an ask whose run ended without answering it', () => {
  it('is found only when the run is terminal and ended before the grace', async () => {
    const stranded = await seedAsk({
      status: 'pending',
      createdAt: LONG_AGO,
      runId: await seedRun({ endedAt: LONG_AGO }),
    });
    // A run that is still going: the ask is being answered right now, and ending it here would
    // throw away a run the project is paying for.
    await seedAsk({ status: 'pending', createdAt: LONG_AGO, runId: await seedRun() });
    // A run that ended a moment ago: the executor writes the answer and the run's ending in **one**
    // transaction, so this is a row in flight rather than a stranded one.
    await seedAsk({
      status: 'pending',
      createdAt: LONG_AGO,
      runId: await seedRun({ endedAt: IN_FLIGHT }),
    });
    // An ask that was answered: its run is terminal too, and it is not a question nobody answered.
    await seedAsk({
      status: 'answered',
      createdAt: LONG_AGO,
      runId: await seedRun({ endedAt: LONG_AGO }),
    });
    // …and one with no run at all, which is the **other** row of the table (backlog 84).
    await seedAsk({ status: 'pending', createdAt: LONG_AGO });

    await withTx(async (tx) => {
      const found = await store.asksWithEndedRun(tx, query);
      expect(found.map((row) => row.askId)).toEqual([stranded as Id]);
      // The run's own ending, which the refusal quotes: both are platform enum values.
      expect(found[0]).toMatchObject({
        taskId,
        projectId,
        runStatus: 'failed',
        runTerminalReason: 'lease_expired',
      });
    });
  });

  it('stops being found once the ending has been written', async () => {
    const ask = await seedAsk({
      status: 'pending',
      createdAt: LONG_AGO,
      runId: await seedRun({ endedAt: LONG_AGO }),
    });

    await withTx(async (tx) => {
      await store.endAsk(tx, { askId: ask as Id, reason: 'the run ended without an answer' });
      // The bound is the ask's own state machine rather than a column, which is why this row needs
      // no `recovery_attempted_at`: `recordRefusal` moves it off `pending`.
      expect((await store.asksWithEndedRun(tx, query)).map((row) => row.askId)).not.toContain(
        ask as Id,
      );
    });
  });
});
