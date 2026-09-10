/**
 * The pipeline interpreter — technical/02 § "Sagas" (PipelineSaga) and product/04.
 *
 * "A pipeline is data, not code." This module is the reader of that data: given a compiled
 * template and one *signal* (a stage finished, a gate settled, an event arrived at a human stage),
 * it returns one *decision* (enter a stage, return to an earlier one, wait, escalate, complete).
 *
 * It is a pure function of `(pipeline, signal)`. It touches no clock, no aggregate and no counter:
 * the iteration counters live on the Task and are enforced by `returnToStage` (which escalates
 * when a loop is spent), so the interpreter's job is to say *which* loop a return belongs to, not
 * how many are left. Keeping the two apart is what lets this be property-tested exhaustively
 * against a template while the counter arithmetic is tested against the aggregate.
 *
 * ## The three rules that decide everything
 *
 * 1. **Declaration order is the pipeline.** A stage with no explicit target falls through to the
 *    next *enabled* stage in the template's order; running off the end is `complete`. That is what
 *    makes "enable/disable stages" (product/04 § "Customisation model") work without every
 *    template having to rewire its neighbours.
 * 2. **Direction decides whether a transition is a return.** A target that sits *earlier* in
 *    declaration order is a return — it needs a bounded loop and a reason (BD-008) — and a target
 *    that sits later, or at the same index, is an advance. This is why `ci_gate.fail_to:
 *    implementation` and `ready_for_merge`'s `mr.review.comment → implementation` are both returns
 *    without either having to be flagged as one.
 * 3. **An unrecognised verdict escalates; it never guesses.** The verdict comes from a model
 *    (BD-022: untrusted) and a stage that reports nothing must not be read as approval. Standing
 *    rule 16: a guard against an untrusted producer must not read a field that producer can omit.
 *
 * ## What escalates rather than transitions
 *
 * Every one of these is a *decision* with a blocker brief, never a thrown error, because the saga
 * has to record it on the task and tell a human (product/04: "Every escalation and question
 * carries a blocker brief"):
 *
 *  - a verdict that is not in `stageVerdictSchema`, or is missing, or belongs to the other stage
 *    kind (`pass` from an agent, `approve` from a gate);
 *  - a `request_changes` from a stage with no `return_to`, or a failed gate with no `fail_to`;
 *  - a return from a stage this module cannot attribute to one of BD-008's bounded loops — see
 *    {@link RETURN_LOOPS}. An uncounted return is an unbounded loop, and "nothing retries
 *    silently";
 *  - a signal about a stage the template does not contain, or of the wrong kind for it.
 */
import type {
  AgentRole,
  ArtifactType,
  CustomStage,
  DomainEventType,
  PipelineTemplate,
  Slug,
  Stage,
  StageKind,
  StageVerdict,
} from '@platform/contracts';
import { stageVerdictSchema } from '@platform/contracts';
import type { IterationLoop } from '../policies/iteration-limits.js';
import { assertValidTemplate } from './templates.js';

// ── The normalised stage ─────────────────────────────────────────────────────

/** A human stage's event transition, and the single `on` event of a gate, in one shape. */
export interface PipelineTransition {
  readonly on: DomainEventType;
  readonly to: Slug | null;
}

/**
 * One stage as the interpreter reads it: every optional field of the four wire shapes present and
 * normalised, so no branch of this module has to ask which member of the union it is holding.
 * A project's `custom` stage is normalised into the same shape and spliced after its `after`.
 */
export interface PipelineStage {
  readonly id: Slug;
  readonly kind: StageKind;
  readonly enabled: boolean;
  readonly role: AgentRole | null;
  readonly produces: ArtifactType | null;
  readonly requires: readonly ArtifactType[];
  readonly approveTo: Slug | null;
  readonly returnTo: Slug | null;
  readonly next: Slug | null;
  readonly passTo: Slug | null;
  readonly failTo: Slug | null;
  /** Gate: the one event that settles it. Human: the transitions it wakes on. */
  readonly on: readonly PipelineTransition[];
  readonly command: string | null;
  readonly prompt: string | null;
  readonly promptAppend: string | null;
  /** True for a stage spliced in from `custom` (technical/12 `custom_stages`). */
  readonly custom: boolean;
}

