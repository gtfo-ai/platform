/**
 * `ReadinessStore` on PostgreSQL — `readiness_evaluations` (migration 0008) and the narrow
 * `projects.readiness_level` write (migration 0003), WP-21.
 *
 * The table has existed since WP-03 and **nothing wrote to it** until this file: `GET
 * /api/projects/:id/readiness` answered `409 readiness_not_evaluated` with the row count, which is
 * the sentence this adapter falsifies.
 *
 * Two things deserve reading before they are changed.
 *
 * **The two writes are one method because they are one fact.** The row is the history and the
 * column is the projection every board badge and `suggestedAutonomyCap` reads; a build that wrote
 * one without the other would show a level no evaluation supports. They land in the caller's
 * transaction, so a rollback takes both.
 *
 * **The `projects` write names one column.** `update projects set readiness_level = $2 where id =
 * $1` — not a whole-row `save`, and not a read-modify-write. This adapter runs in the
 * `onboarding.discovery` job, beside a wizard that is editing the same row's name, configuration
 * and autonomy dial; standing rule 79 is the measurement that made every other narrow writer in
 * this repository narrow, and this is a new writer joining rather than its next instance.
 *
 * **A `projects` row that has gone is not an error here.** The job re-reads the project first and
 * skips when it has been deleted, so a zero-row update at this point means the project was deleted
 * between that read and this write — a race whose only sensible ending is the one the cascade
 * already chose. The evaluation insert would have failed on the foreign key first anyway, which is
 * why this order (row, then column) is the safe one.
 */

import type { ReadinessEvaluation, ReadinessStore, Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { ReadinessDetector } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface EvaluationRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly level: number;
  readonly criteria: unknown;
  readonly evaluated_at: Date;
  readonly source: string;
}

/**
 * `criteria` is `jsonb`. It is read defensively — a row this build did not write, or one written by
 * an older one, must not crash a read — and every entry that is not the shape the port publishes is
 * dropped rather than coerced. The route re-validates against `readinessResponseSchema` anyway,
 * and a half-parsed criterion reaching a human would be worse than a missing one.
 */
const toCriteria = (raw: unknown): ReadinessEvaluation['criteria'] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const criteria: ReadinessEvaluation['criteria'][number][] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.passed !== 'boolean' ||
      typeof record.evidence !== 'string' ||
      typeof record.unlocks !== 'string' ||
      (record.detected_by !== 'agent' && record.detected_by !== 'platform')
    ) {
      continue;
    }
    criteria.push({
      id: record.id,
      passed: record.passed,
      evidence: record.evidence,
      unlocks: record.unlocks,
      detectedBy: record.detected_by as ReadinessDetector,
    });
  }
  return criteria;
};

/** snake_case on the way in, because `criteria` is a jsonb payload like every other one. */
const toJson = (evaluation: ReadinessEvaluation): string =>
  JSON.stringify(
    evaluation.criteria.map((criterion) => ({
      id: criterion.id,
      passed: criterion.passed,
      evidence: criterion.evidence,
      unlocks: criterion.unlocks,
      detected_by: criterion.detectedBy,
    })),
  );

export class PostgresReadinessStore implements ReadinessStore {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async record(tx: Transaction, evaluation: ReadinessEvaluation): Promise<void> {
    const sql = sqlOf(tx);
    await sql.query(
      `insert into readiness_evaluations (id, project_id, level, criteria, evaluated_at, source)
       values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        evaluation.id,
        evaluation.projectId,
        evaluation.level,
        toJson(evaluation),
        evaluation.evaluatedAt,
        evaluation.source,
      ],
    );
    // One column. See the module docblock (standing rule 79).
    await sql.query('update projects set readiness_level = $2 where id = $1', [
      evaluation.projectId,
      evaluation.level,
    ]);
  }

  async latest(projectId: Id): Promise<ReadinessEvaluation | null> {
    const { rows } = await this.#sql.query<EvaluationRow>(
      `select id, project_id, level, criteria, evaluated_at, source
         from readiness_evaluations
        where project_id = $1
        order by evaluated_at desc, id desc
        limit 1`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id as Id,
      projectId: row.project_id as Id,
      level: Number(row.level),
      criteria: toCriteria(row.criteria),
      evaluatedAt: new Date(row.evaluated_at).toISOString() as IsoDateTime,
      source: row.source,
    };
  }
}

export const createPostgresReadinessStore = (sql: SqlExecutor): ReadinessStore =>
  new PostgresReadinessStore(sql);
