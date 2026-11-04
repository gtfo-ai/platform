/**
 * The production {@link RunPlanSealer} (WP-275a, TD-031's 2026-11-04 amendment §2): a run's stored
 * plan sealed with the `secrets` table's envelope (`./envelope.ts`) under the key derived from
 * `APP_SECRET_KEY` — a random data key per plan, wrapped under the platform key, both layers
 * authenticated against the plan's **bound identity**.
 *
 * The identity is the run id, prefixed `run_plan:` so an envelope can never be moved between this
 * table and `secrets` (whose identity is a bare `secrets.id`): two uuids from two tables cannot
 * collide in practice, and the prefix makes it impossible rather than improbable.
 *
 * A plan sealed under another `APP_SECRET_KEY` generation is refused **by its key id** before any
 * decryption is tried — `run_plan_unreadable` naming the rotation, not a tag failure — exactly as
 * `PostgresSecretStore` refuses a `secrets` row.
 */
import {
  type RunPlanSealer,
  RunPlanUnreadableError,
  type SealedRunPlan,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { isSealedUnder, openSecret, type SecretKey, sealSecret } from './envelope.js';

/** The identity a run's plan is sealed for — the run id, in its own namespace. */
export const runPlanIdentity = (runId: Id): string => `run_plan:${runId}`;

export const createEnvelopeRunPlanSealer = (key: SecretKey): RunPlanSealer => ({
  seal: (runId: Id, plaintext: string): SealedRunPlan => ({
    sealed: new Uint8Array(sealSecret(key, plaintext, runPlanIdentity(runId))),
    keyId: key.keyId,
  }),
  open: (runId: Id, sealed: Uint8Array, keyId: string): string => {
    if (!isSealedUnder(key, keyId)) {
      throw new RunPlanUnreadableError(
        runId,
        'it was sealed under another APP_SECRET_KEY generation than this process holds',
      );
    }
    try {
      return openSecret(key, Buffer.from(sealed), runPlanIdentity(runId));
    } catch (cause) {
      throw new RunPlanUnreadableError(runId, 'its envelope does not authenticate for this run', {
        cause,
      });
    }
  },
});