/** A validated, normalised template with the index the interpreter needs. */
export interface CompiledPipeline {
  readonly templateId: Slug;
  /** Declaration order, custom stages spliced in, disabled ones **kept** (see `enabled`). */
  readonly stages: readonly PipelineStage[];
  readonly byId: ReadonlyMap<Slug, PipelineStage>;
}

const normaliseStage = (stage: Stage): PipelineStage => ({
  id: stage.id,
  kind: stage.kind,
  enabled: stage.enabled ?? true,
  role: 'role' in stage ? (stage.role ?? null) : null,
  produces: 'produces' in stage ? (stage.produces ?? null) : null,
  requires: 'requires' in stage ? (stage.requires ?? []) : [],
  approveTo: 'approve_to' in stage ? (stage.approve_to ?? null) : null,
  returnTo: 'return_to' in stage ? (stage.return_to ?? null) : null,
  next: 'next' in stage ? (stage.next ?? null) : null,
  passTo: 'pass_to' in stage ? (stage.pass_to ?? null) : null,
  failTo: 'fail_to' in stage ? (stage.fail_to ?? null) : null,
  on:
    stage.kind === 'human'
      ? stage.on.map((transition) => ({ on: transition.on, to: transition.to }))
      : stage.kind === 'gate' && stage.on !== undefined
        ? [{ on: stage.on, to: null }]
        : [],
  command: 'command' in stage ? (stage.command ?? null) : null,
  prompt: 'prompt' in stage ? (stage.prompt ?? null) : null,
  promptAppend: 'prompt_append' in stage ? (stage.prompt_append ?? null) : null,
  custom: false,
});

/**
 * A project's custom stage in the same shape. It carries no `enabled` flag (a project removes it
 * by deleting it) and no `next`: a custom stage always falls through to whatever follows the
 * predecessor it was spliced after.
 */
const normaliseCustomStage = (stage: CustomStage): PipelineStage => ({
  id: stage.id,
  kind: stage.kind,
  enabled: true,
  role: stage.role ?? null,
  produces: stage.produces ?? null,
  requires: [],
  approveTo: null,
  returnTo: null,
  next: null,
  passTo: stage.pass_to ?? null,
  failTo: stage.fail_to ?? null,
  on: [],
  command: stage.command ?? null,
  prompt: stage.prompt ?? null,
  promptAppend: null,
  custom: true,
});

/**
 * Validates and normalises a template once, so the interpreter never re-parses and a malformed
 * template fails at task start rather than three stages in.
 *
 * @throws {PolicyViolationError} when the shape or the graph is invalid (see `assertValidTemplate`).
 */
export const compilePipeline = (templateId: Slug, template: PipelineTemplate): CompiledPipeline => {
  assertValidTemplate(templateId, template);
  const stages: PipelineStage[] = [];
  for (const stage of template.stages) {
    stages.push(normaliseStage(stage));
    for (const extra of template.custom ?? []) {
      // A custom stage declares `after`, so it lands beside its predecessor rather than at the
      // end: `security_scan` after `ci_gate` has to run before `code_review`, and fall-through is
      // by position.
      if (extra.after === stage.id) {
        stages.push(normaliseCustomStage(extra));
      }
    }
  }
  return {
    templateId,
    stages,
    byId: new Map(stages.map((stage) => [stage.id, stage])),
  };
};

export const stageOf = (pipeline: CompiledPipeline, id: Slug): PipelineStage | null =>
  pipeline.byId.get(id) ?? null;

// ── Loop attribution (BD-008) ────────────────────────────────────────────────

/**
 * Which bounded loop a return *from* each shipped stage belongs to.
 *
 * BD-008 names six cycles; product/04 adds the rebase gate's "bounded, default 2 attempts". Two
 * entries deserve their reasoning stated, because they share a counter with another stage:
 *
 *  - `implementation → architecture` and `architecture → refinement` both count as
 *    `architecture_revisions`. Both are "the plan ahead of me is wrong", and giving them one
 *    budget is deliberate: a task that ping-pongs between the two would otherwise get twice the
 *    rounds BD-008 allows for planning.
 *  - `investigation → refinement` joins them for the same reason (the bug template's
 *    investigation is its planning stage).
 *
 * A stage that is **not** in this table cannot return: see the module docblock. That is the
 * fail-closed direction, and it is what a project's custom stage gets until the config schema
 * grows a way to name its loop (`docs/technical/PROGRESS.md`, WP-15 discovered work).
 */
