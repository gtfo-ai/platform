/**
 * `run_commands` on PostgreSQL (migrations 0060 and 0064; WP-85 and WP-101, TD-028 decisions 9
 * and 11).
 *
 * The port's docblock (`RunCommandRepository`) carries the ordering argument; this file is where
 * the four locks it relies on are written down as SQL:
 *
 * - **`lockRun` / `lockLiveRunOf` take `for share` on the run** — `for update` when a cancel asks,
 *   because a cancel may go on to `finish` the row it read. The command inserts its row only
 *   after reading the run live under that lock, in the same transaction. `runs.finish` needs the
 *   row exclusively, so it waits for a command that holds the lock and — its close being a later
 *   statement with a later snapshot — then sees and closes the committed row; or the command waits
 *   for the ending and reads the run terminal.
 * - **`markApplied` takes the same lock** before its conditional `update`, so the holder's stamp is
 *   ordered against the ending the same way: it waits for an ending in progress and then finds the
 *   run terminal (the ending closed the row), or the ending waits for the stamp.
 * - **`closePendingRunCommands` runs inside `finish`**, after the `update runs`, and only for the
 *   caller that won it.
 * - **`admitSteer` takes a transaction-scoped advisory lock on the user** before any row lock, and
 *   reads the user's `steer` rows inside the window; the caller inserts the row it admitted in the
 *   same transaction, so the next steer by that user — through any process — waits for the commit
 *   and reads it (WP-101, PROGRESS backlog 295).
 *
 * `payload` is read back through a schema: it is stored state, and a row a future build wrote in a
 * shape this one does not know is refused by name rather than delivered as a guess.
 */
import type {
  LockedRun,
  NewRunCommand,
  PendingRunCommand,
  RunCommandInstruction,
  RunCommandRepository,
  Transaction,
} from '@platform/application';
import { STOPPING_RUN_COMMAND_KINDS } from '@platform/application';
import type { Id, IsoDateTime, RunStatus } from '@platform/contracts';
import { ACTIVE_RUN_STATUSES } from '@platform/domain';
import * as z from 'zod';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

/** Raised when a stored command's payload is not a shape this build can deliver. */
export class RunCommandPayloadError extends Error {
  override readonly name = 'RunCommandPayloadError';
}

const steerPayloadSchema = z.strictObject({
  text: z.string(),
  author_user_id: z.uuid(),
  author_label: z.string(),
});

const takeOverPayloadSchema = z.strictObject({
  branch: z.string().min(1),
  commit_message: z.string().min(1),
  tarball: z.boolean(),
  keep_until: z.iso.datetime({ offset: true }),
});

/** A cancel's stop carries nothing but its kind (migration 0064, WP-101). */
const cancelPayloadSchema = z.strictObject({});

/** The instruction as the `payload` column stores it — the wire format is snake_case. */
export const encodeRunCommandPayload = (
  instruction: RunCommandInstruction,
): Record<string, unknown> => {
  switch (instruction.kind) {
    case 'steer':
      return {
        text: instruction.text,
        author_user_id: instruction.authorUserId,
        author_label: instruction.authorLabel,
      };
    case 'take_over':
      return {
        branch: instruction.branch,
        commit_message: instruction.commitMessage,
        tarball: instruction.tarball,
        keep_until: instruction.keepUntil,
      };
    case 'cancel':
      return {};
  }
};

export const decodeRunCommandPayload = (
  id: string,
  kind: string,
  payload: unknown,
): RunCommandInstruction => {
  if (kind === 'steer') {
    const parsed = steerPayloadSchema.safeParse(payload);
    if (parsed.success) {
      return {
        kind: 'steer',
        text: parsed.data.text,
        authorUserId: parsed.data.author_user_id as Id,
        authorLabel: parsed.data.author_label,
      };
    }
  } else if (kind === 'take_over') {
    const parsed = takeOverPayloadSchema.safeParse(payload);
    if (parsed.success) {
      return {
        kind: 'take_over',
        branch: parsed.data.branch,
        commitMessage: parsed.data.commit_message,
        tarball: parsed.data.tarball,
        keepUntil: parsed.data.keep_until as IsoDateTime,
      };
    }
  } else if (kind === 'cancel') {
    if (cancelPayloadSchema.safeParse(payload).success) {
      return { kind: 'cancel' };
    }
  }
  throw new RunCommandPayloadError(
    `run command ${id} of kind "${kind}" has a payload this build cannot deliver`,
  );
};

const tryDecode = (id: string, kind: string, payload: unknown): RunCommandInstruction | null => {
  try {
    return decodeRunCommandPayload(id, kind, payload);
  } catch (error) {
    if (error instanceof RunCommandPayloadError) {
      return null;
    }
    throw error;
  }
};

type LockedRow = {
  id: string;
  task_id: string;
  status: RunStatus;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  session_id: string | null;
};

const lockedOf = (row: LockedRow): LockedRun => ({
  runId: row.id as Id,
  taskId: row.task_id as Id,
  status: row.status,
  leaseOwner: row.lease_owner,
  leaseExpiresAt:
    row.lease_expires_at === null
      ? null
      : (new Date(row.lease_expires_at).toISOString() as IsoDateTime),
  sessionId: row.session_id === '' ? null : row.session_id,
});

/**
 * The session a run is in, off its own `system`/`init` transcript entry — the first place the
 * database learns it (`runs.session_id` waits for the run's end). A correlated subquery rather than
 * a join, so the `for share` lock stays on `runs` alone.
 */
const SESSION_OF_RUN = `coalesce(r.session_id, (
    select m.payload ->> 'session_id' from run_messages m
     where m.run_id = r.id and m.kind = 'system' and m.subtype = 'init'
     order by m.seq limit 1)) as session_id`;

