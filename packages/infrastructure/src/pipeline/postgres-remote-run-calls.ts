/**
 * `RemoteRunCallStore` on PostgreSQL (WP-282) — what a remote run's calls to the core write:
 * `run_messages` (TD-031 §10a), `run_tool_calls`, `run_tool_approvals`, `run_session_lines`
 * (migration 0098) and `run_offers.ssh_signatures` (migration 0094, TD-031's 2026-11-04 amendment).
 *
 * ## `(run_id, seq)` on a table whose key is `(run_id, seq, created_at)`
 *
 * `run_messages` is partitioned by `created_at`, so its primary key must carry it and `on conflict do
 * nothing` would absorb a repeat only when the repeat names the same instant. A worker's retry does;
 * a tampered worker need not. So the ingest takes a transaction-scoped advisory lock on the run and
 * inserts only a `seq` the run does not have yet — one row per `(run_id, seq)` whatever `created_at`
 * a repeat names, which is TD-031 §9's key.
 *
 * ## The signature count is the fence
 *
 * `countSignature` is **one statement**: `ssh_signatures + 1` on the run's offer where the offer is
 * `claimed`, at the presented epoch, by this worker, and under the cap. Every terminal writer closes
 * the offer in the run's terminal transaction (TD-031 §12), so a sign racing the run's ending either
 * commits first or finds the offer `settled` when its row lock is granted (PostgreSQL re-reads the
 * row it waited for) — never a signature after the terminal write. The count is per run, in the
 * database, so two API replicas share one cap.
 */
import type {
  DecidedApproval,
  RemoteRunCallStore,
  StoredToolCall,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, JsonValue } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { runMessageRowFor } from '../runner/postgres-transcript-sink.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const iso = (value: Date | string): IsoDateTime =>
  (value instanceof Date ? value : new Date(value)).toISOString() as IsoDateTime;

