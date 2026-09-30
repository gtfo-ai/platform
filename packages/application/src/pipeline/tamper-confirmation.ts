/**
 * **The tamper check's second half, in the rebase gate's settlement** — WP-102, Q109 answered (b),
 * BD-024 §2: *"… unless the plan explicitly listed them with a reason, and the Code review must
 * confirm the reason."*
 *
 * Every shipped template runs `ci_gate` before `code_review`, so the CI gate's read (`tamper.ts`,
 * WP-81) cannot see the confirmation of a change the plan declared: it passes such a change
 * provisionally (`protected_paths_awaiting_review`), records its head like any pass, and records the
 * paths it excused (`tasks.ci_excused_paths`). The rebase gate is the last gate before Ready and runs
 * after both review stages, so its settlement is where the confirmation is read:
 *
 *  - **in the settlement's own transaction** — the artifacts are read with `scope.tx`, beside the
 *    task row the settlement is about to move, so the verdict it compares with is the one the move
 *    is decided against;
 *  - **with no provider call** — the diff was read by the CI gate at the head the rebase gate now
 *    agrees with (`rebaseAgainstCi` runs first; a head that moved still re-enters `ci_gate` through
 *    WP-79's path, unchanged, and that settlement rewrites the list);
 *  - **confirmed** → the settlement proceeds to Ready, and the rebase gate's row is closed
 *    `protected_paths_confirmed`, which is what the Checks panel's tamper item reads;
 *  - **not confirmed** → the task returns to implementation on `ci_fix` with the tamper reason —
 *    the return `ci_gate` would have made (its `fail_to` and loop, through the interpreter), from
 *    the stage the task is at — and the rebase gate's row is closed `protected_paths_changed`.
 *
 * **Residual, stated (WP-102 review):** a project whose pipeline disables `rebase_gate` falls through
 * `business_review` into Ready, and nothing then compares `ci_excused_paths` — a declared change the
 * review never confirmed can reach the merge. Latent: nothing on this build disables it (the
 * per-stage `enabled` setting is read by nothing, backlog 220). The gap is older than this module (under WP-81 the
 * provisional pass's null `ci_head_sha` was also read only by this settlement); it is filed in
 * PROGRESS's backlog rather than closed here.
 *
 * Until WP-102 the provisional pass recorded no `ci_head_sha`, so the rebase settlement re-entered
 * `ci_gate` and the check was made there a second time — after the template's fall-through had run
 * `code_review` and `business_review` again (measured on the fake-Claude e2e: two runs of each; one
 * since, `test/e2e/pipeline/tamper-settlement.e2e.test.ts`).
 */
import type { PipelineDecision } from '@platform/domain';
import { type CompiledPipeline, interpret } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import { CI_GATE_STAGE } from './gates.js';
import { REBASE_GATE_STAGE } from './rebase.js';
import type { PipelineStore, StoredTask } from './store.js';
import { exceptionsOf, tamperFailureDetail, unconfirmedExcusedPaths } from './tamper.js';

export type ExcusedPathsConfirmation =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'unconfirmed'; readonly paths: readonly string[] };

/**
 * Compares the paths the CI gate excused provisionally with the latest Review Verdict, reading the
 * task's artifacts through `tx` — the settlement's transaction. `null` when nothing was excused, so
 * the caller settles exactly as it did before WP-102.
 */
export const confirmExcusedPaths = async (
  store: Pick<PipelineStore, 'artifacts'>,
  tx: Transaction,
  stored: StoredTask,
): Promise<ExcusedPathsConfirmation | null> => {
  if (stored.ciExcusedPaths.length === 0) {
    return null;
  }
  const artifacts = await store.artifacts.listFor(tx, stored.task.id);
  const paths = unconfirmedExcusedPaths(stored.ciExcusedPaths, exceptionsOf(artifacts));
  return paths.length === 0 ? { kind: 'confirmed' } : { kind: 'unconfirmed', paths };
};

/**
 * The return `ci_gate` would have made for the unconfirmed paths, taken from the rebase gate.
 *
 * The target and the loop are the interpreter's answer to a failed `ci_gate` — its `fail_to`, the
 * `ci_fix` loop (`RETURN_LOOPS.ci_gate`), a disabled target walked the way every return walks it —
 * so this cannot drift from the return the CI gate makes for an undeclared path. Only `from` is the
 * rebase gate's, because that is the stage the task is at and whose attempt the return closes. When
 * the interpreter cannot return (a template whose `ci_gate` has no `fail_to`) its escalation stands.
 *
 * The paths were redacted when they were stored, so the reason is built without a second pass.
 */
export const unconfirmedTamperReturn = (
  pipeline: CompiledPipeline,
  stored: StoredTask,
  paths: readonly string[],
): PipelineDecision => {
  const reason = tamperFailureDetail(
    { kind: 'changed', undeclared: [], unconfirmed: paths },
    (text) => text,
  );
  const asCi = interpret(pipeline, {
    kind: 'gate_settled',
    stage: CI_GATE_STAGE,
    passed: false,
    detail: reason,
  });
  if (asCi.kind !== 'return') {
    return asCi;
  }
  return {
    ...asCi,
    from: REBASE_GATE_STAGE,
    escalationBrief: `The Code review of ${stored.task.ticket.key} has not confirmed protected paths the plan declared (${paths.join(', ')}) as many times as the ${asCi.loop} limit allows, so the rebase gate stopped sending it back to "${asCi.to}". Read the plan's protected_path_changes and the last Review Verdict, decide whether the change to those paths is justified, then hand the task back at code_review (to have the reason judged again) or at implementation (to undo the change) — handed back at rebase_gate it would read the same verdict and stop again.`,
  };
};
