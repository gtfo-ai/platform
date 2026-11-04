/**
 * The test double of {@link RunPlanSealer} (WP-275a) — reversible, **not** a cipher, and stricter
 * than kinder where it can be (standing rule 5): it binds the run id exactly as the envelope's AAD
 * does, so a blob opened for another run is refused, and a key id it did not write is refused as a
 * rotated `APP_SECRET_KEY` is. What it cannot show is confidentiality; the envelope's own tests do
 * (`packages/infrastructure/src/secrets/run-plan-sealer.test.ts`).
 */
import type { Id } from '@platform/contracts';
import {
  type RunPlanSealer,
  RunPlanUnreadableError,
  type SealedRunPlan,
} from '../ports/run-plan-sealer.js';

/** The key id this double writes; any other is refused. */
export const TEST_RUN_PLAN_KEY_ID = 'test:run-plan:1';

export const createTestRunPlanSealer = (
  keyId: string = TEST_RUN_PLAN_KEY_ID,
): RunPlanSealer & { readonly sealedCount: () => number } => {
  let sealedCount = 0;
  return {
    seal: (runId: Id, plaintext: string): SealedRunPlan => {
      sealedCount += 1;
      return {
        sealed: new TextEncoder().encode(JSON.stringify({ for: runId, body: plaintext })),
        keyId,
      };
    },
    open: (runId: Id, sealed: Uint8Array, storedKeyId: string): string => {
      if (storedKeyId !== keyId) {
        throw new RunPlanUnreadableError(runId, `it was sealed under key ${storedKeyId}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(sealed));
      } catch (cause) {
        throw new RunPlanUnreadableError(runId, 'it does not authenticate', { cause });
      }
      const envelope = parsed as { readonly for?: unknown; readonly body?: unknown };
      if (envelope.for !== runId || typeof envelope.body !== 'string') {
        throw new RunPlanUnreadableError(runId, 'it belongs to another run');
      }
      return envelope.body;
    },
    sealedCount: () => sealedCount,
  };
};
