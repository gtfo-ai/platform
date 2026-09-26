/**
 * The dial's two pipeline policies inside the interpreter — WP-62, PROGRESS backlog 72 (b), Q79.
 *
 * Every dial here is built from the **shipped presets** through `materialiseAutonomy` and
 * `pipelineDialOf`, the same path a task's frozen copy takes, so a preset edit that moved a boundary
 * fails here rather than in a hand-written literal that still says what the table used to. Each
 * policy is asserted from both sides (standing rule 42): the position that sets it and the position
 * that does not, over the same template and the same signal.
 */
import type { AutonomyLevel, IsoDateTime, TaskPipelineDial } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { applyAutonomyPreset, materialiseAutonomy, pipelineDialOf } from '../policies/autonomy.js';
import {
  BUSINESS_REVIEW_STAGE_ID,
  type CompiledPipeline,
  compilePipeline,
  interpret,
  type PipelineSignal,
  stageOf,
} from './interpreter.js';
import {
  CHORE_TEMPLATE,
  FEATURE_TEMPLATE,
  SHIPPED_TEMPLATES,
  SPIKE_HUMAN_STAGE,
  SPIKE_TEMPLATE,
} from './templates.js';

const dialAt = (level: AutonomyLevel): TaskPipelineDial =>
  pipelineDialOf(
    materialiseAutonomy({ level, at: '2026-09-26T09:00:00.000Z' as IsoDateTime, appliedBy: null }),
    applyAutonomyPreset(level),
  );

const approved = (stage: string): PipelineSignal => ({
  kind: 'stage_completed',
  stage,
  verdict: 'approve',
});

describe('businessReview — the compile step switches the stage (backlog 72 (b), built first)', () => {
  it('reads the preset rather than a literal: false at Observe and Assist, true above', () => {
    expect(dialAt('observe').business_review).toBe(false);
    expect(dialAt('assist').business_review).toBe(false);
    expect(dialAt('supervised').business_review).toBe(true);
    expect(dialAt('autonomous').business_review).toBe(true);
  });

  it('disables business_review when the dial says so, so code review approves past it', () => {
    const off = compilePipeline('feature', FEATURE_TEMPLATE, {
      ...dialAt('supervised'),
      business_review: false,
    });
    expect(stageOf(off, BUSINESS_REVIEW_STAGE_ID)?.enabled).toBe(false);
    expect(interpret(off, approved('code_review'))).toEqual({
      kind: 'enter',
      stage: 'rebase_gate',
    });
  });

  it('runs business_review at Supervised and when no dial applies (the other side)', () => {
    for (const dial of [dialAt('supervised'), dialAt('autonomous'), null]) {
      const pipeline = compilePipeline('feature', FEATURE_TEMPLATE, dial);
      expect(stageOf(pipeline, BUSINESS_REVIEW_STAGE_ID)?.enabled, String(dial?.level)).toBe(true);
      expect(interpret(pipeline, approved('code_review'))).toEqual({
        kind: 'enter',
        stage: BUSINESS_REVIEW_STAGE_ID,
      });
    }
  });

  it('touches no other stage, and keeps the dial on the compiled pipeline', () => {
    const off = compilePipeline('feature', FEATURE_TEMPLATE, dialAt('assist'));
    const on = compilePipeline('feature', FEATURE_TEMPLATE, null);
    expect(off.stages.filter((stage) => !stage.enabled).map((stage) => stage.id)).toEqual([
      BUSINESS_REVIEW_STAGE_ID,
    ]);
    expect(on.stages.every((stage) => stage.enabled)).toBe(true);
    expect(off.dial).toEqual(dialAt('assist'));
    expect(on.dial).toBeNull();
  });
});

