/**
 * The seal over a run's stored plan — `run_plans.sealed_spec` (WP-275a, TD-031's 2026-11-04
 * amendment §2).
 *
 * A port because the mechanism is the `secrets` table's envelope (`APP_SECRET_KEY`, AES-256-GCM,
 * `packages/infrastructure/src/secrets/envelope.ts`), which this ring cannot import; the adapter is
 * `createEnvelopeRunPlanSealer` there. The **run id is the bound identity**: a sealed spec opens
 * only for the run it was sealed for, so a blob copied onto another run's row is refused rather than
 * run.
 *
 * Why sealed rather than redacted is the amendment's ruling: the session must be handed exactly the
 * bytes the planner assembled, and the pattern rules a redactor applies would rewrite a prompt on a
 * false positive. TD-012 governs what is stored **readable**; a sealed column is the `secrets`
 * table's shape, served by no route, and cleared at the run's terminal write.
 */
import type { Id } from '@platform/contracts';

export interface SealedRunPlan {
  readonly sealed: Uint8Array;
  /** The key generation that sealed it, stored as `run_plans.key_id`. */
  readonly keyId: string;
}

export interface RunPlanSealer {
  /** Seals one run's plan document (canonical JSON) for that run. */
  readonly seal: (runId: Id, plaintext: string) => SealedRunPlan;
  /**
   * Opens one run's plan.
   *
   * @throws {RunPlanUnreadableError} for a blob sealed for another run, under a key this process
   * does not hold (an `APP_SECRET_KEY` rotated without its previous generation), or corrupt — and
   * the error names none of its bytes.
   */
  readonly open: (runId: Id, sealed: Uint8Array, keyId: string) => string;
}

/** The plan could not be opened: `run_plan_unreadable` (TD-031's 2026-11-04 amendment §2). */
export class RunPlanUnreadableError extends Error {
  override readonly name = 'RunPlanUnreadableError';
  readonly runId: Id;

  constructor(runId: Id, why: string, options?: { readonly cause?: unknown }) {
    super(`the stored plan of run ${runId} cannot be opened: ${why}`, options);
    this.runId = runId;
  }
}