export const RETURN_LOOPS: Readonly<Record<string, IterationLoop>> = {
  refinement: 'refinement_questions',
  investigation: 'architecture_revisions',
  architecture: 'architecture_revisions',
  implementation: 'architecture_revisions',
  ci_gate: 'ci_fix',
  code_review: 'code_review',
  business_review: 'business_review',
  rebase_gate: 'rebase',
  ready_for_merge: 'human_rounds',
} as const;

export const returnLoopFor = (stage: Slug): IterationLoop | null => RETURN_LOOPS[stage] ?? null;

// ── Signals and decisions ────────────────────────────────────────────────────

export type PipelineSignal =
  /** The task was admitted from the queue: enter the first stage. */
  | { readonly kind: 'start' }
  /** An agent or system stage finished. `verdict` is whatever the stage reported, unvalidated. */
  | {
      readonly kind: 'stage_completed';
      readonly stage: Slug;
      readonly verdict: string | null;
    }
  /** A gate was resolved — by its event, by the platform's own check, or by a command. */
  | {
      readonly kind: 'gate_settled';
      readonly stage: Slug;
      readonly passed: boolean;
      readonly detail: string;
    }
  /** An event arrived while the task sat at a human stage (product/04 S7). */
  | {
      readonly kind: 'event';
      readonly stage: Slug;
      readonly event: DomainEventType;
      readonly detail: string;
    }
  /** The stage's run ended without a verdict: failed, timed out, stalled, was cancelled. */
  | { readonly kind: 'stage_failed'; readonly stage: Slug; readonly reason: string };

export type PipelineDecision =
  /** Move to `stage`. */
  | { readonly kind: 'enter'; readonly stage: Slug }
  | {
      readonly kind: 'return';
      readonly from: Slug;
      readonly to: Slug;
      readonly loop: IterationLoop;
      readonly reason: string;
      readonly escalationBrief: string;
    }
  /** Nothing to do: the stage is waiting for a human, an event or an answer. */
  | { readonly kind: 'wait'; readonly stage: Slug; readonly reason: string }
  | { readonly kind: 'escalate'; readonly reason: string; readonly blockerBrief: string }
  /** The template has no stage after this one: the task is finished. */
  | { readonly kind: 'complete'; readonly from: Slug };

const escalate = (reason: string, blockerBrief: string): PipelineDecision => ({
  kind: 'escalate',
  reason,
  blockerBrief,
});

const indexOf = (pipeline: CompiledPipeline, id: Slug): number =>
  pipeline.stages.findIndex((stage) => stage.id === id);

/**
 * The first **enabled** stage at or after `fromIndex`, or `null` when there is none.
 *
 * Walking forward over a disabled stage is what `enabled: false` means, and it applies to a named
 * target as well as to fall-through: a template that disables `business_review` still has
 * `code_review.approve_to: business_review` written in it, and the task has to end up at the
 * gate beyond rather than at a stage that will never run.
 */
const firstEnabledFrom = (pipeline: CompiledPipeline, fromIndex: number): PipelineStage | null => {
  for (let index = Math.max(fromIndex, 0); index < pipeline.stages.length; index += 1) {
    const stage = pipeline.stages[index];
    if (stage?.enabled === true) {
      return stage;
    }
  }
  return null;
};

/** Advance to `target` (or fall through past `fromIndex`), skipping disabled stages. */
const advance = (
  pipeline: CompiledPipeline,
  from: Slug,
  fromIndex: number,
  target: Slug | null,
): PipelineDecision => {
  const startIndex = target === null ? fromIndex + 1 : indexOf(pipeline, target);
  if (startIndex < 0) {
    // `pipelineGraphIssues` refuses this at compile time, so reaching it means a template was
    // built by hand and never validated. Escalating beats throwing: the task is recoverable.
    return escalate(
      `stage "${from}" points at "${target ?? '(next)'}", which the template does not contain`,
      `The pipeline template "${pipeline.templateId}" is invalid: stage "${from}" transitions to "${target ?? '(next)'}", which is not one of its stages. Fix the template in .agentic/pipeline.yml or in the project settings, then hand the task back.`,
    );
  }
  const next = firstEnabledFrom(pipeline, startIndex);
  return next === null ? { kind: 'complete', from } : { kind: 'enter', stage: next.id };
};