describe('stopAfterStage — Assist parks after architecture (Q79)', () => {
  const assist = compilePipeline('feature', FEATURE_TEMPLATE, dialAt('assist'));
  const supervised = compilePipeline('feature', FEATURE_TEMPLATE, dialAt('supervised'));

  it('escalates instead of entering implementation, with a brief that names the policy', () => {
    const decision = interpret(assist, approved('architecture'));
    expect(decision.kind).toBe('escalate');
    if (decision.kind !== 'escalate') return;
    expect(decision.reason).toBe(
      'stopped after "architecture" by the autonomy dial (Assist: stop_after_stage)',
    );
    // Q79's sentence, with the stage the hand-back re-enters named rather than implied.
    expect(decision.blockerBrief).toBe(
      'This project\'s autonomy dial is set to Assist (scoping-only), so the task stops after "architecture". The artifacts up to and including "architecture" are ready. Hand the task back at "implementation" to continue, or cancel it.',
    );
  });

  it('enters implementation at Supervised, Autonomous and with no dial (the other boundary)', () => {
    expect(interpret(supervised, approved('architecture'))).toEqual({
      kind: 'enter',
      stage: 'implementation',
    });
    for (const dial of [dialAt('autonomous'), null]) {
      expect(
        interpret(compilePipeline('feature', FEATURE_TEMPLATE, dial), approved('architecture')),
      ).toEqual({ kind: 'enter', stage: 'implementation' });
    }
  });

  it('does not halt anything before the stop stage, nor a return out of it', () => {
    expect(interpret(assist, { kind: 'start' })).toEqual({ kind: 'enter', stage: 'intake' });
    expect(interpret(assist, approved('refinement'))).toEqual({
      kind: 'enter',
      stage: 'architecture',
    });
    // The scope is not finished while the Architect is still sending it back.
    expect(
      interpret(assist, {
        kind: 'stage_completed',
        stage: 'architecture',
        verdict: 'request_changes',
      }),
    ).toMatchObject({ kind: 'return', from: 'architecture', to: 'refinement' });
  });

  it('does not halt a template whose next stage is already a human one (the spike)', () => {
    // `architecture → human_review` is "a human decides" already; parking it in `needs_human`
    // instead would report a finished spike as a fault.
    const spike = compilePipeline('spike', SPIKE_TEMPLATE, dialAt('assist'));
    expect(interpret(spike, approved('architecture'))).toEqual({
      kind: 'enter',
      stage: SPIKE_HUMAN_STAGE,
    });
  });

  it('parks a template that never runs the stop stage before anything runs (fail closed)', () => {
    const chore = compilePipeline('chore', CHORE_TEMPLATE, dialAt('assist'));
    const decision = interpret(chore, { kind: 'start' });
    expect(decision).toMatchObject({
      kind: 'escalate',
      reason: 'the autonomy dial stops after "architecture", which template "chore" does not run',
    });
    if (decision.kind !== 'escalate') return;
    expect(decision.blockerBrief).toContain('set to Assist (scoping-only');
    expect(decision.blockerBrief).toContain('Hand the task back at "refinement"');
    // The other side: the same chore at Supervised starts normally.
    expect(
      interpret(compilePipeline('chore', CHORE_TEMPLATE, dialAt('supervised')), { kind: 'start' }),
    ).toEqual({ kind: 'enter', stage: 'intake' });
  });

  it('treats a disabled stop stage as absent, rather than as a stop that never fires', () => {
    const withoutArchitecture = compilePipeline(
      'feature',
      {
        stages: FEATURE_TEMPLATE.stages.map((stage) =>
          stage.id === 'architecture' ? { ...stage, enabled: false } : stage,
        ),
      },
      dialAt('assist'),
    );
    expect(interpret(withoutArchitecture, { kind: 'start' })).toMatchObject({ kind: 'escalate' });
  });
});

/**
 * The property the policy exists for, over **every** shipped template: under the Assist dial no
 * decision moves a task forward out of `architecture` into a stage that does work. Enumerated over
 * every agent verdict and every gate result, so a template added later is covered the day it ships.
 */
describe('no shipped template runs past the scope at Assist', () => {
  const verdicts = ['approve', 'request_changes', 'reject', 'questions', null, 'nonsense'];
  const compiled: readonly CompiledPipeline[] = Object.entries(SHIPPED_TEMPLATES).map(
    ([id, template]) => compilePipeline(id, template, dialAt('assist')),
  );

  it('never enters an agent or gate stage from architecture', () => {
    for (const pipeline of compiled) {
      const architecture = stageOf(pipeline, 'architecture');
      if (architecture === null) continue;
      for (const verdict of verdicts) {
        const decision = interpret(pipeline, {
          kind: 'stage_completed',
          stage: 'architecture',
          verdict,
        });
        if (decision.kind === 'enter') {
          const entered = stageOf(pipeline, decision.stage);
          const index = pipeline.stages.findIndex((stage) => stage.id === decision.stage);
          const from = pipeline.stages.findIndex((stage) => stage.id === 'architecture');
          expect(
            index < from || entered?.kind === 'human' || entered?.kind === 'system',
            `${pipeline.templateId}: ${String(verdict)} entered ${decision.stage}`,
          ).toBe(true);
        }
      }
    }
  });
});
