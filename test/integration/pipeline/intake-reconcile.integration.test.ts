/**
 * The query behind PROGRESS backlog **20**, against a real PostgreSQL 18 — WP-15c.
 *
 * The pass itself is unit-tested against a store double; the store *is* the interesting part, and
 * it is SQL over the partitioned event log joined against `tasks`. Five predicates, each of which
 * fails a different way if it is wrong:
 *
 *  - **no task row** for `(project, provider, key, mode = 'normal')` — the tuple
 *    `tasks_project_id_ticket_key_mode` is unique on and `saga.ts`'s `findByTicket` reads;
 *  - **older than the grace period**, so a match whose `intake_check` job is still in flight is not
 *    raced;
 *  - **not already re-emitted** by this component, which bounds the recovery to one attempt per
 *    ticket and is what stops an event log growing behind a permanently failing intake;
 *  - **one row per ticket**, because a ticket legitimately matches more than once (a poll that
 *    overlapped a webhook) and two rows would enqueue two doomed intakes;
 *  - **the latest match not answered by a skip** (backlog 542): a `ticket.intake.skipped` whose
 *    `cause_event_id` is that match is intake's answer, not a lost wake-up.
 */
import { randomUUID } from 'node:crypto';
import {
  INTAKE_RECONCILER_COMPONENT,
  runIntakeReconciliation,
  type UnstartedMatch,
} from '@platform/application';
import type { Actor, Id, IsoDateTime } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  pipeline as pipelineAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let projectId: Id;

const RECONCILER_ACTOR: Actor = { kind: 'system', component: INTAKE_RECONCILER_COMPONENT };
const PROVIDER_ACTOR = (integrationId: Id): Actor => ({
  kind: 'integration',
  integration_id: integrationId,
  provider: 'jira-cloud',
});

let integrationId: Id;
let streamSeq = 0;

const appendMatch = async (options: {
  readonly key: string;
  readonly actor?: Actor;
  readonly minutesAgo?: number;
  /** The provider's stable id, as the Jira adapter sends it since WP-134. */
  readonly ticketId?: string;
}): Promise<string> => {
  streamSeq += 1;
  const id = randomUUID();
  const occurredAt = new Date(Date.now() - (options.minutesAgo ?? 30) * 60_000).toISOString();
  await pool.query(
    `insert into events (id, stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
       values ($1, 'project', $2, $3, 'ticket.matched', $4::jsonb, $5::jsonb, $6::timestamptz)`,
    [
      id,
      projectId,
      streamSeq,
      JSON.stringify({
        project_id: projectId,
        ticket: {
          provider: 'jira-cloud',
          key: options.key,
          url: `https://acme.atlassian.net/browse/${options.key}`,
          ...(options.ticketId === undefined ? {} : { id: options.ticketId }),
        },
        rule: 'label = "agentic"',
        priority: null,
        issue_type: 'Story',
        epic: null,
        links: [],
      }),
      JSON.stringify(options.actor ?? PROVIDER_ACTOR(integrationId)),
      occurredAt,
    ],
  );
  return id;
};

/** What `saga.ts`'s `recordIntakeSkip` appends: the skip, caused by the match intake read. */
const appendSkip = async (options: {
  readonly key: string;
  readonly causeEventId: string;
  readonly minutesAgo?: number;
}): Promise<void> => {
  streamSeq += 1;
  const occurredAt = new Date(Date.now() - (options.minutesAgo ?? 29) * 60_000).toISOString();
  await pool.query(
    `insert into events (id, stream_type, stream_id, stream_seq, type, payload, actor, occurred_at,
                         cause_event_id)
       values ($1, 'project', $2, $3, 'ticket.intake.skipped', $4::jsonb, $5::jsonb,
               $6::timestamptz, $7)`,
    [
      randomUUID(),
      projectId,
      streamSeq,
      JSON.stringify({
        project_id: projectId,
        ticket: {
          provider: 'jira-cloud',
          key: options.key,
          url: `https://acme.atlassian.net/browse/${options.key}`,
        },
        reason: 'assigned',
      }),
      JSON.stringify({ kind: 'system', component: 'pipeline' }),
      occurredAt,
      options.causeEventId,
    ],
  );
};

