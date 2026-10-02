import {
  type PipelineTemplate,
  pipelineFileSchema,
  pipelineGraphIssues,
  type Stage,
  type TaskPipelineDial,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PolicyViolationError } from '../errors.js';
import { DEFAULT_STAGE_RUN_BUDGET_USD, DEFAULT_TASK_BUDGET_USD } from '../policies/budgets.js';
import { DEFAULT_ITERATION_LIMITS } from '../policies/iteration-limits.js';
import { compilePipeline, interpret } from './interpreter.js';
import {
  assertValidTemplate,
  BUG_TEMPLATE,
  CHORE_TEMPLATE,
  DISCOVERY_TEMPLATE,
  EPIC_SPLIT_TEMPLATE,
  EPIC_SPLIT_TEMPLATE_ID,
  FALLBACK_STAGE_AGENT_DEFAULTS,
  FEATURE_TEMPLATE,
  HISTORY_BOOTSTRAP_TEMPLATE,
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
  REVIEW_ONLY_TEMPLATE,
  SHIPPED_TEMPLATES,
  SPIKE_HUMAN_STAGE,
  SPIKE_TEMPLATE,
  SPIKE_TEMPLATE_ID,
  stageAgentDefaults,
  TICKET_LINT_TEMPLATE,
  TICKET_TEMPLATES,
  unconfirmedCiExcuseIssue,
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
      // Declared between `implementation` and the CI gate and reachable only from
      // `rebase_gate.fail_to` (WP-26): the forward path names `ci_gate` explicitly.
      'conflict_resolution',
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
    // Every **ticket** template has the rebase gate's resolution stage and no other template does:
    // nothing outside the ticket flow opens a merge request, so nothing outside it can conflict.
    for (const [id, template] of Object.entries(SHIPPED_TEMPLATES)) {
      expect({ id, has: ids(template).includes('conflict_resolution') }).toEqual({
        id,
        has: Object.hasOwn(TICKET_TEMPLATES, id),
      });
    }
  });

  /**
   * WP-26. The graph property that makes the rebase gate's loop bounded and its stage free on the
   * happy path, asserted on the data rather than through the interpreter: the gate's failure goes
   * *backwards* into the resolution (so `returnTo` counts it) and the resolution sits *before* the
   * CI gate (so its fall-through re-runs CI).
   */
  it('places the conflict resolution behind the CI gate, with the rebase gate failing back into it', () => {
    for (const [id, template] of Object.entries(TICKET_TEMPLATES)) {
      const ids = template.stages.map((stage) => stage.id);
      const gate = template.stages.find((stage) => stage.id === 'rebase_gate');
      const implementation = template.stages.find((stage) => stage.id === 'implementation');
      expect({ id, failTo: gate && 'fail_to' in gate ? gate.fail_to : null }).toEqual({
        id,
        failTo: 'conflict_resolution',
      });
      expect({
        id,
        approveTo:
          implementation && 'approve_to' in implementation ? implementation.approve_to : null,
      }).toEqual({ id, approveTo: 'ci_gate' });
      expect({ id, before: ids.indexOf('conflict_resolution') < ids.indexOf('ci_gate') }).toEqual({
        id,
        before: true,
      });
      expect({
        id,
        behind: ids.indexOf('conflict_resolution') > ids.indexOf('implementation'),
      }).toEqual({ id, behind: true });
      expect({
        id,
        backwards: ids.indexOf('conflict_resolution') < ids.indexOf('rebase_gate'),
      }).toEqual({ id, backwards: true });
    }
  });

  it('ships the three ticket templates plus discovery, review-only, the linter, the history bootstrap and the two spikes, and nothing else', () => {
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
      'ticket_lint',
      'history_bootstrap',
      // WP-40. `spike` is in `BUILTIN_TEMPLATE_IDS` and was refused at WP-15; `epic_split` is its
      // opt-in variant and is a second template value because a stage's `produces` is data.
      'spike',
      'epic_split',
    ]);
    expect(SHIPPED_TEMPLATES.discovery).toBe(DISCOVERY_TEMPLATE);
    expect(SHIPPED_TEMPLATES.review_only).toBe(REVIEW_ONLY_TEMPLATE);
    expect(SHIPPED_TEMPLATES.ticket_lint).toBe(TICKET_LINT_TEMPLATE);
    expect(SHIPPED_TEMPLATES[HISTORY_BOOTSTRAP_TEMPLATE_ID]).toBe(HISTORY_BOOTSTRAP_TEMPLATE);
    expect(SHIPPED_TEMPLATES[SPIKE_TEMPLATE_ID]).toBe(SPIKE_TEMPLATE);
    expect(SHIPPED_TEMPLATES[EPIC_SPLIT_TEMPLATE_ID]).toBe(EPIC_SPLIT_TEMPLATE);
  });

  /**
   * product/04:117's spike, clause by clause — *"`Intake → Refinement → Architecture (produces a
   * document instead of a plan) → Human`"* and *"No MR"* — and the variant's one difference.
   *
   * Both halves are asserted (standing rule 42): the document instead of the plan, **and** the
   * absence of everything a merge request needs. Without the second half a spike that quietly kept
   * the merge tail would pass on the first.
   */
  it('gives both spikes product/04:117’s shape: a document, a human, and no merge request', () => {
    for (const [id, template] of [
      [SPIKE_TEMPLATE_ID, SPIKE_TEMPLATE],
      [EPIC_SPLIT_TEMPLATE_ID, EPIC_SPLIT_TEMPLATE],
    ] as const) {
      const ids = template.stages.map((stage) => stage.id);
      expect({ id, ids }).toEqual({
        id,
        ids: ['intake', 'refinement', 'architecture', SPIKE_HUMAN_STAGE, 'done'],
      });
      const architecture = template.stages.find((stage) => stage.id === 'architecture');
      expect({
        id,
        produces: architecture && 'produces' in architecture ? architecture.produces : null,
      }).toEqual({
        id,
        produces: id === SPIKE_TEMPLATE_ID ? 'ResearchReport' : 'TicketBreakdown',
      });
      // "No MR": not one of the stages a merge request needs, in either direction.
      for (const absent of [
        'implementation',
        'conflict_resolution',
        'ci_gate',
        'code_review',
        'business_review',
        'rebase_gate',
        'ready_for_merge',
        'merged_gate',
        'retrospective',
        'librarian',
      ]) {
        expect({ id, absent, present: ids.includes(absent) }).toEqual({
          id,
          absent,
          present: false,
        });
      }
      const human = template.stages.find((stage) => stage.id === SPIKE_HUMAN_STAGE);
      expect(human?.kind).toBe('human');
    }
    // The variant's one behavioural difference: the human stage has something that ends it, and the
    // plain spike's rests until a person acts. Both directions, because a template whose human
    // stage subscribed to nothing *and* one that advanced on the run's verdict would otherwise look
    // alike from the outside.
    const spikeHuman = SPIKE_TEMPLATE.stages.find((stage) => stage.id === SPIKE_HUMAN_STAGE);
    const splitHuman = EPIC_SPLIT_TEMPLATE.stages.find((stage) => stage.id === SPIKE_HUMAN_STAGE);
    expect(spikeHuman && 'on' in spikeHuman ? spikeHuman.on : null).toEqual([]);
    expect(splitHuman && 'on' in splitHuman ? splitHuman.on : null).toEqual([
      { on: 'task.breakdown.decided', to: 'done' },
    ]);
  });

  /**
   * `advisory` suppresses the artifact's verdict channel, so a stage that carried it by accident
   * would stop escalating a `reject` and stop waiting on a blocking question. The set is therefore
   * enumerated rather than sampled (standing rule 68), in both directions: exactly one stage of
   * exactly one shipped template has it.
   */
  it('marks the linter’s stage advisory and no other stage of any shipped template', () => {
    const advisory = Object.entries(SHIPPED_TEMPLATES).flatMap(([id, template]) =>
      template.stages
        .filter((stage) => 'advisory' in stage && stage.advisory === true)
        .map((stage) => `${id}.${stage.id}`),
    );
    expect(advisory).toEqual(['ticket_lint.ticket_lint']);
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

    const pipeline = compilePipeline('review_only', REVIEW_ONLY_TEMPLATE, null);
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

  it('runs a history bootstrap as one agent stage between two system stages, producing findings', () => {
    expect(HISTORY_BOOTSTRAP_TEMPLATE.stages.map((stage) => stage.id)).toEqual([
      'intake',
      'history_mining',
      'done',
    ]);
    const stage = HISTORY_BOOTSTRAP_TEMPLATE.stages[1];
    expect(stage?.kind).toBe('agent');
    expect(stage?.kind === 'agent' ? stage.role : null).toBe('historian');
    expect(stage?.kind === 'agent' ? stage.produces : null).toBe('HistoryFindings');
    // Like discovery: it reaches no merge request, so the merge-tail claim stays about three.
    expect(HISTORY_BOOTSTRAP_TEMPLATE.stages.map((stage) => stage.id)).not.toContain(
      'ready_for_merge',
    );
    // And it requires no prior artifact: the batch it mines is `tasks.history_sample`, written by
    // the same insert that created the task, not something an earlier stage produced.
    expect(stage?.kind === 'agent' ? stage.requires : null).toEqual([]);
  });

  it('gives the mining stage the Sonnet defaults product/19 §18 names, at ten turns', () => {
    expect(stageAgentDefaults('history_mining')).toEqual({
      model: 'claude-sonnet-5',
      effort: 'medium',
      maxTurns: 10,
    });
    expect(stageAgentDefaults('history_mining')).not.toEqual(FALLBACK_STAGE_AGENT_DEFAULTS);
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

describe('the conflict-resolution bound (PROGRESS backlog 66)', () => {
  it('states the conflict-resolution bound beside the stage', () => {
    // The agent stages a resolution re-runs, read off the template rather than listed: the
    // resolution itself, then its fall-through into `ci_gate` and the review tail up to the gate
    // that sent it there.
    const ids = FEATURE_TEMPLATE.stages.map((stage) => stage.id);
    const tail = FEATURE_TEMPLATE.stages
      .slice(ids.indexOf('conflict_resolution'), ids.indexOf('rebase_gate'))
      .filter((stage) => stage.kind === 'agent')
      .map((stage) => stage.id);
    expect(tail).toEqual(['conflict_resolution', 'code_review', 'business_review']);
    const perResolution = tail.reduce(
      (sum, id) => sum + (DEFAULT_STAGE_RUN_BUDGET_USD[id] ?? Number.NaN),
      0,
    );
    // The two figures `CONFLICT_RESOLUTION_STAGE`'s docblock states. A constant that moves under
    // them fails here, and the docblock moves with it.
    expect(perResolution * DEFAULT_ITERATION_LIMITS.rebase).toBe(26);
    expect(DEFAULT_TASK_BUDGET_USD).toBe(50);
    expect(DEFAULT_ITERATION_LIMITS.rebase).toBe(2);
    expect(DEFAULT_ITERATION_LIMITS.code_review).toBe(3);
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

/** The one dial that disables a shipped stage (`business_review`); the other fields do not compile in. */
const BUSINESS_REVIEW_OFF: TaskPipelineDial = {
  level: 'autonomous',
  preset_version: 1,
  business_review: false,
  stop_after_stage: null,
};

describe('the rebase gate behind every CI gate (WP-81, Q109)', () => {
  // WP-81's provisional tamper pass excuses a declared protected path until the Code review
  // confirms it, and since WP-102 (Q109 (b)) the rebase gate's settlement is where that
  // confirmation is read before Ready. That holds only while every template that runs `ci_gate`
  // also runs `rebase_gate` after it — under every dial, since the dial is the one thing that
  // disables a shipped stage — so a template that drops the rebase gate fails here, by name.
  it.each(
    Object.entries(SHIPPED_TEMPLATES).flatMap(([id, template]) =>
      [null, BUSINESS_REVIEW_OFF].map(
        (dial) => [id, JSON.stringify(dial), template, dial] as const,
      ),
    ),
  )('%s (dial %s) runs rebase_gate after an enabled ci_gate', (id, _label, template, dial) => {
    const { stages } = compilePipeline(id, template, dial);
    const ci = stages.findIndex((stage) => stage.id === 'ci_gate' && stage.enabled);
    if (ci === -1) {
      return;
    }
    const rebase = stages.findIndex((stage) => stage.id === 'rebase_gate' && stage.enabled);
    expect(rebase).toBeGreaterThan(ci);
  });
});

/** `template` with each named stage written `enabled: false`, the shape a `stages.<s>.enabled` reader produces. */
const disabling = (template: PipelineTemplate, ids: readonly string[]): PipelineTemplate => ({
  ...template,
  stages: template.stages.map((stage) =>
    ids.includes(stage.id) ? { ...stage, enabled: false } : stage,
  ),
});

const refusalOf = (id: string, template: PipelineTemplate): string => {
  try {
    assertValidTemplate(id, template);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyViolationError);
    return (error as PolicyViolationError).message;
  }
  throw new Error(`template "${id}" was accepted`);
};

describe('a CI excuse nothing would confirm is refused (WP-120, PROGRESS backlog 338)', () => {
  // WP-81's provisional CI pass records the protected paths it excused, and the rebase gate's
  // settlement is the only reader that compares them with the Code review (WP-102). A template
  // that runs `ci_gate` without `rebase_gate` after it falls through into Ready with the excuse
  // never confirmed, so `assertValidTemplate` refuses it — before a reader of
  // `stages.<s>.enabled` (backlog 220) can make the shape reachable.
  it.each(Object.keys(TICKET_TEMPLATES))(
    'refuses %s with rebase_gate disabled while ci_gate is enabled, naming both stages',
    (id) => {
      const message = refusalOf(
        id,
        disabling(TICKET_TEMPLATES[id] as PipelineTemplate, ['rebase_gate']),
      );
      expect(message).toContain(`template "${id}" is refused`);
      expect(message).toContain('"rebase_gate" is disabled while "ci_gate" is enabled');
      expect(message).toContain('no Code review confirming it');
    },
  );

  it('refuses it at compilePipeline too, which every reader of a task’s template goes through', () => {
    expect(() =>
      compilePipeline('feature', disabling(FEATURE_TEMPLATE, ['rebase_gate']), null),
    ).toThrow(/"rebase_gate" is disabled while "ci_gate" is enabled/);
  });

  it('refuses the same fall-through when rebase_gate is missing or declared before ci_gate', () => {
    const missing: PipelineTemplate = {
      ...FEATURE_TEMPLATE,
      stages: FEATURE_TEMPLATE.stages
        .filter((stage) => stage.id !== 'rebase_gate')
        .map((stage): Stage => {
          if (stage.id === 'business_review') {
            return { ...stage, approve_to: 'ready_for_merge' } as Stage;
          }
          if (stage.kind === 'human' && stage.id === 'ready_for_merge') {
            return { ...stage, on: stage.on.filter((edge) => edge.to !== 'rebase_gate') };
          }
          return stage;
        }),
    };
    expect(pipelineGraphIssues(missing)).toEqual([]);
    expect(refusalOf('feature', missing)).toContain(
      '"rebase_gate" is not declared while "ci_gate" is enabled',
    );

    const rebase = FEATURE_TEMPLATE.stages.find((stage) => stage.id === 'rebase_gate') as Stage;
    const ciIndex = FEATURE_TEMPLATE.stages.findIndex((stage) => stage.id === 'ci_gate');
    const rest = FEATURE_TEMPLATE.stages.filter((stage) => stage.id !== 'rebase_gate');
    const before: PipelineTemplate = {
      ...FEATURE_TEMPLATE,
      stages: [...rest.slice(0, ciIndex), rebase, ...rest.slice(ciIndex)],
    };
    expect(refusalOf('feature', before)).toContain(
      '"rebase_gate" is declared before "ci_gate" while "ci_gate" is enabled',
    );
  });

  it('accepts a template that disables both gates, because nothing then excuses a path', () => {
    for (const [id, template] of Object.entries(TICKET_TEMPLATES)) {
      expect(() => {
        assertValidTemplate(id, disabling(template, ['ci_gate', 'rebase_gate']));
      }, id).not.toThrow();
      expect(unconfirmedCiExcuseIssue(disabling(template, ['ci_gate']))).toBeNull();
    }
  });

  it('accepts every shipped template as shipped', () => {
    for (const template of Object.values(SHIPPED_TEMPLATES)) {
      expect(unconfirmedCiExcuseIssue(template)).toBeNull();
    }
  });
});
