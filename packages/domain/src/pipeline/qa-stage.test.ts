/**
 * The human `qa` stage with `qa_stage` true — WP-174 criterion (2) (BD-031, TD-029 decision 9,
 * technical/02's M10-head amendment, product/04 S6c).
 *
 * Asserted over every ticket template, because the stage lives in the shared merge tail, and each
 * edge from both sides where a side exists: the stage is entered only when the task has it, and the
 * rest of the pipeline is unchanged by it.
 */
import { describe, expect, it } from 'vitest';
import { compilePipeline, interpret, type PipelineSignal, stageOf } from './interpreter.js';
import { QA_STAGE_ID, SHIPPED_TEMPLATES, TICKET_TEMPLATES } from './templates.js';

const withQa = (id: string) => compilePipeline(id, TICKET_TEMPLATES[id] as never, null, true);
const withoutQa = (id: string) => compilePipeline(id, TICKET_TEMPLATES[id] as never, null, false);

const atQa = (event: Extract<PipelineSignal, { kind: 'event' }>['event']): PipelineSignal => ({
  kind: 'event',
  stage: QA_STAGE_ID,
  event,
  detail: 'x',
});

const rebasePassed: PipelineSignal = {
  kind: 'gate_settled',
  stage: 'rebase_gate',
  passed: true,
  detail: 'x',
};

describe.each(Object.keys(TICKET_TEMPLATES))('the qa stage on %s (WP-174 criterion 2)', (id) => {
  it('is declared, human and disabled, and enabled only by qa_stage', () => {
    expect(stageOf(withoutQa(id), QA_STAGE_ID)).toMatchObject({ kind: 'human', enabled: false });
    expect(stageOf(withQa(id), QA_STAGE_ID)).toMatchObject({ kind: 'human', enabled: true });
    expect(withQa(id).qaStage).toBe(true);
    expect(withoutQa(id).qaStage).toBe(false);
  });

  it('a pass of rebase_gate leads to qa, and to ready_for_merge without it', () => {
    expect(interpret(withQa(id), rebasePassed)).toEqual({ kind: 'enter', stage: 'qa' });
    expect(interpret(withoutQa(id), rebasePassed)).toEqual({
      kind: 'enter',
      stage: 'ready_for_merge',
    });
  });

  it('ticket.status.changed (a pass) leads to ready_for_merge, and is not a return', () => {
    expect(interpret(withQa(id), atQa('ticket.status.changed'))).toEqual({
      kind: 'enter',
      stage: 'ready_for_merge',
    });
  });

  it('mr.review.comment (every return form) leads to implementation and spends human_rounds', () => {
    expect(interpret(withQa(id), atQa('mr.review.comment'))).toMatchObject({
      kind: 'return',
      from: 'qa',
      to: 'implementation',
      loop: 'human_rounds',
    });
  });

  it('default_branch.moved leads to rebase_gate and spends rebase_rechecks, not a human round', () => {
    expect(interpret(withQa(id), atQa('default_branch.moved'))).toMatchObject({
      kind: 'return',
      from: 'qa',
      to: 'rebase_gate',
      loop: 'rebase_rechecks',
    });
  });

  it('mr.merged leads to merged_gate', () => {
    expect(interpret(withQa(id), atQa('mr.merged'))).toEqual({
      kind: 'enter',
      stage: 'merged_gate',
    });
  });

  it('waits on an event it does not subscribe to', () => {
    expect(interpret(withQa(id), atQa('ci.pipeline.finished'))).toMatchObject({ kind: 'wait' });
  });

  it('changes nothing else: every other stage is enabled exactly as without it', () => {
    const others = (enabled: boolean) =>
      (enabled ? withQa(id) : withoutQa(id)).stages
        .filter((stage) => stage.id !== QA_STAGE_ID)
        .map((stage) => [stage.id, stage.enabled]);
    expect(others(true)).toEqual(others(false));
  });
});

describe('the templates without a merge tail', () => {
  it('declare no qa stage — spike, epic split, review-only and discovery are unchanged', () => {
    for (const [id, template] of Object.entries(SHIPPED_TEMPLATES)) {
      if (Object.hasOwn(TICKET_TEMPLATES, id)) continue;
      expect({ id, qa: template.stages.some((stage) => stage.id === QA_STAGE_ID) }).toEqual({
        id,
        qa: false,
      });
    }
  });

  it('leaves a project template’s non-human stage named qa as declared', () => {
    const custom = {
      stages: [
        { id: 'intake', kind: 'system' as const },
        {
          id: 'qa',
          kind: 'agent' as const,
          role: 'developer' as const,
          produces: 'ImplementationNotes' as const,
          requires: [],
          enabled: false,
        },
        { id: 'done', kind: 'system' as const },
      ],
    };
    expect(stageOf(compilePipeline('custom', custom, null, true), 'qa')?.enabled).toBe(false);
  });
});
