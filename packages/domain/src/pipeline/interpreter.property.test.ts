/**
 * Properties of the pipeline interpreter (technical/10: property tests for the state machines).
 *
 * The example tests beside this file pin the transitions product/04 documents. These pin the
 * things that must hold for *every* signal and every enabled/disabled combination, which is where
 * a template a project wrote — rather than one this repository ships — will land.
 *
 * The walk in the last block is the one that earns its keep: it drives a task through the template
 * with arbitrary verdicts while keeping the same iteration counters the Task aggregate keeps, and
 * asserts technical/02's invariant directly — "iteration counters never exceed their limits
 * without a `task.escalated` event" — plus the thing that invariant exists for: the walk stops.
 */
import type { PipelineTemplate } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ITERATION_LIMITS,
  evaluateIteration,
  ITERATION_LOOPS,
  type IterationCounters,
  incrementIteration,
} from '../policies/iteration-limits.js';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type CompiledPipeline,
  compilePipeline,
  interpret,
  type PipelineDecision,
  type PipelineSignal,
  stageOf,
} from './interpreter.js';
import { BUG_TEMPLATE, CHORE_TEMPLATE, FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from './templates.js';

const TEMPLATES: readonly [string, PipelineTemplate][] = [
  ['feature', FEATURE_TEMPLATE],
  ['bug', BUG_TEMPLATE],
  ['chore', CHORE_TEMPLATE],
];

const compiled = TEMPLATES.map(([id, template]) => compilePipeline(id, template));

/**
 * Every stage id of a template, plus ids that are not in it.
 *
 * The foreign ids used to include `librarian`, which stopped being foreign at WP-18b when the stage
 * went back into the shipped tail — a comment that says "ids that are not in it" has to name ids
 * that are not in it (standing rule 83). `docs_update` is technical/12's own custom-stage example
 * and is in no shipped template.
 */
const stageIdArbitrary = (pipeline: CompiledPipeline) =>
  fc.oneof(
    fc.constantFrom(...pipeline.stages.map((stage) => stage.id)),
    fc.constantFrom('not_a_stage', 'docs_update', 'spike'),
  );

/** Every verdict the vocabulary has, plus values a model might really emit instead. */
const verdictArbitrary = fc.oneof(
  fc.constantFrom<string | null>(
    'approve',
    'request_changes',
    'reject',
    'questions',
    'pass',
    'fail',
  ),
  fc.constantFrom<string | null>(
    null,
    '',
    'APPROVE',
    'looks fine',
    'approve ',
    '{"verdict":"approve"}',
  ),
  fc.string(),
);

const signalArbitrary = (pipeline: CompiledPipeline): fc.Arbitrary<PipelineSignal> =>
  fc.oneof(
    fc.constant<PipelineSignal>({ kind: 'start' }),
    fc.record({
      kind: fc.constant<'stage_completed'>('stage_completed'),
      stage: stageIdArbitrary(pipeline),
      verdict: verdictArbitrary,
    }),
    fc.record({
      kind: fc.constant<'gate_settled'>('gate_settled'),
      stage: stageIdArbitrary(pipeline),
      passed: fc.boolean(),
      detail: fc.string(),
    }),
    fc.record({
      kind: fc.constant<'event'>('event'),
      stage: stageIdArbitrary(pipeline),
      event: fc.constantFrom(
        'mr.merged' as const,
        'mr.review.comment' as const,
        'default_branch.moved' as const,
        'ci.pipeline.finished' as const,
        'task.paused' as const,
      ),
      detail: fc.string(),
    }),
    fc.record({
      kind: fc.constant<'stage_failed'>('stage_failed'),
      stage: stageIdArbitrary(pipeline),
      reason: fc.string(),
    }),
  );

const namedStage = (decision: PipelineDecision): string | null => {
  switch (decision.kind) {
    case 'enter':
      return decision.stage;
    case 'return':
      return decision.to;
    case 'wait':
      return decision.stage;
    default:
      return null;
  }
};

describe.each(compiled.map((pipeline) => [pipeline.templateId, pipeline] as const))(
  'interpreter properties — %s',
  (_id, pipeline) => {
    const known = new Set(pipeline.stages.map((stage) => stage.id));

    it(
      'answers every signal with a decision and never throws',
      () => {
        fc.assert(
          fc.property(signalArbitrary(pipeline), (signal) => {
            const decision = interpret(pipeline, signal);
            expect(
              ['enter', 'return', 'wait', 'escalate', 'complete'].includes(decision.kind),
            ).toBe(true);
          }),
        );
      },
      PROPERTY_TEST_TIMEOUT_MS,
    );

    it(
      'never names a stage the template does not contain',
      () => {
        fc.assert(
          fc.property(signalArbitrary(pipeline), (signal) => {
            const stage = namedStage(interpret(pipeline, signal));
            if (stage !== null) {
              expect(known.has(stage)).toBe(true);
            }
          }),
        );
      },
      PROPERTY_TEST_TIMEOUT_MS,
    );

    it(
      'only ever returns backwards, and always to a counted loop',
      () => {
        const indexOf = (id: string) => pipeline.stages.findIndex((stage) => stage.id === id);
        fc.assert(
          fc.property(signalArbitrary(pipeline), (signal) => {
            const decision = interpret(pipeline, signal);
            if (decision.kind !== 'return') {
              return;
            }
            expect(indexOf(decision.to)).toBeLessThan(indexOf(decision.from));
            expect(ITERATION_LOOPS).toContain(decision.loop);
            expect(decision.escalationBrief.length).toBeGreaterThan(0);
          }),
        );
      },
      PROPERTY_TEST_TIMEOUT_MS,
    );

    it(
      'never enters a disabled stage, whichever stages are disabled',
      () => {
        const template = SHIPPED_TEMPLATES[pipeline.templateId] as PipelineTemplate;
        fc.assert(
          fc.property(
            fc.subarray(template.stages.map((stage) => stage.id)),
            signalArbitrary(pipeline),
            (disabled, signal) => {
              const disabledSet = new Set(disabled);
              const variant = compilePipeline(pipeline.templateId, {
                stages: template.stages.map((stage) =>
                  disabledSet.has(stage.id) ? { ...stage, enabled: false } : stage,
                ),
              });
              const decision = interpret(variant, signal);
              const target =
                decision.kind === 'enter'
                  ? decision.stage
                  : decision.kind === 'return'
                    ? decision.to
                    : null;
              if (target !== null) {
                expect(stageOf(variant, target)?.enabled).toBe(true);
              }
            },
          ),
        );
      },
      PROPERTY_TEST_TIMEOUT_MS,
    );
  },
);

/**
 * A whole task, walked.
 *
 * `stop` is why this is not just a loop: the walk carries the Task aggregate's own counters and
 * applies the same `evaluateIteration` the aggregate applies, so "the limits are never exceeded"
 * is asserted against the real policy rather than a paraphrase of it. A pipeline that could loop
 * for ever shows up here as the step budget running out.
 */
describe('a whole task, walked with arbitrary verdicts', () => {
  const LIMITS = DEFAULT_ITERATION_LIMITS;
  /** Longest legal walk: every stage once per allowed round of every loop, plus slack. */
  const MAX_STEPS =
    FEATURE_TEMPLATE.stages.length *
      (Object.values(LIMITS).reduce((total, limit) => total + limit, 0) + 1) +
    16;

  const signalFor = (
    pipeline: CompiledPipeline,
    stage: string,
    verdict: string,
    passed: boolean,
    event: 'mr.merged' | 'mr.review.comment',
  ): PipelineSignal => {
    const kind = stageOf(pipeline, stage)?.kind;
    if (kind === 'gate') {
      return { kind: 'gate_settled', stage, passed, detail: 'walked' };
    }
    if (kind === 'human') {
      return { kind: 'event', stage, event, detail: 'walked' };
    }
    return { kind: 'stage_completed', stage, verdict: kind === 'system' ? null : verdict };
  };

  /**
   * The approving path **finishes**, for every shipped template.
   *
   * The arbitrary walk below admits `wait` and `escalate` as endings, which is right — they are how
   * a pipeline legitimately stops — and it is also why that walk alone cannot see a template that
   * parks *every* task one stage short of `done`. That is the exact failure WP-15 predicted for a
   * `librarian` stage with no executor, and the reason the stage was cut then and is back now. So
   * this one drives the happy path deterministically and insists on `complete`, parameterised over
   * the same three templates (standing rule 68).
   */
  it.each(compiled.map((pipeline) => [pipeline.templateId, pipeline] as const))(
    'reaches `complete` on %s when every stage approves and every gate passes',
    (_id, pipeline) => {
      const visited: string[] = [];
      let decision = interpret(pipeline, { kind: 'start' });
      let steps = 0;
      while (decision.kind === 'enter' && steps < MAX_STEPS) {
        visited.push(decision.stage);
        steps += 1;
        decision = interpret(
          pipeline,
          signalFor(pipeline, decision.stage, 'approve', true, 'mr.merged'),
        );
      }
      expect(decision).toEqual({ kind: 'complete', from: 'done' });
      // …through every stage the template declares, in order: a walk that skipped the tail would
      // also "complete" (standing rule 10).
      expect(visited).toEqual(pipeline.stages.map((stage) => stage.id));
      expect(visited).toContain('librarian');
    },
  );

  it.each(compiled.map((pipeline) => [pipeline.templateId, pipeline] as const))(
    'terminates on %s without any counter passing its limit',
    (_id, pipeline) => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              verdict: fc.constantFrom('approve', 'request_changes', 'reject', 'questions'),
              passed: fc.boolean(),
              event: fc.constantFrom('mr.merged' as const, 'mr.review.comment' as const),
            }),
            { minLength: 1, maxLength: 60 },
          ),
          (script) => {
            let counters: IterationCounters = {};
            let decision = interpret(pipeline, { kind: 'start' });
            let steps = 0;
            let ended: PipelineDecision['kind'] | null = null;

            while (steps < MAX_STEPS) {
              if (decision.kind !== 'enter') {
                ended = decision.kind;
                break;
              }
              const move = script[steps % script.length];
              if (move === undefined) {
                break;
              }
              steps += 1;
              const next = interpret(
                pipeline,
                signalFor(pipeline, decision.stage, move.verdict, move.passed, move.event),
              );
              if (next.kind === 'return') {
                const iteration = evaluateIteration(counters, next.loop, LIMITS);
                if (!iteration.allowed) {
                  // What `returnToStage` does: the counter stays where it is and the task
                  // escalates, which is why no counter can ever pass its limit.
                  ended = 'escalate';
                  break;
                }
                counters = incrementIteration(counters, next.loop);
                decision = { kind: 'enter', stage: next.to };
                continue;
              }
              decision = next;
            }

            for (const loop of ITERATION_LOOPS) {
              expect(counters[loop] ?? 0).toBeLessThanOrEqual(LIMITS[loop]);
            }
            // Rule 10: "it did not blow the step budget" is true of a walk that never moved. The
            // walk has to have *finished*, in one of the three ways a pipeline can finish.
            expect(ended === null ? `ran ${steps} steps without ending` : ended).toMatch(
              /^(complete|escalate|wait)$/,
            );
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
