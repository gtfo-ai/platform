import type { PipelineTemplate } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  compilePipeline,
  interpret,
  type PipelineDecision,
  type PipelineSignal,
  returnLoopFor,
  stageOf,
} from './interpreter.js';
import { BUG_TEMPLATE, CHORE_TEMPLATE, FEATURE_TEMPLATE } from './templates.js';

const feature = compilePipeline('feature', FEATURE_TEMPLATE);
const bug = compilePipeline('bug', BUG_TEMPLATE);
const chore = compilePipeline('chore', CHORE_TEMPLATE);

const completed = (stage: string, verdict: string | null): PipelineSignal => ({
  kind: 'stage_completed',
  stage,
  verdict,
});

describe('compilePipeline', () => {
  it('normalises every optional field so no caller repeats an `in` check', () => {
    const refinement = stageOf(feature, 'refinement');
    expect(refinement).toMatchObject({
      id: 'refinement',
      kind: 'agent',
      enabled: true,
      role: 'product_manager',
      produces: 'RefinedSpec',
      approveTo: null,
      returnTo: null,
      next: null,
      passTo: null,
      failTo: null,
      command: null,
      custom: false,
    });
  });

  it('gives a gate its single `on` event and a human stage its transition list', () => {
    expect(stageOf(feature, 'ci_gate')?.on).toEqual([{ on: 'ci.pipeline.finished', to: null }]);
    expect(stageOf(feature, 'ready_for_merge')?.on.map((entry) => entry.on)).toEqual([
      'mr.review.comment',
      'default_branch.moved',
      'mr.merged',
    ]);
  });

  it('splices a custom stage after its predecessor rather than at the end', () => {
    const withCustom = compilePipeline('feature', {
      ...FEATURE_TEMPLATE,
      custom: [{ id: 'security_scan', kind: 'gate', after: 'ci_gate', command: 'trivy fs .' }],
    });
    const ids = withCustom.stages.map((stage) => stage.id);
    expect(ids.indexOf('security_scan')).toBe(ids.indexOf('ci_gate') + 1);
    expect(stageOf(withCustom, 'security_scan')).toMatchObject({
      kind: 'gate',
      command: 'trivy fs .',
      custom: true,
    });
  });

  it('refuses to compile a template whose graph is broken', () => {
    expect(() =>
      compilePipeline('broken', {
        stages: [{ id: 'refinement', kind: 'agent', role: 'product_manager', next: 'nowhere' }],
      }),
    ).toThrow(/nowhere/);
  });
});

