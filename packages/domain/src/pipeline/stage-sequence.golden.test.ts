/**
 * **No change without the stage** — WP-174 criterion (1) (BD-031, TD-029 decision 9).
 *
 * The `qa` stage went into the shared merge tail declared `enabled: false`, and `rebase_gate.pass_to`
 * moved onto it. The claim is that a task whose `qa_stage` is false walks exactly the pipeline it
 * walked before. This file holds the claim against `stage-sequence.golden.json`, which was
 * **recorded from the tree before the change** (at `88c38f2a`, with the three-argument
 * `compilePipeline`) and has not been regenerated since: a table recomputed from the changed code
 * would agree with itself whatever the change did.
 *
 * What the table is: for every shipped template, under no dial and under a dial that switches
 * business review off, the compiled pipeline's **enabled** stage order, and the decision the
 * interpreter gives for every signal at every stage the golden names — `start`, an agent's every
 * verdict, a gate's pass and fail, a human stage's every event the merge tail or the lifecycle
 * knows, and a failure. A decision is reduced to its kind, its target and its loop (an escalation's
 * prose is the interpreter's own wording, and is not what the criterion is about).
 *
 * The canary, measured at WP-174: default `qa_stage` to true and `rebase_gate`'s pass reads `qa`
 * instead of `ready_for_merge` in every ticket template, and this test fails.
 */
import { readFileSync } from 'node:fs';
import type { DomainEventType, TaskPipelineDial } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CompiledPipeline,
  compilePipeline,
  interpret,
  type PipelineDecision,
  type PipelineSignal,
} from './interpreter.js';
import { SHIPPED_TEMPLATES } from './templates.js';

const BUSINESS_REVIEW_OFF: TaskPipelineDial = {
  level: 'supervised',
  preset_version: 1,
  business_review: false,
  stop_after_stage: null,
};

const DIALS: Readonly<Record<string, TaskPipelineDial | null>> = {
  none: null,
  business_review_off: BUSINESS_REVIEW_OFF,
};

const VERDICTS: readonly (string | null)[] = [
  'approve',
  'request_changes',
  'reject',
  'questions',
  'pass',
  null,
];

const EVENTS: readonly DomainEventType[] = [
  'mr.review.comment',
  'mr.merged',
  'default_branch.moved',
  'ticket.status.changed',
  'ci.pipeline.finished',
  'task.breakdown.decided',
];

const summary = (decision: PipelineDecision): string => {
  switch (decision.kind) {
    case 'enter':
      return `enter ${decision.stage}`;
    case 'return':
      return `return ${decision.to} (${decision.loop})`;
    case 'complete':
      return 'complete';
    case 'wait':
      return 'wait';
    case 'escalate':
      return 'escalate';
  }
};

const signalsAt = (stage: string): readonly [string, PipelineSignal][] => [
  ...VERDICTS.map((verdict): [string, PipelineSignal] => [
    `completed:${verdict ?? 'null'}`,
    { kind: 'stage_completed', stage, verdict },
  ]),
  ...[true, false].map((passed): [string, PipelineSignal] => [
    `gate:${passed ? 'pass' : 'fail'}`,
    { kind: 'gate_settled', stage, passed, detail: 'x' },
  ]),
  ...EVENTS.map((event): [string, PipelineSignal] => [
    `event:${event}`,
    { kind: 'event', stage, event, detail: 'x' },
  ]),
  ['failed', { kind: 'stage_failed', stage, reason: 'x' }],
];

/** The table for one compiled pipeline, at the stage ids `stages` names. */
const tableOf = (
  pipeline: CompiledPipeline,
  stages: readonly string[],
): Record<string, unknown> => ({
  enabled: pipeline.stages.filter((stage) => stage.enabled).map((stage) => stage.id),
  start: summary(interpret(pipeline, { kind: 'start' })),
  at: Object.fromEntries(
    stages.map((stage) => [
      stage,
      Object.fromEntries(
        signalsAt(stage).map(([label, signal]) => [label, summary(interpret(pipeline, signal))]),
      ),
    ]),
  ),
});

type Golden = Record<string, Record<string, { readonly at: Record<string, unknown> }>>;

const golden = JSON.parse(
  readFileSync(new URL('./stage-sequence.golden.json', import.meta.url), 'utf8'),
) as Golden;

const compileWithoutQa = (id: string, dial: TaskPipelineDial | null): CompiledPipeline =>
  compilePipeline(id, SHIPPED_TEMPLATES[id] as never, dial, false);

describe('the stage sequence with qa_stage false (WP-174 criterion 1)', () => {
  const recorded = golden;

  it('names every shipped template and both dials', () => {
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(SHIPPED_TEMPLATES).sort());
    for (const dials of Object.values(recorded)) {
      expect(Object.keys(dials).sort()).toEqual(Object.keys(DIALS).sort());
    }
  });

  for (const [templateId, dials] of Object.entries(golden)) {
    for (const [dialName, expected] of Object.entries(dials)) {
      it(`${templateId} under dial "${dialName}" decides exactly what it decided before the qa stage`, () => {
        const pipeline = compileWithoutQa(templateId, DIALS[dialName] ?? null);
        expect(tableOf(pipeline, Object.keys(expected.at))).toEqual(expected);
      });
    }
  }
});