/** A backwards transition: bounded, counted and reasoned (BD-008). */
const returnTo = (
  pipeline: CompiledPipeline,
  from: Slug,
  target: Slug,
  reason: string,
): PipelineDecision => {
  const loop = returnLoopFor(from);
  if (loop === null) {
    return escalate(
      `return from "${from}" belongs to no bounded loop`,
      `The pipeline wanted to send this task back from "${from}" to "${target}", but "${from}" is not one of the stages whose return cycles BD-008 bounds, so the round could not be counted. Decide the next step by hand, or give the stage a bounded loop in the template.`,
    );
  }
  const targetIndex = indexOf(pipeline, target);
  if (targetIndex < 0) {
    return escalate(
      `stage "${from}" returns to "${target}", which the template does not contain`,
      `The pipeline template "${pipeline.templateId}" is invalid: stage "${from}" returns to "${target}", which is not one of its stages.`,
    );
  }
  const destination = firstEnabledFrom(pipeline, targetIndex);
  // Walking forward over a disabled target is right for an *advance* and wrong for a return: it
  // can land on the returning stage itself, or past it, which is a forward jump wearing a return's
  // clothes — and it would consume a bounded loop to do it. A return that cannot go backwards is
  // not a return.
  if (destination === null || indexOf(pipeline, destination.id) >= indexOf(pipeline, from)) {
    return escalate(
      `stage "${from}" returns to "${target}", which is disabled, and the first enabled stage after it is not before "${from}"`,
      `The pipeline wanted to send this task back from "${from}" to "${target}", but "${target}" is disabled and every enabled stage after it is at or beyond "${from}", so there is nowhere to go back to. Re-enable the stage, or hand the task back at the stage that should address the feedback.`,
    );
  }
  return {
    kind: 'return',
    from,
    to: destination.id,
    loop,
    reason,
    escalationBrief: `The "${from}" stage has sent this task back to "${destination.id}" as many times as the ${loop} limit allows, and it is still not resolved. Read the last ${from} verdict on the task, decide what should change, and hand the task back at the stage you want it to resume from.`,
  };
};

/** Advance or return, decided by direction (rule 2 of the module docblock). */
const transition = (
  pipeline: CompiledPipeline,
  from: PipelineStage,
  fromIndex: number,
  target: Slug | null,
  reason: string,
): PipelineDecision => {
  if (target === null) {
    return advance(pipeline, from.id, fromIndex, null);
  }
  const targetIndex = indexOf(pipeline, target);
  return targetIndex >= 0 && targetIndex < fromIndex
    ? returnTo(pipeline, from.id, target, reason)
    : advance(pipeline, from.id, fromIndex, target);
};

const VERDICTS_BY_KIND: Readonly<Record<StageKind, readonly StageVerdict[]>> = {
  agent: ['approve', 'request_changes', 'reject', 'questions'],
  gate: ['pass', 'fail'],
  system: [],
  human: [],
};

/**
 * The single entry point. Total: every signal yields a decision, and an input this module cannot
 * make sense of yields `escalate` rather than an exception.
 */