const insertTask = async (key: string, mode = 'normal', ticketId: string | null = null) => {
  await pool.query(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state, mode,
                        ticket_id)
       values ($1, 'jira-cloud', $2, $3, 'feature', 'queued', $4::task_mode, $5)`,
    [projectId, key, `https://acme.atlassian.net/browse/${key}`, mode, ticketId],
  );
};

const store = () => pipelineAdapters.createPostgresIntakeReconciliationStore({ sql: pool });

/** The key of a match, without an optional chain the type system cannot vouch for. */
const ticketKeyOf = (match: UnstartedMatch | undefined): string => {
  if (match === undefined) {
    throw new Error('no match was found');
  }
  return (match.payload.ticket as { key: string }).key;
};

const find = async (graceMinutes = 5): Promise<readonly UnstartedMatch[]> =>
  store().findUnstartedMatches({
    olderThan: new Date(Date.now() - graceMinutes * 60_000).toISOString() as IsoDateTime,
    limit: 50,
    reconcilerComponent: INTAKE_RECONCILER_COMPONENT,
  });

beforeAll(async () => {
  database = await createMigratedDatabase('intake-reconcile');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('reconcile') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://gitlab.example.test/acme/api.git') returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as Id;
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name)
       values ($1, 'task_management'::integration_type, 'jira-cloud', 'acme jira') returning id`,
    [orgId],
  );
  integrationId = integration.rows[0]?.id as Id;
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query('truncate events, event_dispatch, event_streams, tasks cascade');
  streamSeq = 0;
});

describe('finding the tickets nothing started', () => {
  it('reports a matched ticket with no task row', async () => {
    const lost = await appendMatch({ key: 'ACME-1' });

    const found = await find();

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ eventId: lost, projectId });
    expect(ticketKeyOf(found[0])).toBe('ACME-1');
  });

  it('reports nothing once the task exists — which is the normal case and must stay silent', async () => {
    await appendMatch({ key: 'ACME-1' });
    await insertTask('ACME-1');

    expect(await find()).toEqual([]);
  });

  /**
   * `saga.ts`'s `findByTicket` reads `mode: 'normal'`, so a **shadow** task is not the task the
   * platform owes for a match. A predicate that ignored `mode` would silently stop recovering a
   * ticket the moment somebody shadow-ran it.
   */
  it('still reports a ticket whose only task is a shadow run', async () => {
    await appendMatch({ key: 'ACME-1' });
    await insertTask('ACME-1', 'shadow');

    expect(await find()).toHaveLength(1);
  });

  it('leaves a match younger than the grace period alone, because its intake job is still in flight', async () => {
    await appendMatch({ key: 'ACME-1', minutesAgo: 1 });

    expect(await find(5)).toEqual([]);
    // And finds it once the window has passed, so the bound is a delay and not a refusal.
    expect(await find(0)).toHaveLength(1);
  });

  it('reports one row per ticket, however many times it matched', async () => {
    await appendMatch({ key: 'ACME-1' });
    await appendMatch({ key: 'ACME-1' });
    await appendMatch({ key: 'ACME-1' });

    expect(await find()).toHaveLength(1);
  });

  /**
   * WP-134 (backlog 418): intake drops a match for a moved issue — `NEW-5`, the id of the task
   * `OLD-1` started — as that task's. Read by key alone, the reconciler would call the dropped match
   * lost and re-emit it; by the id it is the task it already has. And a different id under the new
   * key is still owed a task.
   */
  it('reports nothing for a moved issue whose task exists under its old key (WP-134)', async () => {
    await appendMatch({ key: 'NEW-5', ticketId: '10001' });
    await appendMatch({ key: 'NEW-6', ticketId: '10002' });
    await insertTask('OLD-1', 'normal', '10001');

    const found = await find();
    expect(found.map(ticketKeyOf)).toEqual(['NEW-6']);
  });

  it('keeps two different tickets apart', async () => {
    await appendMatch({ key: 'ACME-1' });
    await appendMatch({ key: 'ACME-2' });
    await insertTask('ACME-2');

    const found = await find();
    expect(found).toHaveLength(1);
    expect(ticketKeyOf(found[0])).toBe('ACME-1');
  });
});

/**
 * Backlog 542: since WP-177 a matched ticket with no task row is not always a lost wake-up — intake
 * may have read it, found it assigned to somebody else and recorded `ticket.intake.skipped`, caused
 * by that match. The skip answers **that** match and no other.
 */
describe('a match intake skipped (backlog 542)', () => {
  it('does not report a match whose intake recorded a skip caused by it', async () => {
    const match = await appendMatch({ key: 'ACME-1', minutesAgo: 30 });
    await appendSkip({ key: 'ACME-1', causeEventId: match, minutesAgo: 29 });

    expect(await find(), 'the skip is intake answering, not a wake-up lost').toEqual([]);
  });

  it('still reports a later match of a skipped ticket whose wake-up was lost', async () => {
    const skipped = await appendMatch({ key: 'ACME-1', minutesAgo: 30 });
    await appendSkip({ key: 'ACME-1', causeEventId: skipped, minutesAgo: 29 });
    const lost = await appendMatch({ key: 'ACME-1', minutesAgo: 20 });

    const found = await find();
    expect(found, 'the skip names the first match, not the ticket').toHaveLength(1);
    expect(found[0]).toMatchObject({ eventId: lost, projectId });
  });

  it('does not reach behind a skipped latest match to an older one', async () => {
    await appendMatch({ key: 'ACME-1', minutesAgo: 30 });
    const latest = await appendMatch({ key: 'ACME-1', minutesAgo: 20 });
    await appendSkip({ key: 'ACME-1', causeEventId: latest, minutesAgo: 19 });

    expect(
      await find(),
      "intake answered the ticket's newest announcement; re-emitting an older one reads it again",
    ).toEqual([]);
  });

  it('keeps a skip of one ticket from hiding another', async () => {
    const skipped = await appendMatch({ key: 'ACME-1' });
    await appendSkip({ key: 'ACME-1', causeEventId: skipped });
    await appendMatch({ key: 'ACME-2' });

    expect((await find()).map(ticketKeyOf)).toEqual(['ACME-2']);
  });
});

describe('the bound on re-emission', () => {
  it('stops after one attempt per ticket, so a permanently failing intake cannot grow the log', async () => {
    await appendMatch({ key: 'ACME-1' });
    // What a pass appends: the same payload with this component's system actor.
    await appendMatch({ key: 'ACME-1', actor: RECONCILER_ACTOR });

    expect(
      await find(),
      'the mark the pass leaves is what the next pass reads; the task is still missing',
    ).toEqual([]);
  });

  it('re-emits exactly once when the pass runs twice, end to end', async () => {
    await appendMatch({ key: 'ACME-1' });
    const options = {
      store: store(),
      unitOfWork: eventing.unitOfWork,
      eventStore: eventing.store,
      ids: { next: () => randomUUID() as Id },
      clock: { now: () => new Date().toISOString() as IsoDateTime },
      graceMs: 60_000,
    };

    const first = await runIntakeReconciliation(options);
    const second = await runIntakeReconciliation(options);

    expect(first).toEqual({ found: 1, reEmitted: 1, contended: 0 });
    expect(second, 'the second pass sees its own mark').toEqual({
      found: 0,
      reEmitted: 0,
      contended: 0,
    });
    const { rows } = await pool.query<{ count: number }>(
      "select count(*)::int as count from events where type = 'ticket.matched'",
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('appends the re-emission on the project stream, with the right next sequence', async () => {
    await appendMatch({ key: 'ACME-1' });

    await runIntakeReconciliation({
      store: store(),
      unitOfWork: eventing.unitOfWork,
      eventStore: eventing.store,
      ids: { next: () => randomUUID() as Id },
      clock: { now: () => new Date().toISOString() as IsoDateTime },
      graceMs: 60_000,
    });

    const { rows } = await pool.query<{
      stream_type: string;
      stream_id: string;
      stream_seq: number;
      actor: Actor;
    }>('select stream_type, stream_id, stream_seq, actor from events order by position');
    expect(rows).toHaveLength(2);
    // The trigger in migration 0005 enforces `last + 1`; a re-emission that guessed would be a
    // `StreamConflictError` rather than a silently mis-ordered stream.
    expect(rows[1]).toMatchObject({ stream_type: 'project', stream_id: projectId, stream_seq: 2 });
    expect(rows[1]?.actor).toEqual(RECONCILER_ACTOR);
  });
});
