/**
 * WP-15a's acceptance criterion: **a ticket reaches `task.completed` through an `apps/server`
 * instance**, with its integration bindings read from the database.
 *
 * WP-15 proved the loop against a runtime this file composed itself. That left the product's own
 * composition root untested and `PipelineIntegrations` with no production constructor, so the thing
 * being demonstrated was the pipeline package rather than the platform. `startPipeline` now starts
 * a real instance and seeds `integrations`, `secrets` and `bindings` **rows**; the adapters the
 * stages call are built by the production loader from those rows, with the credential decrypted
 * under the instance's own `APP_SECRET_KEY`.
 *
 * What that adds to WP-15's list: the outbox worker runs on its own timer and pg-boss runs the
 * stage jobs, so nothing here drives a drain — a transition that only happened because a harness
 * called a handler by hand would not happen at all. What it costs is determinism about *when*;
 * `settle` waits for a state and never asserts a duration (standing rule 2).
 *
 * Every stage of the templates is scripted, so what is exercised is the interpreter's transitions
 * and the saga's handlers, not the model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  type SeededWorld,
  startPipeline,
} from '../support/pipeline.js';

const REFINED_SPEC = {
  goal: 'Show the totals in the invoice footer.',
  user_value: 'Finance can read an invoice without a calculator.',
  in_scope: ['the invoice footer'],
  out_of_scope: ['the PDF export'],
  acceptance_criteria: [
    {
      id: 'ac1',
      given: 'an invoice with three lines',
      when: 'it is rendered',
      // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
      then: 'the footer shows the sum of the lines',
      validation: { kind: 'test', value: 'totals.test.ts' },
    },
  ],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: 'in the documented direction' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const ROOT_CAUSE = {
  reproduction: { kind: 'reproduced', steps: ['open an invoice'], evidence: ['sentry: TOTALS-1'] },
  root_cause: 'The footer sums the visible rows rather than all of them.',
  confidence: 'high',
  affected_scope: ['invoices'],
  fix_direction: 'Sum the model, not the view.',
  regression_test_idea: 'A three-line invoice with one row hidden.',
  questions: [],
};

const PLAN = {
  approach: 'Sum the invoice model in the renderer.',
  alternatives_considered: [{ option: 'sum in SQL', why_not: 'the view already has the model' }],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'sum the model' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'no flag needed',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};

/** The developer reports the merge request the provider gave it (`world.mr`). */
const notesFor = (world: SeededWorld) => ({
  summary: 'Summed the invoice model in the footer.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: '12 passed' }],
  known_gaps: [],
  followup_tickets: [],
  mr: {
    url: world.mr.url,
    iid: world.mr.iid,
    head_sha: world.mr.headSha,
    branch: world.branch,
  },
});

const REVIEW = {
  verdict: 'approve',
  findings: [],
  summary: 'Matches the plan; the test covers the criterion.',
  protected_path_changes_confirmed: [],
};