export const interpret = (pipeline: CompiledPipeline, signal: PipelineSignal): PipelineDecision => {
  if (signal.kind === 'start') {
    const first = firstEnabledFrom(pipeline, 0);
    return first === null
      ? escalate(
          `template "${pipeline.templateId}" has no enabled stage`,
          `Every stage of the pipeline template "${pipeline.templateId}" is disabled, so there is nothing to run. Enable at least one stage in the project's pipeline settings.`,
        )
      : { kind: 'enter', stage: first.id };
  }

  const stage = stageOf(pipeline, signal.stage);
  const index = indexOf(pipeline, signal.stage);
  if (stage === null || index < 0) {
    return escalate(
      `"${signal.stage}" is not a stage of template "${pipeline.templateId}"`,
      `The platform received a "${signal.kind}" signal for stage "${signal.stage}", which the task's pipeline template does not contain — the template changed while the task was running. Hand the task back at a stage the current template has.`,
    );
  }

  switch (signal.kind) {
    case 'stage_failed':
      return escalate(
        `stage "${signal.stage}" did not produce a verdict: ${signal.reason}`,
        `The "${signal.stage}" stage ended without a result (${signal.reason}). Nothing is retried automatically. Look at the run's transcript, fix what stopped it, and hand the task back at "${signal.stage}".`,
      );

    case 'gate_settled': {
      if (stage.kind !== 'gate') {
        return escalate(
          `stage "${signal.stage}" is a ${stage.kind} stage, not a gate`,
          `The platform tried to settle "${signal.stage}" as a gate, but the template declares it as a ${stage.kind} stage. Fix the template, then hand the task back.`,
        );
      }
      if (signal.passed) {
        return transition(pipeline, stage, index, stage.passTo, signal.detail);
      }
      return stage.failTo === null
        ? escalate(
            `gate "${signal.stage}" failed and the template gives it no fail_to`,
            `The "${signal.stage}" gate failed (${signal.detail}) and the pipeline template does not say where a failure goes. Fix it by hand, or give the gate a "fail_to" stage.`,
          )
        : transition(pipeline, stage, index, stage.failTo, signal.detail);
    }

    case 'event': {
      if (stage.kind !== 'human') {
        return escalate(
          `stage "${signal.stage}" is a ${stage.kind} stage and does not wait on events`,
          `A "${signal.event}" event arrived for stage "${signal.stage}", which is not a human stage. Hand the task back at the stage it should be in.`,
        );
      }
      const match = stage.on.find((entry) => entry.on === signal.event);
      if (match === undefined || match.to === null) {
        // Fail *open* on an inbound notification (standing rule 20): an event the stage does not
        // subscribe to is not an error, it is an event for somebody else.
        return { kind: 'wait', stage: stage.id, reason: `no transition for "${signal.event}"` };
      }
      return transition(pipeline, stage, index, match.to, signal.detail);
    }

    case 'stage_completed': {
      if (stage.kind === 'system') {
        return transition(pipeline, stage, index, stage.next, 'system stage');
      }
      if (stage.kind !== 'agent') {
        return escalate(
          `stage "${signal.stage}" is a ${stage.kind} stage and does not complete with a verdict`,
          `The platform was told stage "${signal.stage}" completed, but the template declares it as a ${stage.kind} stage, which is resolved another way. Fix the template, then hand the task back.`,
        );
      }
      const parsed = stageVerdictSchema.safeParse(signal.verdict);
      if (!parsed.success) {
        return escalate(
          `stage "${signal.stage}" reported the verdict ${JSON.stringify(signal.verdict)}, which is not one the platform transitions on`,
          `The "${signal.stage}" stage finished but its verdict was ${signal.verdict === null ? 'missing' : JSON.stringify(signal.verdict)}, so the pipeline cannot tell whether it approved or asked for changes. Read the stage's artifact, then hand the task back at the stage that should run next.`,
        );
      }
      const verdict = parsed.data;
      if (!VERDICTS_BY_KIND.agent.includes(verdict)) {
        return escalate(
          `stage "${signal.stage}" is an agent stage and reported the gate verdict "${verdict}"`,
          `The "${signal.stage}" stage reported "${verdict}", which only a gate may report. Read the stage's artifact and hand the task back.`,
        );
      }
      switch (verdict) {
        case 'approve':
          return transition(pipeline, stage, index, stage.approveTo, 'approved');
        case 'questions':
          return {
            kind: 'wait',
            stage: stage.id,
            reason: 'the stage asked a blocking question',
          };
        case 'reject':
          return escalate(
            `stage "${signal.stage}" rejected the task`,
            `The "${signal.stage}" stage decided this ticket should not be worked on (duplicate, already done, not actionable, or out of product scope). Read its artifact, then either close the ticket or correct it and hand the task back.`,
          );
        default:
          return stage.returnTo === null
            ? escalate(
                `stage "${signal.stage}" asked for changes and the template gives it no return_to`,
                `The "${signal.stage}" stage asked for changes, but the pipeline template does not say which stage should address them. Fix the template, or hand the task back at the stage that should.`,
              )
            : transition(pipeline, stage, index, stage.returnTo, 'requested changes');
      }
    }
  }
};
