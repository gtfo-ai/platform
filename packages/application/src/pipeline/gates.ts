/**
 * Gate evaluation — product/04's S4 (CI), S6b (rebase) and S8 (merged).
 *
 * A gate is "a deterministic check". Three of them are the platform's own and are evaluated here;
 * anything else a template declares is resolved by its `on` event, or by a `command`, which needs
 * a workspace and is therefore not evaluated yet — and says so rather than passing.
 *
 * ## The rebase gate does **not** read `mergeable`
 *
 * `mergeable: true` means "the provider would let you press merge", which is not the question. The
 * rebase gate asks "does this branch still apply to the target", and the field that answers it is
 * `has_conflicts`. The two differ in both directions: a provider can report `mergeable: true` for
 * a branch that is behind the target (nothing conflicts, but the project may require a linear
 * history), and it reports `mergeable: false` for an unrelated reason such as a failing pipeline
 * or a missing approval, neither of which a rebase would fix.
 *
 * And `has_conflicts: null` is a **third** answer, not a false one: the provider has not finished
 * computing it. Treating unknown as "no conflicts" merges a conflicted branch; treating it as
 * "conflicted" sends a clean branch back to Implementation to fix nothing. So it is neither — the
 * gate reports `pending` and the job re-runs it, a bounded number of times.
 *
 * ## What a failed CI gate says, and what it deliberately does not (Q55)
 *
 * The failure branch settles `passed: false` and names the **failing jobs** — not product/04 S4's
 * "failing job's error block", which needs `getJobLog`, whose redaction obligation for a
 * *run-scoped* credential is open (Q55). The `detail` is stored on the task as the return reason
 * and handed to the next Implementation run, so reading a log before that question is answered
 * would put a token in it. The cut is pinned by `gates.test.ts` rather than only written here.
 *
 * That file also executes every branch of this module, including each `unsupported` refusal, and
 * the e2e drives the CI failure end to end (`test/e2e/pipeline`, "when the merge request's
 * pipeline is red"). Both exist because of what the round-1 review measured: settling
 * `CI_TERMINAL_FAIL` as `passed: true` left the whole unit+contract tier green, and a task
 * advanced to code review on red CI. This is a guard, and an untested guard fails open in silence.
 */
import { isBuiltinGateStageId } from '@platform/contracts';
import type { PipelineStage } from '@platform/domain';
import type { PipelineIntegrations } from './integrations.js';
import { gitReads } from './integrations.js';
import type { StoredTask } from './store.js';

export type GateResult =
  | { readonly kind: 'settled'; readonly passed: boolean; readonly detail: string }
  /** The answer is not available yet; ask again after `retryInMs`. */
  | { readonly kind: 'pending'; readonly detail: string }
  /** The platform cannot evaluate this gate at all; the task escalates. */
  | { readonly kind: 'unsupported'; readonly detail: string };

/** How many times a gate may answer `pending` before the task is parked for a human. */
export const MAX_GATE_CHECKS = 5;

export interface GateEvaluator {
  evaluate(stage: PipelineStage, stored: StoredTask): Promise<GateResult>;
}

const CI_TERMINAL_PASS = new Set(['success']);
const CI_TERMINAL_FAIL = new Set(['failed', 'canceled', 'skipped']);

export const createGateEvaluator = (integrations: PipelineIntegrations): GateEvaluator => {
  const git = gitReads(integrations);

  return {
    evaluate: async (stage, stored) => {
      if (stage.command !== null) {
        return {
          kind: 'unsupported',
          detail: `gate "${stage.id}" runs the command ${JSON.stringify(stage.command)}, which needs a workspace the platform does not provision for gates yet`,
        };
      }
      if (!isBuiltinGateStageId(stage.id)) {
        // A gate with an `on` event is settled by that event's handler, not here.
        return stage.on.length > 0
          ? { kind: 'pending', detail: `waiting for ${stage.on[0]?.on ?? 'an event'}` }
          : {
              kind: 'unsupported',
              detail: `gate "${stage.id}" is not one the platform evaluates and declares no event`,
            };
      }

      const context = { projectId: stored.task.projectId, taskId: stored.task.id };

      if (stage.id === 'merged_gate') {
        // S8's trigger *is* the evidence: the task only reaches this gate through `mr.merged`.
        return { kind: 'settled', passed: true, detail: 'the merge request was merged' };
      }

      if (stored.mr === null) {
        return {
          kind: 'unsupported',
          detail: `gate "${stage.id}" needs a merge request and the task has none`,
        };
      }

      if (stage.id === 'ci_gate') {
        const headSha = stored.mr.head_sha;
        if (headSha === null || headSha === undefined) {
          return { kind: 'pending', detail: 'the merge request has no head commit yet' };
        }
        const status = await git.pipelineStatus(headSha, context);
        if (status === null) {
          // "If the project has no CI, the gate is skipped and the local test run is the
          // evidence" (product/04 S4).
          return {
            kind: 'settled',
            passed: true,
            detail:
              'the project has no pipeline for this commit; the local test run is the evidence',
          };
        }
        if (CI_TERMINAL_PASS.has(status.status)) {
          return { kind: 'settled', passed: true, detail: `pipeline ${status.id} succeeded` };
        }
        if (CI_TERMINAL_FAIL.has(status.status)) {
          const failed = status.jobs
            .filter((job) => job.status === 'failed' && !job.allow_failure)
            .map((job) => job.name);
          return {
            kind: 'settled',
            passed: false,
            detail:
              failed.length === 0
                ? `pipeline ${status.id} ${status.status}`
                : `pipeline ${status.id} ${status.status}: ${failed.join(', ')}`,
          };
        }
        return { kind: 'pending', detail: `pipeline ${status.id} is ${status.status}` };
      }

      // rebase_gate
      const mr = await git.mergeRequest(stored.mr, context);
      if (mr === null) {
        return {
          kind: 'unsupported',
          detail: 'the project has no git binding, so the rebase gate cannot be evaluated',
        };
      }
      if (mr.has_conflicts === null || mr.has_conflicts === undefined) {
        return { kind: 'pending', detail: 'the provider has not computed mergeability yet' };
      }
      return mr.has_conflicts
        ? {
            kind: 'settled',
            passed: false,
            detail: `merge request !${mr.ref.iid} conflicts with ${mr.target_branch}`,
          }
        : {
            kind: 'settled',
            passed: true,
            detail: `merge request !${mr.ref.iid} applies cleanly to ${mr.target_branch}`,
          };
    },
  };
};
