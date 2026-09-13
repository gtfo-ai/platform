import { pipelineFileSchema, pipelineGraphIssues } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PolicyViolationError } from '../errors.js';
import { compilePipeline, interpret } from './interpreter.js';
import {
  assertValidTemplate,
  BUG_TEMPLATE,
  CHORE_TEMPLATE,
  DISCOVERY_TEMPLATE,
  FALLBACK_STAGE_AGENT_DEFAULTS,
  FEATURE_TEMPLATE,
  REVIEW_ONLY_TEMPLATE,
  SHIPPED_TEMPLATES,
  stageAgentDefaults,
  TICKET_TEMPLATES,
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
      'librarian',
      'done',
    ]);
    expect(ids(BUG_TEMPLATE)).toContain('investigation');
    expect(ids(BUG_TEMPLATE).indexOf('investigation')).toBeLessThan(
      ids(BUG_TEMPLATE).indexOf('architecture'),
    );
    expect(ids(CHORE_TEMPLATE)).not.toContain('architecture');
    expect(ids(CHORE_TEMPLATE)).not.toContain('business_review');
  });

  it('ships the three ticket templates plus discovery and review-only, and nothing else', () => {
    // The two maps are asserted against each other rather than each against a literal: `discovery`
    // is deliberately outside `TICKET_TEMPLATES` (it opens no merge request), and the case below
    // relies on that split being exactly this one.
    expect(Object.keys(TICKET_TEMPLATES)).toEqual(['feature', 'bug', 'chore']);
    expect(Object.keys(SHIPPED_TEMPLATES)).toEqual([
      'feature',
      'bug',
      'chore',
      'discovery',
      'review_only',
    ]);
    expect(SHIPPED_TEMPLATES.discovery).toBe(DISCOVERY_TEMPLATE);
    expect(SHIPPED_TEMPLATES.review_only).toBe(REVIEW_ONLY_TEMPLATE);
  });

  /**
   * The other direction of "sends every ticket template through the same merge tail", below.
   *
   * It used to be one `expect(visited).toContain('librarian')` inside the interpreter's whole-task
   * walk, which was written when that walk ran over three hand-listed templates. The walk now runs
   * over **every** shipped template (standing rule 7), where the sentence is simply false — so the
   * claim moved here, to the file that knows which templates have a tail, and it is asserted in
   * both directions (standing rule 42).
   */
  it('gives neither non-ticket template a merge tail', () => {
    for (const template of [DISCOVERY_TEMPLATE, REVIEW_ONLY_TEMPLATE]) {
      const stageIds = template.stages.map((stage) => stage.id);
      expect(stageIds).not.toContain('ready_for_merge');
      expect(stageIds).not.toContain('librarian');
      expect(stageIds).not.toContain('rebase_gate');
    }
  });

  /**
   * product/18: *"a neutral summary that **never blocks merge**"*.
   *
   * The interpreter reads a missing `return_to` as "escalate", so a review-only template without
   * one would park every merge request the Reviewer had a finding about in `needs_human`. Both
   * verdicts therefore point at `done`, and because `done` is *later* in declaration order the
   * interpreter's rule 2 makes each an **advance** rather than a counted return — asserted here
   * against `interpret` rather than read off the data, because "later in declaration order" is the
   * property that makes it true and a reordering would break it silently.
   */
  it('sends both review verdicts forward, so a review-only task never blocks on a finding', () => {
    expect(REVIEW_ONLY_TEMPLATE.stages.map((stage) => stage.id)).toEqual([
      'intake',
      'code_review',
      'done',
    ]);
    const stage = REVIEW_ONLY_TEMPLATE.stages[1];
    expect(stage?.kind).toBe('agent');
    expect(stage?.kind === 'agent' ? stage.role : null).toBe('reviewer');
    expect(stage?.kind === 'agent' ? stage.produces : null).toBe('ReviewVerdict');

    const pipeline = compilePipeline('review_only', REVIEW_ONLY_TEMPLATE);
    for (const verdict of ['approve', 'request_changes'] as const) {
      const decision = interpret(pipeline, {
        kind: 'stage_completed',
        stage: 'code_review',
        verdict,
      });
      expect(decision, verdict).toEqual({ kind: 'enter', stage: 'done' });
    }
  });

  it('runs discovery as one agent stage between two system stages, producing a draft', () => {
    expect(DISCOVERY_TEMPLATE.stages.map((stage) => stage.id)).toEqual([
      'intake',
      'discovery',
      'done',
    ]);
    const stage = DISCOVERY_TEMPLATE.stages[1];
    expect(stage?.kind).toBe('agent');
    expect(stage?.kind === 'agent' ? stage.role : null).toBe('discovery');
    expect(stage?.kind === 'agent' ? stage.produces : null).toBe('DiscoveryDraft');
    // The other direction of the merge-tail case (rule 10): discovery reaches no merge request, so
    // "every ticket template ends in the tail" is a claim about three templates and not four.
    expect(DISCOVERY_TEMPLATE.stages.map((stage) => stage.id)).not.toContain('ready_for_merge');
  });

  it('sends every ticket template through the same merge tail', () => {
    for (const template of Object.values(TICKET_TEMPLATES)) {
      const ids = template.stages.map((stage) => stage.id);
      expect(ids.slice(-6)).toEqual([
        'rebase_gate',
        'ready_for_merge',
        'merged_gate',
        'retrospective',
        'librarian',
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

  it('gives discovery the cheap Sonnet defaults product/06 asks for', () => {
    expect(stageAgentDefaults('discovery')).toEqual({
      model: 'claude-sonnet-5',
      effort: 'medium',
      maxTurns: 40,
    });
    expect(stageAgentDefaults('discovery')).not.toEqual(FALLBACK_STAGE_AGENT_DEFAULTS);
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
