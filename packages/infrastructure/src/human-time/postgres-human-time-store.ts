/**
 * `HumanTimeStore` on PostgreSQL — `human_time_entries` (technical/03:88), WP-29.
 *
 * **This module is the only writer of that table**, which is not a claim in prose:
 * `human-time-writers.test.ts` is a census over every file git knows about (tracked and untracked,
 * standing rule 85) for an `insert into human_time_entries` or an `update human_time_entries`, and
 * expects exactly this file. The table has had a schema since migration 0007 and no writer at all
 * until this work package, so "who writes it" is worth pinning on the day it gets one.
 *
 * Every method takes the `Transaction` the application ring passes around and narrows it with
 * `postgresTransaction`, so each row commits with the `handler_executions` claim that says the
 * projector ran (TD-005) — which is what makes the projection exactly-once under a redelivery and
 * under `events/replay.ts` alike, with no unique key doing the work.
 *
 * ## Minutes are a string on the wire
 *
 * `numeric(10,2)` comes back from `pg` as a **string**, because `numeric` holds more than a double.
 * Everything read here goes through one `minutes` helper, and the projector rounds to the two
 * decimals the column holds exactly (`roundMinutes`) — so a value written and read back is the same
 * number, which is what lets a backfill's rows be compared to a live dispatch's for equality.
 */
import type {
  ExternalAccount,
  HumanTimeEntry,
  HumanTimeStore,
  NewHumanTimeEntry,
  Transaction,
} from '@platform/application';
import type { HumanTimeKind, Id, IsoDateTime } from '@platform/contracts';
import { organisationTimezoneOf } from '../cost/postgres-cost-store.js';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

/** Raised when a write that had to change a row changed none. */
export class HumanTimeRowMissingError extends Error {
  override readonly name = 'HumanTimeRowMissingError';
}

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const minutesOf = (value: string | number | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : Number(value);

const iso = (value: Date | string): IsoDateTime => new Date(value).toISOString() as IsoDateTime;

interface EntryRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  kind: HumanTimeKind;
  user_id: string | null;
  external_author: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  minutes: string | null;
}

const toEntry = (row: EntryRow): HumanTimeEntry => ({
  id: row.id as Id,
  taskId: row.task_id as Id,
  kind: row.kind,
  userId: row.user_id as Id | null,
  externalAuthor: row.external_author,
  startedAt: iso(row.started_at),
  endedAt: row.ended_at === null ? null : iso(row.ended_at),
  minutes: minutesOf(row.minutes),
});

export const createPostgresHumanTimeStore = (): HumanTimeStore => ({
  /**
   * The same predicate `TaskRepository.findByMergeRequest` uses — `(mr_ref ->> 'iid')::int` — and
   * the same tie-break, newest task first, so the projector and the saga can never disagree about
   * which task a merge request belongs to (standing rule 9).
   */
  taskForMergeRequest: async (tx, subject) => {
    const { rows } = await sqlOf(tx).query<{ id: string }>(
      `select id from tasks
        where project_id = $1 and (mr_ref ->> 'iid')::int = $2
        order by created_at desc limit 1`,
      [subject.projectId, subject.iid],
    );
    return (rows[0]?.id as Id | undefined) ?? null;
  },

  /**
   * One primary-key read. A row with `kind = 'machine'` carries no `user_id` by the table's own
   * check (migration 0045), so the answer is decided by `kind` and never by a `null` alone — a
   * `null` read as "unmapped" would record a declared bot's minutes under its account.
   */
  resolveAccount: async (tx: Transaction, account: ExternalAccount) => {
    const { rows } = await sqlOf(tx).query<{ user_id: string | null; kind: string }>(
      'select user_id, kind from user_identities where provider = $1 and external_id = $2',
      [account.provider, account.externalId],
    );
    const row = rows[0];
    if (row === undefined) {
      return { kind: 'unmapped' as const };
    }
    if (row.kind === 'machine' || row.user_id === null) {
      return { kind: 'machine' as const };
    }
    return { kind: 'person' as const, userId: row.user_id as Id };
  },

  reviewEntries: async (tx, taskId) => {
    const { rows } = await sqlOf(tx).query<EntryRow>(
      `select id, task_id, kind, user_id, external_author, started_at, ended_at, minutes
         from human_time_entries
        where task_id = $1 and kind = 'review'
        order by started_at desc, id desc`,
      [taskId],
    );
    return rows.map(toEntry);
  },

  appendEntry: async (tx, entry: NewHumanTimeEntry) => {
    await sqlOf(tx).query(
      `insert into human_time_entries
         (task_id, kind, user_id, external_author, started_at, ended_at, minutes)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.taskId,
        entry.kind,
        entry.userId,
        entry.externalAuthor,
        entry.startedAt,
        entry.endedAt,
        entry.minutes,
      ],
    );
  },

  extendEntry: async (tx, id, window) => {
    const result = await sqlOf(tx).query(
      'update human_time_entries set ended_at = $2, minutes = $3 where id = $1',
      [id, window.endedAt, window.minutes],
    );
    if (result.rowCount === 0) {
      throw new HumanTimeRowMissingError(
        `human_time_entries ${id} does not exist; the review window cannot be extended`,
      );
    }
  },

  questionAskedAt: async (tx, questionId) => {
    const { rows } = await sqlOf(tx).query<{ asked_at: Date | string }>(
      'select asked_at from questions where id = $1',
      [questionId],
    );
    const askedAt = rows[0]?.asked_at;
    return askedAt === undefined ? null : iso(askedAt);
  },

  /**
   * One statement, shared with `CostStore` rather than copied (standing rule 9): the review
   * window's *"per calendar day"* cap and the cost rollup's `day` must agree about when the day
   * turned, and two spellings of one query is how they stop agreeing.
   */
  organisationTimezone: async (tx, projectId) => organisationTimezoneOf(sqlOf(tx), projectId),
});