const ACTIVE = [...ACTIVE_RUN_STATUSES];

/**
 * Closes every pending command of a run `run_ended` — the run's own ending does this, in its
 * transaction, after the `update runs` it won (`RunRepository.finish`).
 */
export const closePendingRunCommands = async (sql: SqlExecutor, runId: string): Promise<void> => {
  await sql.query(
    `update run_commands
        set refused_at = now(), refused_reason = 'run_ended'
      where run_id = $1 and applied_at is null and refused_at is null`,
    [runId],
  );
};

export const createPostgresRunCommandRepository = (): RunCommandRepository => ({
  lockRun: async (tx, runId, options) => {
    // `for update` for a cancel, which may go on to `finish` the row (WP-101): two share locks
    // upgraded at once deadlock where one exclusive lock makes the second cancel wait and refuse.
    const strength = options?.forUpdate === true ? 'update' : 'share';
    const { rows } = await sqlOf(tx).query<LockedRow>(
      `select r.id, r.task_id, r.status, r.lease_owner, r.lease_expires_at, ${SESSION_OF_RUN}
         from runs r where r.id = $1 for ${strength} of r`,
      [runId],
    );
    const row = rows[0];
    return row === undefined ? null : lockedOf(row);
  },
  lockLiveRunOf: async (tx, taskId) => {
    // Newest first: technical/02 allows a task one active run, so more than one row here is a
    // defect elsewhere — and the newest is the one a person looking at the task is looking at.
    const { rows } = await sqlOf(tx).query<LockedRow>(
      `select r.id, r.task_id, r.status, r.lease_owner, r.lease_expires_at, ${SESSION_OF_RUN}
         from runs r
        where r.task_id = $1 and r.status = any($2::run_status[])
        order by r.created_at desc, r.id desc
        limit 1
        for share of r`,
      [taskId, ACTIVE],
    );
    const row = rows[0];
    return row === undefined ? null : lockedOf(row);
  },
  insert: async (tx, command: NewRunCommand) => {
    await sqlOf(tx).query(
      `insert into run_commands (id, run_id, task_id, kind, payload, actor_user_id)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        command.id,
        command.runId,
        command.taskId,
        command.instruction.kind,
        JSON.stringify(encodeRunCommandPayload(command.instruction)),
        command.actorUserId,
      ],
    );
  },
  pending: async (tx, query) => {
    const { rows } = await sqlOf(tx).query<{
      id: string;
      run_id: string;
      task_id: string;
      kind: string;
      payload: unknown;
      actor_user_id: string | null;
    }>(
      `select c.id, c.run_id, c.task_id, c.kind, c.payload, c.actor_user_id
         from run_commands c
         join runs r on r.id = c.run_id
        where c.applied_at is null and c.refused_at is null
          and r.status = any($2::run_status[])
          and r.lease_owner = $1
          and ($3::uuid is null or c.run_id = $3::uuid)
          -- A steer behind a stop that was not refused waits for the run's ending (WP-101).
          and not (c.kind = 'steer' and exists (
                select 1 from run_commands s
                 where s.run_id = c.run_id and s.kind = any($5::text[]) and s.refused_at is null))
        order by c.created_at, c.id
        limit $4`,
      [query.owner, ACTIVE, query.runId ?? null, query.limit, [...STOPPING_RUN_COMMAND_KINDS]],
    );
    return rows.map(
      (row): PendingRunCommand => ({
        id: row.id as Id,
        runId: row.run_id as Id,
        taskId: row.task_id as Id,
        actorUserId: row.actor_user_id as Id | null,
        // One unreadable row must not fail the drain of every other (review round 1): it is handed
        // back without an instruction and the holder refuses it `undecodable` by itself.
        instruction: tryDecode(row.id, row.kind, row.payload),
        kind: row.kind,
      }),
    );
  },
  markApplied: async (tx, input) => {
    const sql = sqlOf(tx);
    const { rows } = await sql.query<{ id: string }>(
      `select r.id from runs r
        where r.id = (select run_id from run_commands where id = $1)
          and r.status = any($3::run_status[])
          and r.lease_owner = $2
        for share of r`,
      [input.id, input.owner, ACTIVE],
    );
    if (rows.length === 0) {
      return false;
    }
    const result = await sql.query(
      `update run_commands set applied_at = now()
        where id = $1 and applied_at is null and refused_at is null`,
      [input.id],
    );
    return result.rowCount !== 0;
  },
  markDeliveryFailed: async (tx, input) => {
    const result = await sqlOf(tx).query(
      `update run_commands
          set applied_at = null, refused_at = now(), refused_reason = 'delivery_failed'
        where id = $1 and applied_at is not null`,
      [input.id],
    );
    return result.rowCount !== 0;
  },
  markRefused: async (tx, input) => {
    const result = await sqlOf(tx).query(
      `update run_commands set refused_at = now(), refused_reason = $2
        where id = $1 and applied_at is null and refused_at is null`,
      [input.id, input.reason],
    );
    return result.rowCount !== 0;
  },
  admitSteer: async (tx, input) => {
    const sql = sqlOf(tx);
    // Held to the end of the caller's transaction, which inserts the row it admits: the next steer
    // by this user, through any process, waits here and then reads that row (WP-101, backlog 295).
    await sql.query(`select pg_advisory_xact_lock(hashtextextended('steer_window/' || $1, 0))`, [
      input.userId,
    ]);
    const { rows } = await sql.query<{ recent: boolean }>(
      `select exists (
         select 1 from run_commands
          where kind = 'steer' and actor_user_id = $1
            and created_at > now() - make_interval(secs => $2::double precision / 1000)
       ) as recent`,
      [input.userId, input.windowMs],
    );
    return rows[0]?.recent !== true;
  },
});
