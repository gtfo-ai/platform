/**
 * `run_plans` (migration 0095, WP-275a, TD-031's 2026-11-04 amendment §2): the run's planned spec,
 * sealed by the application's `RunPlanSealer` before it reaches this module, so nothing here ever
 * holds a plaintext spec. The seal is cleared by `RunRepository.finish` ({@link clearRunPlanSeal}),
 * in the run's terminal transaction, after it has won the row — a leaf row reached only under the
 * run's lock, so the lock order is unchanged.
 */
import type {
  AppliedChecklistRecord,
  RunPlanRepository,
  StoredRunPlan,
  Transaction,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface RunPlanRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly format: number;
  readonly sealed_spec: Buffer | null;
  readonly key_id: string;
  readonly secret_env_names: string[];
  readonly review_checklists: AppliedChecklistRecord[] | null;
  readonly question_timeout: string;
}

const toStoredPlan = (row: RunPlanRow): StoredRunPlan => ({
  runId: row.run_id as Id,
  format: Number(row.format),
  sealedSpec: row.sealed_spec === null ? null : new Uint8Array(row.sealed_spec),
  keyId: row.key_id,
  secretEnvNames: [...row.secret_env_names],
  reviewChecklists: row.review_checklists,
  questionTimeout: row.question_timeout,
});

/** `finish`'s third statement for the winner: the run is terminal, so its sealed spec goes. */
export const clearRunPlanSeal = async (sql: SqlExecutor, runId: Id): Promise<void> => {
  await sql.query(
    'update run_plans set sealed_spec = null where run_id = $1 and sealed_spec is not null',
    [runId],
  );
};

export const createPostgresRunPlanRepository = (): RunPlanRepository => ({
  insert: async (tx, plan) => {
    await sqlOf(tx).query(
      `insert into run_plans (run_id, format, sealed_spec, key_id, secret_env_names,
                              review_checklists, question_timeout)
       values ($1, $2, $3, $4, $5::text[], $6::jsonb, $7)`,
      [
        plan.runId,
        plan.format,
        Buffer.from(plan.sealedSpec),
        plan.keyId,
        [...plan.secretEnvNames],
        plan.reviewChecklists === null ? null : JSON.stringify(plan.reviewChecklists),
        plan.questionTimeout,
      ],
    );
  },
  load: async (tx, runId) => {
    const { rows } = await sqlOf(tx).query<RunPlanRow>(
      `select run_id, format, sealed_spec, key_id, secret_env_names, review_checklists,
              question_timeout
         from run_plans where run_id = $1`,
      [runId],
    );
    const row = rows[0];
    return row === undefined ? null : toStoredPlan(row);
  },
});