export const createPostgresRemoteRunCallStore = (): RemoteRunCallStore => ({
  appendTranscript: async (tx, runId, entries) => {
    const sql = sqlOf(tx);
    // One ingest of a run at a time, so the `not exists` below is a decision nobody else is making.
    await sql.query(`select pg_advisory_xact_lock(hashtextextended('run_messages:' || $1, 0))`, [
      runId,
    ]);
    let stored = 0;
    for (const entry of entries) {
      const row = runMessageRowFor(entry);
      const { rowCount } = await sql.query(
        `insert into run_messages
           (run_id, seq, created_at, kind, subtype, parent_tool_use_id, tool_use_id, tool_name,
            payload, search_text, size_bytes, redaction_count)
         select $1, $2, $3::timestamptz, $4::transcript_kind, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
          where not exists (select 1 from run_messages where run_id = $1 and seq = $2)`,
        [
          row.runId,
          row.seq,
          row.createdAt,
          row.kind,
          row.subtype,
          row.parentToolUseId,
          row.toolUseId,
          row.toolName,
          row.payload,
          row.searchText,
          row.sizeBytes,
          row.redactionCount,
        ],
      );
      stored += rowCount ?? 0;
    }
    return stored;
  },

  findToolCall: async (tx, runId, toolUseDigest) => {
    const { rows } = await sqlOf(tx).query<{
      tool_name: string;
      input_digest: string;
      claimed_at: Date;
      completed_at: Date | null;
      result: JsonValue | null;
      is_error: boolean | null;
    }>(
      `select tool_name, input_digest, claimed_at, completed_at, result, is_error
         from run_tool_calls
        where run_id = $1 and tool_use_digest = $2`,
      [runId, toolUseDigest],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const call: StoredToolCall = {
      toolName: row.tool_name,
      inputDigest: row.input_digest,
      claimedAt: iso(row.claimed_at),
      answer:
        row.completed_at === null
          ? null
          : { result: row.result ?? null, isError: row.is_error === true },
    };
    return call;
  },

  claimToolCall: async (tx, input) => {
    const { rowCount } = await sqlOf(tx).query(
      `insert into run_tool_calls
         (run_id, tool_use_digest, tool_name, input_digest, lease_epoch, claimed_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz)
       on conflict (run_id, tool_use_digest) do update
          set claimed_at = excluded.claimed_at, lease_epoch = excluded.lease_epoch
        where run_tool_calls.completed_at is null
          and $7::timestamptz is not null
          and run_tool_calls.claimed_at < $7::timestamptz
          and run_tool_calls.tool_name = excluded.tool_name
          and run_tool_calls.input_digest = excluded.input_digest`,
      [
        input.runId,
        input.toolUseDigest,
        input.toolName,
        input.inputDigest,
        input.epoch,
        input.at,
        input.takeOverBefore,
      ],
    );
    return (rowCount ?? 0) > 0;
  },

  completeToolCall: async (tx, input) => {
    await sqlOf(tx).query(
      `update run_tool_calls
          set completed_at = $3::timestamptz, result = $4::jsonb, is_error = $5,
              redaction_count = $6
        where run_id = $1 and tool_use_digest = $2 and completed_at is null`,
      [
        input.runId,
        input.toolUseDigest,
        input.at,
        JSON.stringify(input.result),
        input.isError,
        input.redactionCount,
      ],
    );
  },

  releaseToolCall: async (tx, input) => {
    await sqlOf(tx).query(
      `delete from run_tool_calls
        where run_id = $1 and tool_use_digest = $2 and completed_at is null`,
      [input.runId, input.toolUseDigest],
    );
  },

  openApproval: async (tx, input) => {
    const sql = sqlOf(tx);
    const { rows } = await sql.query<{ id: string }>(
      `insert into run_tool_approvals (id, run_id, tool_use_digest, tool_name, lease_epoch, requested_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz)
       on conflict (run_id, tool_use_digest) do nothing
       returning id`,
      [input.id, input.runId, input.toolUseDigest, input.toolName, input.epoch, input.at],
    );
    if (rows[0] !== undefined) {
      return { id: rows[0].id as Id, created: true };
    }
    const existing = await sql.query<{ id: string }>(
      'select id from run_tool_approvals where run_id = $1 and tool_use_digest = $2',
      [input.runId, input.toolUseDigest],
    );
    const id = existing.rows[0]?.id;
    if (id === undefined) {
      throw new Error(
        `approval for run ${input.runId} conflicted and then was not found in one transaction`,
      );
    }
    return { id: id as Id, created: false };
  },

  decideApproval: async (tx, input) => {
    await sqlOf(tx).query(
      `update run_tool_approvals
          set decision = $2, reason = $3, question_id = $4, decided_at = $5::timestamptz
        where id = $1 and decided_at is null`,
      [input.id, input.decision, input.reason.slice(0, 4_096), input.questionId, input.at],
    );
  },

  takeDecidedApprovals: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{
      id: string;
      decision: 'allow' | 'deny';
      reason: string;
      question_id: string | null;
    }>(
      `with taken as (
         select id from run_tool_approvals
          where run_id = $1 and decided_at is not null and delivered_at is null
          order by decided_at, id
          limit $3
          for update skip locked
       )
       update run_tool_approvals a
          set delivered_at = $2::timestamptz
         from taken
        where a.id = taken.id
       returning a.id, a.decision, a.reason, a.question_id`,
      [input.runId, input.at, input.limit],
    );
    return rows.map(
      (row): DecidedApproval => ({
        approvalId: row.id as Id,
        decision: row.decision,
        reason: row.reason,
        questionId: row.question_id as Id | null,
      }),
    );
  },

  lockSessionMirror: async (tx, runId) => {
    await sqlOf(tx).query(
      `select pg_advisory_xact_lock(hashtextextended('run_session_lines:' || $1, 0))`,
      [runId],
    );
  },

  sessionLineCount: async (tx, runId) => {
    const { rows } = await sqlOf(tx).query<{ count: string }>(
      'select count(*)::text as count from run_session_lines where run_id = $1',
      [runId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  appendSessionLines: async (tx, input) => {
    if (input.lines.length === 0) return 0;
    const { rowCount } = await sqlOf(tx).query(
      `insert into run_session_lines (run_id, session_id, line_no, line, redaction_count)
       select $1, $2, $3::integer + (entry.ordinality - 1)::integer, entry.line, counts.redaction_count
         from unnest($4::text[]) with ordinality as entry(line, ordinality)
         join unnest($5::integer[]) with ordinality as counts(redaction_count, ordinality)
           on counts.ordinality = entry.ordinality
       on conflict (run_id, session_id, line_no) do nothing`,
      [
        input.runId,
        input.sessionId,
        input.fromLine,
        input.lines.map((line) => line.text),
        input.lines.map((line) => line.redactionCount),
      ],
    );
    return rowCount ?? 0;
  },

  countSignature: async (tx, input) => {
    const sql = sqlOf(tx);
    const owner = `worker:${input.workerId}`;
    const { rows } = await sql.query<{ ssh_signatures: number }>(
      `update run_offers o
          set ssh_signatures = o.ssh_signatures + 1
         from runs r
        where o.run_id = $1
          and r.id = o.run_id
          and o.state = 'claimed'
          and o.lease_epoch = $2
          and o.worker_id = $3
          and r.lease_epoch = $2
          and r.lease_owner = $4
          and o.ssh_signatures < $5
       returning o.ssh_signatures`,
      [input.runId, input.epoch, input.workerId, owner, input.max],
    );
    const counted = rows[0];
    if (counted !== undefined) {
      return { kind: 'counted', signatures: counted.ssh_signatures };
    }
    // Nothing counted: the fence holds and the cap is spent, or the fence does not hold.
    const { rows: held } = await sql.query<{ held: boolean }>(
      `select exists (
         select 1 from run_offers o
          where o.run_id = $1 and o.state = 'claimed' and o.lease_epoch = $2 and o.worker_id = $3
       ) as held`,
      [input.runId, input.epoch, input.workerId],
    );
    return held[0]?.held === true ? { kind: 'cap' } : { kind: 'lost' };
  },
});