describe('the happy path of each shipped template', () => {
  it('starts at the first stage and walks the feature template to done', () => {
    expect(interpret(feature, { kind: 'start' })).toEqual({ kind: 'enter', stage: 'intake' });
    expect(interpret(feature, completed('intake', null))).toEqual({
      kind: 'enter',
      stage: 'refinement',
    });
    expect(interpret(feature, completed('refinement', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'architecture',
    });
    expect(interpret(feature, completed('architecture', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'implementation',
    });
    expect(interpret(feature, completed('implementation', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'ci_gate',
    });
    expect(
      interpret(feature, { kind: 'gate_settled', stage: 'ci_gate', passed: true, detail: 'green' }),
    ).toEqual({ kind: 'enter', stage: 'code_review' });
    expect(interpret(feature, completed('code_review', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'business_review',
    });
    expect(interpret(feature, completed('business_review', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'rebase_gate',
    });
    expect(
      interpret(feature, {
        kind: 'gate_settled',
        stage: 'rebase_gate',
        passed: true,
        detail: 'no conflicts',
      }),
    ).toEqual({ kind: 'enter', stage: 'ready_for_merge' });
    expect(
      interpret(feature, {
        kind: 'event',
        stage: 'ready_for_merge',
        event: 'mr.merged',
        detail: 'merged by a human',
      }),
    ).toEqual({ kind: 'enter', stage: 'merged_gate' });
    expect(
      interpret(feature, {
        kind: 'gate_settled',
        stage: 'merged_gate',
        passed: true,
        detail: 'merged',
      }),
    ).toEqual({ kind: 'enter', stage: 'retrospective' });
    expect(interpret(feature, completed('retrospective', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'done',
    });
    expect(interpret(feature, completed('done', null))).toEqual({ kind: 'complete', from: 'done' });
  });

  it('sends a bug through investigation before architecture', () => {
    expect(interpret(bug, completed('refinement', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'investigation',
    });
    expect(interpret(bug, completed('investigation', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'architecture',
    });
  });

  it('sends a chore straight from refinement to implementation and skips business review', () => {
    expect(interpret(chore, completed('refinement', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'implementation',
    });
    expect(interpret(chore, completed('code_review', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'rebase_gate',
    });
  });
});

describe('returns', () => {
  it('counts a failing CI gate as a ci_fix round back to implementation', () => {
    expect(
      interpret(feature, {
        kind: 'gate_settled',
        stage: 'ci_gate',
        passed: false,
        detail: 'test:unit failed',
      }),
    ).toMatchObject({
      kind: 'return',
      from: 'ci_gate',
      to: 'implementation',
      loop: 'ci_fix',
      reason: 'test:unit failed',
    });
  });

  it('counts a code review `request_changes` as a code_review round', () => {
    expect(interpret(feature, completed('code_review', 'request_changes'))).toMatchObject({
      kind: 'return',
      from: 'code_review',
      to: 'implementation',
      loop: 'code_review',
    });
  });

  it('counts a business review return separately from a code review one', () => {
    expect(interpret(feature, completed('business_review', 'request_changes'))).toMatchObject({
      loop: 'business_review',
    });
  });

  it('counts human merge-request comments as human_rounds', () => {
    expect(
      interpret(feature, {
        kind: 'event',
        stage: 'ready_for_merge',
        event: 'mr.review.comment',
        detail: '2 unresolved threads',
      }),
    ).toMatchObject({
      kind: 'return',
      from: 'ready_for_merge',
      to: 'implementation',
      loop: 'human_rounds',
    });
  });

  it('re-runs the rebase gate when the default branch moves under a waiting MR', () => {
    expect(
      interpret(feature, {
        kind: 'event',
        stage: 'ready_for_merge',
        event: 'default_branch.moved',
        detail: 'main moved',
      }),
    ).toMatchObject({
      kind: 'return',
      from: 'ready_for_merge',
      to: 'rebase_gate',
      loop: 'human_rounds',
    });
  });

  it('bounds the rebase gate with its own loop (product/04 S6b: default 2 attempts)', () => {
    expect(
      interpret(feature, {
        kind: 'gate_settled',
        stage: 'rebase_gate',
        passed: false,
        detail: 'conflicts in src/totals.ts',
      }),
    ).toMatchObject({ kind: 'return', to: 'implementation', loop: 'rebase' });
  });

  it('shares one counter between the two "the plan was wrong" returns', () => {
    expect(returnLoopFor('implementation')).toBe('architecture_revisions');
    expect(returnLoopFor('architecture')).toBe('architecture_revisions');
    expect(interpret(feature, completed('implementation', 'request_changes'))).toMatchObject({
      to: 'architecture',
      loop: 'architecture_revisions',
    });
  });

  it('carries a blocker brief on every return, so the escalation has one ready', () => {
    const decision = interpret(feature, completed('code_review', 'request_changes'));
    expect(decision.kind).toBe('return');
    expect(decision.kind === 'return' ? decision.escalationBrief : '').toContain('code_review');
  });
});

describe('what escalates instead of transitioning', () => {
  const escalationOf = (decision: PipelineDecision): string =>
    decision.kind === 'escalate' ? decision.reason : `not an escalation: ${decision.kind}`;

  it('refuses a missing verdict rather than reading it as approval', () => {
    // Standing rule 16: the model can omit the field, so absence must not mean "carry on".
    expect(escalationOf(interpret(feature, completed('code_review', null)))).toContain('null');
  });

  it('refuses a verdict outside the vocabulary', () => {
    expect(
      escalationOf(interpret(feature, completed('code_review', 'looks good to me'))),
    ).toContain('looks good to me');
  });

  it('refuses a gate verdict reported by an agent stage', () => {
    expect(escalationOf(interpret(feature, completed('code_review', 'pass')))).toContain(
      'gate verdict',
    );
  });

  it('escalates a refinement rejection with the product/04 S1 wording', () => {
    const decision = interpret(feature, completed('refinement', 'reject'));
    expect(decision.kind).toBe('escalate');
    expect(decision.kind === 'escalate' ? decision.blockerBrief : '').toContain('duplicate');
  });

  it('escalates a run that ended with no verdict at all', () => {
    expect(
      escalationOf(
        interpret(feature, { kind: 'stage_failed', stage: 'implementation', reason: 'stalled' }),
      ),
    ).toContain('stalled');
  });

  it('escalates a signal for a stage the template does not have', () => {
    expect(escalationOf(interpret(chore, completed('architecture', 'approve')))).toContain(
      'not a stage of template "chore"',
    );
  });

  it('escalates when a stage is settled as the wrong kind', () => {
    expect(
      escalationOf(
        interpret(feature, {
          kind: 'gate_settled',
          stage: 'code_review',
          passed: true,
          detail: '',
        }),
      ),
    ).toContain('not a gate');
    expect(escalationOf(interpret(feature, completed('ci_gate', 'approve')))).toContain(
      'does not complete with a verdict',
    );
    expect(
      escalationOf(
        interpret(feature, {
          kind: 'event',
          stage: 'implementation',
          event: 'mr.merged',
          detail: '',
        }),
      ),
    ).toContain('does not wait on events');
  });

  it('escalates a return from a stage no bounded loop covers', () => {
    // A project's custom gate: the interpreter would happily find `fail_to`, and refuses because
    // the round could not be counted. An uncounted return is an unbounded loop.
    const withCustom = compilePipeline('feature', {
      ...FEATURE_TEMPLATE,
      custom: [
        {
          id: 'security_scan',
          kind: 'gate',
          after: 'ci_gate',
          command: 'trivy fs .',
          fail_to: 'implementation',
        },
      ],
    });
    expect(
      escalationOf(
        interpret(withCustom, {
          kind: 'gate_settled',
          stage: 'security_scan',
          passed: false,
          detail: 'CVE-2026-0001',
        }),
      ),
    ).toContain('belongs to no bounded loop');
  });

  it('escalates a failed gate that has no fail_to', () => {
    expect(
      escalationOf(
        interpret(feature, {
          kind: 'gate_settled',
          stage: 'merged_gate',
          passed: false,
          detail: 'x',
        }),
      ),
    ).toContain('no fail_to');
  });

  it('escalates a request_changes from a stage with no return_to', () => {
    expect(escalationOf(interpret(feature, completed('refinement', 'request_changes')))).toContain(
      'no return_to',
    );
  });

  it('escalates a template with every stage disabled', () => {
    const disabled = compilePipeline('feature', {
      stages: [{ id: 'refinement', kind: 'agent', role: 'product_manager', enabled: false }],
    });
    expect(escalationOf(interpret(disabled, { kind: 'start' }))).toContain('no enabled stage');
  });
});

describe('waiting', () => {
  it('waits when a stage reports that it asked a blocking question', () => {
    expect(interpret(feature, completed('refinement', 'questions'))).toEqual({
      kind: 'wait',
      stage: 'refinement',
      reason: 'the stage asked a blocking question',
    });
  });

  it('ignores an event a human stage does not subscribe to, rather than failing', () => {
    // Standing rule 20: fail open on an inbound notification. A provider that starts sending a
    // new event type must not turn every delivery into a stuck task.
    expect(
      interpret(feature, {
        kind: 'event',
        stage: 'ready_for_merge',
        event: 'mr.updated',
        detail: 'description edited',
      }),
    ).toEqual({ kind: 'wait', stage: 'ready_for_merge', reason: 'no transition for "mr.updated"' });
  });
});

describe('disabled stages (product/04 § "Customisation model")', () => {
  const withoutBusinessReview: PipelineTemplate = {
    stages: FEATURE_TEMPLATE.stages.map((stage) =>
      stage.id === 'business_review' ? { ...stage, enabled: false } : stage,
    ),
  };
  const pipeline = compilePipeline('feature', withoutBusinessReview);

  it('walks past a disabled stage a transition names by hand', () => {
    // `code_review.approve_to` still says `business_review`; the task must land on the gate beyond.
    expect(interpret(pipeline, completed('code_review', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'rebase_gate',
    });
  });

  it('walks past a disabled stage on fall-through too', () => {
    const noArchitecture = compilePipeline('feature', {
      stages: FEATURE_TEMPLATE.stages.map((stage) =>
        stage.id === 'architecture' ? { ...stage, enabled: false } : stage,
      ),
    });
    expect(interpret(noArchitecture, completed('refinement', 'approve'))).toEqual({
      kind: 'enter',
      stage: 'implementation',
    });
  });

  it('completes rather than entering a disabled tail', () => {
    const stopAfterRetro = compilePipeline('feature', {
      stages: FEATURE_TEMPLATE.stages.map((stage) =>
        stage.id === 'done' ? { ...stage, enabled: false } : stage,
      ),
    });
    expect(interpret(stopAfterRetro, completed('retrospective', 'approve'))).toEqual({
      kind: 'complete',
      from: 'retrospective',
    });
  });

  it('escalates a return that a disabled target would turn into a forward jump', () => {
    const brokenReturn = compilePipeline('tail', {
      stages: [
        { id: 'implementation', kind: 'agent', role: 'developer', enabled: false },
        { id: 'code_review', kind: 'agent', role: 'reviewer', return_to: 'implementation' },
      ],
    });
    const decision = interpret(brokenReturn, completed('code_review', 'request_changes'));
    expect(decision.kind).toBe('escalate');
    expect(decision.kind === 'escalate' ? decision.reason : '').toContain('is disabled');
  });
});
