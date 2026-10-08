/**
 * When each lifecycle slot is written — TD-029 decision 4 as a pure table (BD-031, WP-174 ruling
 * (d), product/04 § "Ticket lifecycle").
 *
 * The lifecycle handler (`ticketLifecycleHandler`, WP-177) asks this table on a task's stage events
 * and, when the project maps the slot it names, its `ticket_lifecycle` duty transitions the ticket
 * there. The table names **slots, never
 * statuses**: the status is the project's own name, read off the binding by the caller.
 *
 * | Signal | Slot |
 * |---|---|
 * | entry into a developer-role agent stage (`implementation`, `conflict_resolution`) | `in_progress` |
 * | entry into `code_review` | `in_review` |
 * | completion with verdict `approve` of the **last enabled agent review stage** | `approved` |
 * | entry into `qa` | `qa` |
 * | entry into `merged_gate` | `done` |
 *
 * Two moments of decision 4 are not stage signals and are not here: `in_progress` **at the claim**
 * and `pick_up_from` **at release** are written by the claim and release functions themselves
 * (decision 5, WP-177).
 *
 * **`approved` is a completion, never an entry.** The last enabled agent review stage is
 * `business_review`, or `code_review` where the task's template or dial disables business review —
 * read off the compiled pipeline, so the dial's switch is honoured without a second rule. Because
 * it is tied to the review's verdict and not to the gate that follows, a re-entry into
 * `rebase_gate` (a default-branch move while the task waits at QA or Ready) writes nothing, and so
 * cannot pull a ticket back out of QA.
 */
import type { LifecycleSingleSlot, Slug } from '@platform/contracts';
import { type CompiledPipeline, stageOf } from '../pipeline/interpreter.js';
import { QA_STAGE_ID } from '../pipeline/templates.js';

/** A task's stage event, as the lifecycle duty reads it. */
export type LifecycleSignal =
  | { readonly kind: 'stage_entered'; readonly stage: Slug }
  | {
      readonly kind: 'stage_completed';
      readonly stage: Slug;
      /** The stage's verdict, unvalidated — only `approve` can name a slot. */
      readonly verdict: string | null;
    };

/** The agent review stages, in the order the merge tail runs them (decision 4). */
export const AGENT_REVIEW_STAGE_IDS: readonly Slug[] = ['code_review', 'business_review'];

/** The stages whose **entry** names a slot by id. `in_progress` is named by role instead. */
const ENTRY_SLOTS: Readonly<Record<string, LifecycleSingleSlot>> = {
  code_review: 'in_review',
  [QA_STAGE_ID]: 'qa',
  merged_gate: 'done',
};

/** The last **enabled** agent review stage of this pipeline, or `null` when it has none. */
export const lastEnabledAgentReviewStage = (pipeline: CompiledPipeline): Slug | null => {
  const enabled = pipeline.stages.filter(
    (stage) => stage.enabled && stage.kind === 'agent' && AGENT_REVIEW_STAGE_IDS.includes(stage.id),
  );
  return enabled.at(-1)?.id ?? null;
};

/**
 * The slot this signal writes, or `null` when it writes none. A stage the pipeline does not contain,
 * or one it disabled, writes nothing.
 */
export const lifecycleMomentFor = (
  signal: LifecycleSignal,
  pipeline: CompiledPipeline,
): LifecycleSingleSlot | null => {
  const stage = stageOf(pipeline, signal.stage);
  if (stage === null || !stage.enabled) {
    return null;
  }
  if (signal.kind === 'stage_completed') {
    return signal.verdict === 'approve' && lastEnabledAgentReviewStage(pipeline) === stage.id
      ? 'approved'
      : null;
  }
  if (stage.kind === 'agent' && stage.role === 'developer') {
    return 'in_progress';
  }
  return Object.hasOwn(ENTRY_SLOTS, stage.id) ? (ENTRY_SLOTS[stage.id] ?? null) : null;
};