const ACCEPTANCE = {
  verdict: 'approve',
  criteria: [{ id: 'ac1', status: 'met', evidence: 'totals.test.ts passes on the head commit' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
};

const RETRO = {
  what_went_well: ['the plan held'],
  returns: [],
  human_corrections: [],
  cost_summary: {
    total_usd: 2,
    is_estimate: false,
    by_stage: [{ stage: 'implementation', usd: 0.4 }],
  },
  proposals: [],
};

const featureScenarios = (world: SeededWorld) => ({
  refinement: { structuredOutput: REFINED_SPEC },
  architecture: { structuredOutput: PLAN },
  implementation: { structuredOutput: notesFor(world) },
  code_review: { structuredOutput: REVIEW },
  business_review: { structuredOutput: ACCEPTANCE },
  retrospective: { structuredOutput: RETRO },
});

const bugScenarios = (world: SeededWorld) => ({
  ...featureScenarios(world),
  investigation: { structuredOutput: ROOT_CAUSE },
});

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The tickets the fake provider knows; the workpad is a comment on one of them. */
const TICKETS = [
  { key: 'ACME-1', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  { key: 'ACME-2', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  { key: 'ACME-9', title: 'The invoice footer sums the wrong rows', issueType: 'Bug' },
];

const ticketMatched = (pipeline: PipelineE2E, key: string, issueType: string) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: issueType,
    epic: null,
    links: [],
  });

const merged = (pipeline: PipelineE2E) =>
  inboundEvent('mr.merged', {
    project_id: pipeline.projectId,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: pipeline.world.branch,
      head_sha: pipeline.world.mr.headSha,
    },
    draft: false,
    head_sha: pipeline.world.mr.headSha,
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

describe('a feature ticket, end to end', () => {
  it('runs every stage, waits for the human merge, and finishes done', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature',
      tickets: TICKETS,
      // technical/12's `status_mapping`, so the ticket's own status moves with the task.
      config: { status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' } },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1', 'Story')]);

    // BD-007: the platform never merges. It stops here until a human does.
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.current_stage).toBe('ready_for_merge');

    await pipeline.publish([merged(pipeline)]);

    const finished = await pipeline.settle('done', (task) => task.state === 'done');
    expect(finished.template).toBe('feature');
    // Five agent stages at 0.40 USD each, on the row a human would read.
    expect(Number(finished.cost_actual)).toBeCloseTo(2.4, 6);

    const types = (await pipeline.events()).map((event) => event.type);
    expect(types.filter((type) => type === 'task.created')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.created')).toHaveLength(6);
    expect(types.filter((type) => type === 'artifact.created')).toHaveLength(6);
    expect(types).toContain('task.completed');
    expect(types).not.toContain('task.escalated');

    expect(pipeline.specs.map((spec) => spec.stage)).toEqual([
      'refinement',
      'architecture',
      'implementation',
      'code_review',
      'business_review',
      'retrospective',
    ]);
  });

  it('keeps one workpad comment on the ticket and moves the ticket status', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature-workpad',
      tickets: TICKETS,
      config: { status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' } },
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1', 'Story')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    const ticket = pipeline.tickets.peek('ACME-1');
    // BD-023: one sticky comment, however many times the task moved.
    expect(ticket?.comments).toHaveLength(1);
    expect(ticket?.comments[0]?.body).toContain('ACME-1');
    expect(ticket?.comments[0]?.body).toContain('ready_for_merge');
    // The last mapped state the task passed through.
    expect(ticket?.status).toBe('In Review');
  });

  it('leaves a readable trail: a stage row per attempt and an artifact per stage', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature-trail',
      tickets: TICKETS,
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline, 'ACME-2', 'Story')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    await pipeline.publish([merged(pipeline)]);
    await pipeline.settle('done', (task) => task.state === 'done');

    const stages = (await pipeline.events())
      .filter((event) => event.type === 'task.stage.entered')
      .map((event) => (event.payload as { stage: string }).stage);
    expect(stages).toEqual([
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
    ]);
  });
});

describe('when the merge request’s pipeline is red', () => {
  it('sends the task back to implementation and parks it, never reaching code review', async () => {
    // The gate that matters most, on the real path: `ci_gate` is a builtin, so the stage job polls
    // the provider whatever the template's `on` says. A failure branch that fell open here would
    // advance a task to code review on red CI — which is why this drives the fake provider's
    // *failed* pipeline rather than asserting the evaluator's return value again.
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature-ci-red',
      tickets: TICKETS,
      ciStatus: 'failed',
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1', 'Story')]);

    const parked = await pipeline.settle('needs_human', (task) => task.state === 'needs_human');
    expect(parked.current_stage).toBe('ci_gate');
    // BD-008 bounds the loop at 3, and the counter never passes its limit.
    expect(parked.iteration_counters.ci_fix).toBe(3);
    // The guard, stated as the thing a human would notice if it failed open.
    expect(pipeline.specs.map((spec) => spec.stage)).not.toContain('code_review');
    expect(pipeline.specs.filter((spec) => spec.stage === 'implementation')).toHaveLength(4);

    const events = await pipeline.events();
    const escalated = events.find((event) => event.type === 'task.escalated');
    const reason = (escalated?.payload as { reason?: string } | undefined)?.reason ?? '';
    expect(reason).toContain('ci_fix iteration limit of 3 reached');
    // The gate's `detail` is what the human is given, and the Q55 cut is what it contains: the
    // failing job's name, carried all the way from the provider to the escalation.
    expect(reason).toContain('test:unit');
    expect(events.map((event) => event.type)).not.toContain('task.completed');
  });
});

describe('a bug ticket, end to end', () => {
  it('takes the investigation stage and finishes on the same tail', async () => {
    const pipeline = await startPipeline({
      scenarios: bugScenarios,
      label: 'bug',
      tickets: TICKETS,
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-9', 'Bug')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.template).toBe('bug');
    expect(pipeline.specs.map((spec) => spec.stage)).toContain('investigation');

    await pipeline.publish([merged(pipeline)]);

    const finished = await pipeline.settle('done', (task) => task.state === 'done');
    // Six agent stages: the feature five plus investigation.
    expect(Number(finished.cost_actual)).toBeCloseTo(2.8, 6);
    expect(pipeline.specs.map((spec) => spec.stage)).toEqual([
      'refinement',
      'investigation',
      'architecture',
      'implementation',
      'code_review',
      'business_review',
      'retrospective',
    ]);
  });
});
