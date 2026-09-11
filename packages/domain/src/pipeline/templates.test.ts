import { pipelineFileSchema, pipelineGraphIssues } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PolicyViolationError } from '../errors.js';
import {
  assertValidTemplate,
  BUG_TEMPLATE,
  CHORE_TEMPLATE,
  FALLBACK_STAGE_AGENT_DEFAULTS,
  FEATURE_TEMPLATE,
  SHIPPED_TEMPLATES,
  stageAgentDefaults,
} from './templates.js';

describe('the shipped templates', () => {
  it.each(Object.entries(SHIPPED_TEMPLATES))(
    '%s parses as a `.agentic/pipeline.yml` template and has no graph issues',
    (id, template) => {
      // The templates are TypeScript literals, so nothing else would ever run the *schema* over
      // them — including the WP-15 gate check, which is the one rule a hand-written template is
      // most likely to break.
      expect(pipelineFileSchema.parse({ version: 1, templates: { [id]: template } })).toEqual({
        version: 1,
        templates: { [id]: template },
      });
      expect(pipelineGraphIssues(template)).toEqual([]);
    },
  );

  it('follows product/04: bug adds investigation, chore drops architecture and business review', () => {
    const ids = (template: typeof FEATURE_TEMPLATE) => template.stages.map((stage) => stage.id);
    expect(ids(FEATURE_TEMPLATE)).toEqual([
      'intake',
      'refinement',
      'architecture',
      'implementation',
      'ci_gate',
      'code_review',
      'business_review',
      'rebase_gate',
      'ready_for_merge',
      'merged_gate',
      'retrospective',
      'done',
    ]);
    expect(ids(BUG_TEMPLATE)).toContain('investigation');
    expect(ids(BUG_TEMPLATE).indexOf('investigation')).toBeLessThan(
      ids(BUG_TEMPLATE).indexOf('architecture'),
    );
    expect(ids(CHORE_TEMPLATE)).not.toContain('architecture');
    expect(ids(CHORE_TEMPLATE)).not.toContain('business_review');
  });

  it('sends every template through the same merge tail', () => {
    for (const template of Object.values(SHIPPED_TEMPLATES)) {
      const ids = template.stages.map((stage) => stage.id);
      expect(ids.slice(-5)).toEqual([
        'rebase_gate',
        'ready_for_merge',
        'merged_gate',
        'retrospective',
        'done',
      ]);
    }
  });

  it('wakes the human stage on exactly the three events product/04 S7 lists', () => {
    const readyForMerge = FEATURE_TEMPLATE.stages.find((stage) => stage.id === 'ready_for_merge');
    expect(readyForMerge?.kind).toBe('human');
    expect(readyForMerge?.kind === 'human' ? readyForMerge.on : []).toEqual([
      { on: 'mr.review.comment', to: 'implementation' },
      { on: 'default_branch.moved', to: 'rebase_gate' },
      { on: 'mr.merged', to: 'merged_gate' },
    ]);
  });
});

describe('stage agent defaults (product/04 § "Stage defaults", BD-013)', () => {
  it('gives implementation the 200-turn Opus budget and business review Sonnet', () => {
    expect(stageAgentDefaults('implementation')).toEqual({
      model: 'claude-opus-5',
      effort: 'high',
      maxTurns: 200,
    });
    expect(stageAgentDefaults('business_review').model).toBe('claude-sonnet-5');
  });

  it('falls back for a stage the table does not name', () => {
    expect(stageAgentDefaults('security_scan')).toEqual(FALLBACK_STAGE_AGENT_DEFAULTS);
  });
});

describe('assertValidTemplate', () => {
  it('accepts every shipped template', () => {
    for (const [id, template] of Object.entries(SHIPPED_TEMPLATES)) {
      expect(() => {
        assertValidTemplate(id, template);
      }).not.toThrow();
    }
  });

  it('refuses a malformed shape before it looks at the graph', () => {
    expect(() => {
      assertValidTemplate('broken', {
        // A gate the platform cannot resolve: no `on`, no `command`, not a built-in id. The graph
        // is fine — the *shape* is not, and the message has to say which half failed.
        stages: [{ id: 'security_scan', kind: 'gate' }],
      });
    }).toThrow(/is malformed/);
  });

  it('refuses a graph that points at a stage it does not contain', () => {
    let thrown: unknown;
    try {
      assertValidTemplate('broken', {
        stages: [{ id: 'ci_gate', kind: 'gate', on: 'ci.pipeline.finished', pass_to: 'nowhere' }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PolicyViolationError);
    expect((thrown as PolicyViolationError).message).toContain('nowhere');
    // Rule 10: "is invalid" and "is malformed" are two different branches of this function.
    expect((thrown as PolicyViolationError).message).toContain('is invalid');
  });

  it('reports every problem, not only the first', () => {
    let thrown: unknown;
    try {
      assertValidTemplate('broken', {
        stages: [
          { id: 'a', kind: 'agent', role: 'developer', next: 'nowhere' },
          { id: 'b', kind: 'agent', role: 'developer', next: 'elsewhere' },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PolicyViolationError).message).toContain('nowhere');
    expect((thrown as PolicyViolationError).message).toContain('elsewhere');
  });
});
