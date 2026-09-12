/**
 * The pipeline saga, driven by events.
 *
 * These run the *real* handlers, the *real* interpreter and the *real* stage executor over the
 * in-memory doubles of `../testing/pipeline-harness.js`. The e2e tier runs the same loop on a real
 * PostgreSQL with the real fake-Claude runner; this tier is where the branches live, because a
 * branch is cheap to reach here and expensive to reach there.
 */
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { readDataBlocks } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import { answerTaskQuestion, decideTaskApproval, expireTaskQuestion } from './commands.js';
import { MAX_GATE_CHECKS } from './gates.js';
import { GATE_RECHECK_MS } from './jobs.js';
import { DEFAULT_REVIEW_COMMENT_WINDOW_MS, priorityRankOf } from './saga.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
} as const;

const REFINED_SPEC = {
  goal: 'Show the totals in the invoice footer.',
  user_value: 'Finance can read the invoice without a calculator.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac1',
      given: 'an invoice with three lines',
      when: 'it is rendered',
      // `given/when/then` is the acceptance-criterion shape technical/12 publishes; renaming it
      // here would make the fixture stop matching the artifact schema this test feeds it to.
      // biome-ignore lint/suspicious/noThenProperty: it is the published field name
      then: 'the footer shows the sum',
      validation: { kind: 'test', value: 'totals.test.ts' },
    },
  ],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: 'none', justification: 'in the documented direction' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const PLAN = {
  approach: 'Sum the lines in the renderer.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'add the sum' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'none',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};

const NOTES = (iid = 7) => ({
  summary: 'Added the footer sum.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: 'green' }],
  known_gaps: [],
  followup_tickets: [],
  mr: {
    url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
    iid,
    head_sha: 'b'.repeat(40),
    branch: 'agentic/acme-1',
  },
});

const REVIEW = (verdict: 'approve' | 'request_changes', findings: unknown[] = []) => ({
  verdict,
  findings,
  summary: 'Reviewed.',
  protected_path_changes_confirmed: [],
});

const ACCEPTANCE = (verdict: 'approve' | 'request_changes') => ({
  verdict,
  criteria: [{ id: 'ac1', status: verdict === 'approve' ? 'met' : 'not_met', evidence: 'test' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
});

const RETRO = {
  what_went_well: ['the plan held'],
  returns: [],
  human_corrections: [],
  cost_summary: '1.25 USD',
  proposals: [],
};

/** What the Librarian reports (WP-18b). The harness stores it; the curation is its own test. */
const LIBRARIAN = {
  proposals: [
    {
      action: 'add',
      kind: 'technical',
      type: 'lesson',
      target_path: 'lessons/L-2026-06-01-totals.md',
      delta: '# sum the model\n',
      evidence: ['https://git.example.test/acme/api/-/merge_requests/7'],
      significance: 0.4,
      reason: 'nothing covers it',
    },
  ],
  health: [],
  summary: 'one page',
};

const completedRun = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

/** Every stage of the feature template, scripted to approve. */
const happyRuns = (iid = 7) => ({
  refinement: completedRun(REFINED_SPEC),
  architecture: completedRun(PLAN),
  implementation: completedRun(NOTES(iid)),
  code_review: completedRun(REVIEW('approve')),
  business_review: completedRun(ACCEPTANCE('approve')),
  retrospective: completedRun(RETRO),
  librarian: completedRun(LIBRARIAN),
});

const harnessWith = (options: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    runs: happyRuns(),
    git: {
      getPipelineStatus: async () => ({
        id: 'pipeline-1',
        head_sha: 'b'.repeat(40),
        status: 'success',
        url: null,
        jobs: [],
        coverage_pct: null,
        finished_at: '2026-06-01T09:30:00.000Z',
      }),
      getMergeRequest: async () => mergeRequest(false),
      ...options.git,
    },
    ...options,
  });

const mergeRequest = (hasConflicts: boolean | null, iid = 7) => ({
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid,
    url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
    branch: 'agentic/acme-1',
    head_sha: 'b'.repeat(40),
  },
  state: 'opened' as const,
  draft: true,
  title: 'Draft: totals',
  description: '',
  source_branch: 'agentic/acme-1',
  target_branch: 'main',
  head_sha: 'b'.repeat(40),
  mergeable: true,
  has_conflicts: hasConflicts,
  labels: [],
  reviewers: [],
  web_url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
});

let stream = 0;

/**
 * An inbound event as an adapter would append it: its own stream, sequence 1, an integration actor.
 *
 * Built through `domainEventSchemasByType` rather than through `buildEvent`, because `buildEvent`
 * narrows its payload from the type parameter and a test that passes both as values has nothing to
 * narrow from. The parse is what matters: an event this helper builds is one the catalogue accepts.
 */
const event = <T extends DomainEvent['type']>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
  streamType: DomainEvent['stream_type'] = 'project',
): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: streamType,
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const ticketMatched = (issueType = 'Story', key: string = TICKET.key) =>
  event('ticket.matched', {
    project_id: PROJECT,
    ticket: { ...TICKET, key },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: issueType,
    epic: null,
    links: [],
  });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

describe('a feature ticket through the whole loop', () => {
  it('walks intake → refinement → … → done and ends with the task complete', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);

    // The merge is a human's: the loop stops at `ready_for_merge` until `mr.merged` arrives.
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(taskOf(harness).task.currentStage).toBe('ready_for_merge');

    await harness.publish([
      event('mr.merged', {
        project_id: PROJECT,
        task_id: null,
        mr: mergeRequest(false).ref,
        draft: false,
        head_sha: 'b'.repeat(40),
        diff_stats: null,
        merge_commit_sha: 'c'.repeat(40),
      }),
    ]);

    const finished = taskOf(harness);
    expect(finished.task.state).toBe('done');
    expect(harness.types()).toContain('task.completed');
    // Every stage of the template appears once, in order, and nothing ran twice.
    expect(
      harness
        .events()
        .filter((entry) => entry.type === 'task.stage.entered')
        .map((entry) => (entry.payload as { stage: string }).stage),
    ).toEqual([
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
    ]);
  });

  it('runs one agent run per agent stage, with the role the template names', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    expect(harness.specs.map((spec) => [spec.stage, spec.role])).toEqual([
      ['refinement', 'product_manager'],
      ['architecture', 'architect'],
      ['implementation', 'developer'],
      ['code_review', 'reviewer'],
      ['business_review', 'acceptance_tester'],
    ]);
  });

  it('records the merge request the implementation notes reported', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).mr).toMatchObject({ iid: 7, branch: 'agentic/acme-1' });
  });

  it('adds every run’s cost to the task', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    // Five agent stages at the harness's default 0.25 USD each.
    expect(taskOf(harness).costActualUsd).toBeCloseTo(1.25, 6);
  });

  it('classifies a bug ticket onto the bug template, which adds investigation', async () => {
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: {
        ...happyRuns(),
        investigation: completedRun({
          reproduction: { kind: 'evidence', steps: [], evidence: ['sentry'] },
          root_cause: 'off by one',
          confidence: 'high',
          affected_scope: ['invoices'],
          fix_direction: 'fix the sum',
          regression_test_idea: 'totals.test.ts',
          questions: [],
        }),
      },
      git: { getMergeRequest: async () => mergeRequest(false) },
    });
    await harness.publish([ticketMatched('Bug')]);
    expect(taskOf(harness).task.template).toBe('bug');
    expect(harness.specs.map((spec) => spec.stage)).toContain('investigation');
  });
});

describe('intake', () => {
  it('creates one task per ticket, whatever the platform is told twice', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toHaveLength(1);
  });

  it('refuses to start when the default branch is unprotected, before any run', async () => {
    const harness = harnessWith({ git: { isBranchProtected: async () => false } });
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);
    expect(task.task.state).toBe('needs_human');
    expect(harness.specs).toHaveLength(0);
    const escalation = harness.events().find((entry) => entry.type === 'task.escalated') as Extract<
      DomainEvent,
      { type: 'task.escalated' }
    >;
    expect(escalation.payload.blocker_brief).toContain('not protected');
  });

  it('queues a task the WIP limit will not admit', async () => {
    const harness = harnessWith({
      settings: { wip: { maxParallelTasks: 2, maxTasksInPipeline: 1, maxParallelRuns: 4 } },
    });
    // The first ticket runs to `ready_for_merge` and holds no active slot there…
    harness.script('refinement', {
      status: 'completed',
      terminalReason: 'success',
      structuredOutput: {
        ...REFINED_SPEC,
        decision: 'ask',
        questions: [{ id: 'q1', text: 'Which currency?' }],
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('waiting_answers');

    await harness.publish([ticketMatched('Story', 'ACME-2')]);
    const second = harness.store.snapshot().find((stored) => stored.task.ticket.key === 'ACME-2');
    expect(second?.task.state).toBe('queued');
    expect(harness.types()).toContain('task.queued');
  });

  it('normalises provider priority names onto a rank the scheduler can sort', () => {
    expect(priorityRankOf('Highest')).toBeLessThan(priorityRankOf('High'));
    expect(priorityRankOf('High')).toBeLessThan(priorityRankOf(null));
    expect(priorityRankOf(null)).toBeLessThan(priorityRankOf('Low'));
    expect(priorityRankOf('Low')).toBeLessThan(priorityRankOf('Lowest'));
    expect(priorityRankOf('something a provider invented')).toBe(priorityRankOf(null));
  });
});

describe('questions', () => {
  const asking = () =>
    harnessWith({
      runs: {
        ...happyRuns(),
        refinement: completedRun({
          ...REFINED_SPEC,
          decision: 'ask',
          questions: [{ id: 'q1', text: 'Which currency?', blocking: true }],
        }),
      },
    });

  it('parks the task on a blocking question and asks it once', async () => {
    const harness = asking();
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('waiting_answers');
    expect(harness.types().filter((type) => type === 'task.question.asked')).toHaveLength(1);
    // The stage that asked did not advance.
    expect(taskOf(harness).task.currentStage).toBe('refinement');
  });

  it('resumes the stage when the answer arrives, and counts the round', async () => {
    const harness = asking();
    await harness.publish([ticketMatched()]);
    const asked = harness.events().find((entry) => entry.type === 'task.question.asked') as Extract<
      DomainEvent,
      { type: 'task.question.asked' }
    >;

    // The second attempt answers rather than asking again.
    harness.script('refinement', completedRun(REFINED_SPEC));
    await answerTaskQuestion(harness.commands, {
      questionId: asked.payload.question.id,
      answer: 'EUR',
      userId: '00000000-0000-4000-8000-0000000000c1',
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();

    const resumed = taskOf(harness);
    expect(resumed.task.iterationCounters.refinement_questions).toBe(1);
    expect(resumed.task.stageAttempts.refinement).toBe(2);
    expect(resumed.task.state).toBe('ready_for_merge');
  });

  it('escalates when the question expires instead of waiting for ever', async () => {
    const harness = asking();
    await harness.publish([ticketMatched()]);
    const asked = harness.events().find((entry) => entry.type === 'task.question.asked') as Extract<
      DomainEvent,
      { type: 'task.question.asked' }
    >;
    await expireTaskQuestion(harness.commands, asked.payload.question.id);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
  });

  it('does nothing when the expiry timer fires after the answer', async () => {
    // TD-004 has no cancel, so the timer fires for a question that was answered in the meantime.
    const harness = asking();
    await harness.publish([ticketMatched()]);
    const asked = harness.events().find((entry) => entry.type === 'task.question.asked') as Extract<
      DomainEvent,
      { type: 'task.question.asked' }
    >;
    harness.script('refinement', completedRun(REFINED_SPEC));
    await answerTaskQuestion(harness.commands, {
      questionId: asked.payload.question.id,
      answer: 'EUR',
      userId: '00000000-0000-4000-8000-0000000000c1',
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();
    await expireTaskQuestion(harness.commands, asked.payload.question.id);
    await harness.drain();
    expect(taskOf(harness).task.state).not.toBe('needs_human');
    expect(harness.types()).not.toContain('task.question.expired');
  });
});

describe('plan approval (product/04 S2, BD-006)', () => {
  const large = () =>
    harnessWith({
      runs: { ...happyRuns(), architecture: completedRun({ ...PLAN, estimated_size: 'XL' }) },
    });

  it('does not ask for one below the size threshold', async () => {
    // The happy path's plan is M, and the default policy is `above_size` at L. Rule 10: without
    // this case, "an approval was requested" would be indistinguishable from "the gate never ran".
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    expect(harness.types()).not.toContain('task.approval.requested');
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('stops an XL plan at a human, and carries on when the plan is approved', async () => {
    const harness = large();
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('waiting_approval');
    // It stopped *before* implementation, which is the point of the gate.
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement', 'architecture']);
    const requested = harness
      .events()
      .find((entry) => entry.type === 'task.approval.requested') as Extract<
      DomainEvent,
      { type: 'task.approval.requested' }
    >;
    expect(requested.payload.approval.kind).toBe('plan');

    await decideTaskApproval(harness.commands, {
      approvalId: requested.payload.approval.id,
      decision: 'approved',
      userId: '00000000-0000-4000-8000-0000000000c1',
      role: 'maintainer',
    });
    await harness.drain();

    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(harness.specs.map((spec) => spec.stage)).toContain('implementation');
    // The approval is not asked for twice on the way through.
    expect(harness.types().filter((type) => type === 'task.approval.requested')).toHaveLength(1);
  });

  it('sends a rejected plan back to architecture, counting the round', async () => {
    const harness = large();
    await harness.publish([ticketMatched()]);
    const requested = harness
      .events()
      .find((entry) => entry.type === 'task.approval.requested') as Extract<
      DomainEvent,
      { type: 'task.approval.requested' }
    >;

    // The second attempt produces a plan the threshold lets through.
    harness.script('architecture', completedRun(PLAN));
    await decideTaskApproval(harness.commands, {
      approvalId: requested.payload.approval.id,
      decision: 'rejected',
      userId: '00000000-0000-4000-8000-0000000000c1',
      role: 'maintainer',
      reason: 'split it into two merge requests',
    });
    await harness.drain();

    expect(taskOf(harness).task.stageAttempts.architecture).toBe(2);
    expect(taskOf(harness).task.iterationCounters.architecture_revisions).toBe(1);
  });

  it('refuses a decision from a role that may not make it', async () => {
    const harness = large();
    await harness.publish([ticketMatched()]);
    const requested = harness
      .events()
      .find((entry) => entry.type === 'task.approval.requested') as Extract<
      DomainEvent,
      { type: 'task.approval.requested' }
    >;
    // BD-006: only mapped maintainers decide, and `decideApproval` asks `can()`.
    await expect(
      decideTaskApproval(harness.commands, {
        approvalId: requested.payload.approval.id,
        decision: 'approved',
        userId: '00000000-0000-4000-8000-0000000000c1',
        role: 'member',
      }),
    ).rejects.toThrow();
    expect(taskOf(harness).task.state).toBe('waiting_approval');
  });
});

describe('the CI gate', () => {
  const withPendingCi = () =>
    harnessWith({
      git: {
        getPipelineStatus: async () => ({
          id: 'pipeline-1',
          head_sha: 'b'.repeat(40),
          status: 'running',
          url: null,
          jobs: [],
          coverage_pct: null,
          finished_at: null,
        }),
        getMergeRequest: async () => mergeRequest(false),
      },
    });

  it('waits at the gate while the pipeline is still running', async () => {
    const harness = withPendingCi();
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.currentStage).toBe('ci_gate');
    expect(taskOf(harness).task.state).toBe('active');
  });

  it('returns to implementation on a failure, counting a ci_fix round', async () => {
    const harness = withPendingCi();
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);

    await harness.publish([
      event('ci.pipeline.finished', {
        project_id: PROJECT,
        task_id: task.task.id,
        mr: mergeRequest(false).ref,
        head_sha: 'b'.repeat(40),
        status: 'failed',
        failed_jobs: [{ name: 'test:unit', log_ref: 'log:1' }],
        coverage_pct: null,
      }),
    ]);

    const returned = taskOf(harness);
    expect(returned.task.iterationCounters.ci_fix).toBe(1);
    // It went back to implementation and ran it again.
    expect(harness.specs.filter((spec) => spec.stage === 'implementation')).toHaveLength(2);
  });

  it('stops after three identical failures instead of burning the loop', async () => {
    const harness = withPendingCi();
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);
    const failure = () =>
      event('ci.pipeline.finished', {
        project_id: PROJECT,
        task_id: task.task.id,
        mr: mergeRequest(false).ref,
        head_sha: 'b'.repeat(40),
        status: 'failed',
        failed_jobs: [{ name: 'test:unit', log_ref: 'log:1' }],
        coverage_pct: null,
      });

    await harness.publish([failure()]);
    await harness.publish([failure()]);
    await harness.publish([failure()]);
    const stopped = taskOf(harness);
    expect(stopped.task.state).toBe('needs_human');
    // Rule 10: it stopped *for this reason*, not because the ci_fix limit (3) ran out.
    const escalation = harness
      .events()
      .filter((entry) => entry.type === 'task.escalated')
      .at(-1) as Extract<DomainEvent, { type: 'task.escalated' }>;
    expect(escalation.payload.reason).toContain('three times in a row');
    expect(stopped.task.iterationCounters.ci_fix).toBe(2);
  });

  it('ignores a pipeline result for a task that is not at the gate', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    const before = taskOf(harness);
    await harness.publish([
      event('ci.pipeline.finished', {
        project_id: PROJECT,
        task_id: before.task.id,
        mr: mergeRequest(false).ref,
        head_sha: 'b'.repeat(40),
        status: 'failed',
        failed_jobs: [],
        coverage_pct: null,
      }),
    ]);
    // Fail open on an inbound notification: the task stayed where it was.
    expect(taskOf(harness).task.state).toBe(before.task.state);
    expect(taskOf(harness).task.currentStage).toBe(before.task.currentStage);
  });
});

describe('code-review convergence (product/04 S5)', () => {
  const FINDING = (id: string) => ({
    id,
    severity: 'major',
    category: 'correctness',
    file: 'src/totals.ts',
    line: 12,
    explanation: 'the footer sums the visible rows',
    suggestion: 'sum the model',
  });

  /** A reviewer that reports the same finding every round, however many rounds it is given. */
  const withRepeatedFindings = (findings: unknown[]) =>
    harnessWith({
      runs: {
        ...happyRuns(),
        code_review: completedRun(REVIEW('request_changes', findings)),
      },
    });

  it('stops when the re-review reports the same findings, instead of burning the loop', async () => {
    const harness = withRepeatedFindings([FINDING('f1'), FINDING('f2')]);
    await harness.publish([ticketMatched()]);

    const stopped = taskOf(harness);
    expect(stopped.task.state).toBe('needs_human');
    // Rule 10: it stopped *for this reason*. The code_review limit is 3 and the counter is at 1,
    // so this is convergence detection and not the loop running out — which is the whole point of
    // S5 ("stop immediately … instead of burning the remaining iterations").
    const escalation = harness
      .events()
      .filter((entry) => entry.type === 'task.escalated')
      .at(-1) as Extract<DomainEvent, { type: 'task.escalated' }>;
    expect(escalation.payload.reason).toBe(
      'the review reported the same findings as the previous round',
    );
    expect(stopped.task.iterationCounters.code_review).toBe(1);
    // Two reviews ran, and no third: the second one is what closed the task.
    expect(harness.specs.filter((spec) => spec.stage === 'code_review')).toHaveLength(2);
  });

  it('keeps going when the second review reports different findings', async () => {
    // The other side of the branch: without this, the assertion above would also hold for a saga
    // that escalated on *any* second review, and S5 is about the findings being the same ones.
    //
    // The pipeline is parked at a still-running CI gate between the rounds — which is what makes
    // the second review scriptable, since a run scripted before `publish` cannot change mid-drain.
    const harness = harnessWith({
      runs: {
        ...happyRuns(),
        code_review: completedRun(REVIEW('request_changes', [FINDING('f1')])),
      },
      git: {
        getPipelineStatus: async () => ({
          id: 'pipeline-1',
          head_sha: 'b'.repeat(40),
          status: 'running',
          url: null,
          jobs: [],
          coverage_pct: null,
          finished_at: null,
        }),
        getMergeRequest: async () => mergeRequest(false),
      },
    });
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);
    const ciSucceeded = () =>
      event('ci.pipeline.finished', {
        project_id: PROJECT,
        task_id: task.task.id,
        mr: mergeRequest(false).ref,
        head_sha: 'b'.repeat(40),
        status: 'success',
        failed_jobs: [],
        coverage_pct: null,
      });

    await harness.publish([ciSucceeded()]);
    expect(harness.specs.filter((spec) => spec.stage === 'code_review')).toHaveLength(1);

    // A second round that found something else. The task carries on round-tripping.
    harness.script('code_review', completedRun(REVIEW('request_changes', [FINDING('f2')])));
    await harness.publish([ciSucceeded()]);

    expect(harness.specs.filter((spec) => spec.stage === 'code_review')).toHaveLength(2);
    expect(harness.events().filter((entry) => entry.type === 'task.escalated')).toHaveLength(0);
    expect(taskOf(harness).task.iterationCounters.code_review).toBe(2);
  });
});

describe('the rebase gate', () => {
  it('returns to implementation when the branch conflicts, and stops at the loop’s limit', async () => {
    const harness = harnessWith({ git: { getMergeRequest: async () => mergeRequest(true) } });
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);
    // product/04 S6b bounds the rebase gate at 2 attempts; a branch that conflicts every time uses
    // both and then parks for a human rather than looping.
    expect(task.task.iterationCounters.rebase).toBe(2);
    expect(task.task.state).toBe('needs_human');
    expect(harness.specs.filter((spec) => spec.stage === 'implementation')).toHaveLength(3);
  });

  it('asks again while the provider has not computed mergeability, and gives up loudly', async () => {
    // `mergeable: true` with `has_conflicts: null` is the shape that must NOT be read as "clean".
    const harness = harnessWith({ git: { getMergeRequest: async () => mergeRequest(null) } });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('active');
    expect(taskOf(harness).task.currentStage).toBe('rebase_gate');

    // Each re-check is a timer, not a spin: nothing happens until the clock moves.
    for (let check = 0; check < MAX_GATE_CHECKS; check += 1) {
      harness.clock.advance(GATE_RECHECK_MS);
      await harness.drain();
    }
    const task = taskOf(harness);
    expect(task.task.state).toBe('needs_human');
    const escalation = harness
      .events()
      .filter((entry) => entry.type === 'task.escalated')
      .at(-1) as Extract<DomainEvent, { type: 'task.escalated' }>;
    expect(escalation.payload.reason).toContain('could not be decided');
  });
});

describe('human merge-request comments (BD-007)', () => {
  it('opens one batch window per merge request, two minutes out, and never coalesces', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);

    await harness.publish([comment('one moment'), comment('actually, two things')]);

    const windows = harness.jobs.enqueued.filter(
      (request) => request.queue === JOB_QUEUES.mrCommentDebounce,
    );
    expect(windows).toHaveLength(2);
    for (const request of windows) {
      expect(request.singletonKey).toBe('mr:7');
      expect(request.coalesce).toBeUndefined();
      expect(request.startAfter?.getTime()).toBe(
        harness.clock.epochMs + DEFAULT_REVIEW_COMMENT_WINDOW_MS,
      );
    }
  });

  const discussion = (id: string, createdAt: string, resolved = false) => ({
    id,
    resolvable: true,
    resolved,
    notes: [
      {
        id: `${id}-note`,
        author: {
          provider: 'fake-git',
          external_id: '42',
          email: null,
          display_name: 'A human',
          verified: true,
        },
        body: 'please rename this',
        created_at: createdAt,
        path: null,
        line: null,
        system: false,
      },
    ],
  });

  const comment = (text: string) =>
    event('mr.review.comment', {
      project_id: PROJECT,
      task_id: null,
      mr: mergeRequest(false).ref,
      thread_id: 'thread-1',
      author: {
        provider: 'fake-git',
        external_id: '42',
        email: 'human@example.test',
        display_name: 'A human',
        verified: true,
      },
      text,
      resolved: false,
    });

  it('returns the task once when the window closes, however many comments there were', async () => {
    // Both written as the window opened, so by the time it closes the human has been quiet for the
    // whole two minutes. A note *inside* the last window re-arms instead — the test below.
    const threads = [
      discussion('t1', '2026-06-01T09:00:00.000Z'),
      discussion('t2', '2026-06-01T09:00:00.000Z'),
    ];
    const harness = harnessWith({
      git: {
        listDiscussions: async () => threads,
        getMergeRequest: async () => mergeRequest(false),
      },
    });
    await harness.publish([ticketMatched()]);
    await harness.publish([comment('one'), comment('two')]);
    const before = harness.events().filter((entry) => entry.type === 'task.stage.returned').length;

    harness.clock.advance(DEFAULT_REVIEW_COMMENT_WINDOW_MS + 1);
    await harness.drain();

    const returns = harness
      .events()
      .filter((entry) => entry.type === 'task.stage.returned')
      .slice(before);
    // BD-007: one return, whatever the number of comments or threads.
    expect(returns).toHaveLength(1);
    expect(
      (returns[0] as Extract<DomainEvent, { type: 'task.stage.returned' }>).payload,
    ).toMatchObject({ from_stage: 'ready_for_merge', to_stage: 'implementation' });
    expect(taskOf(harness).task.iterationCounters.human_rounds).toBe(1);
  });

  it('does nothing when the human resolved the threads inside the window', async () => {
    const harness = harnessWith({
      git: {
        listDiscussions: async () => [discussion('t1', '2026-06-01T09:00:00.000Z', true)],
        getMergeRequest: async () => mergeRequest(false),
      },
    });
    await harness.publish([ticketMatched()]);
    await harness.publish([comment('one')]);
    harness.clock.advance(DEFAULT_REVIEW_COMMENT_WINDOW_MS + 1);
    await harness.drain();

    // Tolerating "nothing to do" is the point: the timer cannot be cancelled.
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(harness.types().filter((type) => type === 'task.stage.returned')).toHaveLength(0);
  });

  it('opens another window instead of returning while the human is still typing', async () => {
    // The extending half of the debounce, built from a timer that cannot be cancelled: a comment
    // written inside the last window re-arms it rather than bouncing the task back.
    const harness = harnessWith({
      git: {
        listDiscussions: async () => [
          discussion('t1', new Date(harness.clock.epochMs).toISOString()),
        ],
        getMergeRequest: async () => mergeRequest(false),
      },
    });
    await harness.publish([ticketMatched()]);
    await harness.publish([comment('one')]);

    harness.clock.advance(DEFAULT_REVIEW_COMMENT_WINDOW_MS + 1);
    // The newest note is "now" on every wake, so the window keeps re-arming and never returns.
    await harness.drain();
    expect(harness.types().filter((type) => type === 'task.stage.returned')).toHaveLength(0);
    expect(
      harness.jobs.enqueued.filter((request) => request.queue === JOB_QUEUES.mrCommentDebounce),
    ).toHaveLength(1);
  });

  it('ignores a comment on a resolved thread', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    await harness.publish([
      event('mr.review.comment', {
        project_id: PROJECT,
        task_id: null,
        mr: mergeRequest(false).ref,
        thread_id: 'thread-1',
        author: {
          provider: 'fake-git',
          external_id: '42',
          email: null,
          display_name: null,
          verified: true,
        },
        text: 'resolved',
        resolved: true,
      }),
    ]);
    expect(
      harness.jobs.enqueued.filter((request) => request.queue === JOB_QUEUES.mrCommentDebounce),
    ).toHaveLength(0);
  });
});

describe('when the default branch moves under a waiting merge request', () => {
  it('sends the task back through the rebase gate', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');

    await harness.publish([
      event('default_branch.moved', {
        project_id: PROJECT,
        branch: 'main',
        new_head: 'd'.repeat(40),
      }),
    ]);

    // It re-entered the gate, passed it again, and is waiting for a human once more.
    expect(taskOf(harness).task.stageAttempts.rebase_gate).toBe(2);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(taskOf(harness).task.iterationCounters.human_rounds).toBe(1);
  });
});

describe('when the merge request is closed instead of merged', () => {
  it('parks the task for a human with the reason', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    await harness.publish([
      event('mr.closed', {
        project_id: PROJECT,
        task_id: null,
        mr: mergeRequest(false).ref,
        draft: false,
        head_sha: 'b'.repeat(40),
        diff_stats: null,
      }),
    ]);
    expect(taskOf(harness).task.state).toBe('needs_human');
  });
});

/**
 * **WP-15f: the first agent stage is given the ticket's own words.**
 *
 * Every case here starts from a `ticket.matched` **appended directly**, with no inbox row behind
 * it — which is the *manual* start's shape (`POST /api/projects/:id/tasks`, and
 * `pipeline.intake.reconcile`), and the same code path a webhook-started task takes. The webhook
 * half is `test/e2e/pipeline/webhook-ingress.e2e.test.ts`.
 *
 * Asserted against the **assembled prompt** and the **stored row**, never through the runner:
 * `FakeClaudeRunner` and this harness's runner both pick their scenario from `spec.stage` and
 * neither reads a prompt, so an assertion routed through one asserts nothing (standing rule 82).
 */
describe('the ticket’s own words (WP-15f)', () => {
  const TITLE = 'rollback sessions after a failed migration';
  const BODY = 'When a migration fails halfway the session table keeps the half-written rows.';

  const ticketDouble = (calls: { count: number }, failFirst = 0) => ({
    readTicket: async (ref: { provider: string; key: string; url: string }) => {
      calls.count += 1;
      if (calls.count <= failFirst) {
        throw new Error('the ticket system is unreachable');
      }
      return {
        ref,
        issue_type: 'Bug',
        title: TITLE,
        description: BODY,
        status: 'To Do',
        priority: 'High',
        labels: [],
        comments: [
          {
            id: 'c1',
            author: {
              provider: 'fake-jira',
              external_id: 'u1',
              email: null,
              display_name: 'Dana',
              verified: true,
            },
            body: 'it only reproduces when the migration is interrupted',
            created_at: '2026-06-01T09:00:00.000Z',
            updated_at: null,
            marker_id: null,
            url: null,
          },
        ],
        links: [],
        epic: null,
        siblings: [],
        attachments_text: [],
        assignee: null,
        reporter: null,
        updated_at: '2026-06-02T09:00:00.000Z',
      };
    },
  });

  const ticketBlockOf = (userPrompt: string) => {
    const block = readDataBlocks(userPrompt).blocks.find((entry) => entry.kind === 'ticket');
    expect(block).toBeDefined();
    return block as NonNullable<typeof block>;
  };

  it('stores the snapshot at intake and puts it in the first stage’s prompt', async () => {
    const calls = { count: 0 };
    const harness = harnessWith({ taskManagement: ticketDouble(calls) });
    await harness.publish([ticketMatched()]);

    const stored = taskOf(harness);
    expect(stored.ticketSnapshot?.title).toBe(TITLE);
    expect(stored.ticketSnapshot?.comment_count).toBe(1);
    expect(stored.ticketSnapshotAt).not.toBeNull();

    /**
     * **Intake read it, not the stage** — the two halves are otherwise indistinguishable from the
     * final row (standing rule 68), and the audit is what tells them apart: `read_ticket` is made
     * before the task row exists, so its `taskId` is `null`. It also pins the half of the criterion
     * a row cannot show — that the call went through `IntegrationActionExecutor` like every other
     * provider call, rather than straight at the port.
     */
    const audited = harness.audit.entriesFor('read_ticket');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.taskId).toBeNull();
    expect(audited[0]?.status).toBe('ok');
    expect(audited[0]?.mutating).toBe(false);

    const first = harness.specs[0];
    expect(first?.stage).toBe('refinement');
    const block = ticketBlockOf(first?.userPrompt ?? '');
    expect(block.attributes.text).toBe('read');
    expect(block.body).toContain(TITLE);
    expect(block.body).toContain('the session table keeps the half-written rows');
    expect(block.body).toContain('it only reproduces when the migration is interrupted');
  });

  /**
   * The self-healing half, and the reason the fetch is in two places rather than one.
   *
   * Intake's read fails — Jira is down for that second — and the task is created anyway
   * (standing rule 20: the ticket is *why* the task exists). The `stage.execute` job reads it
   * before the first agent stage runs, so the criterion still holds.
   */
  it('starts the task when intake cannot read the ticket, and reads it at the stage', async () => {
    const calls = { count: 0 };
    const harness = harnessWith({ taskManagement: ticketDouble(calls, 1) });
    await harness.publish([ticketMatched()]);

    expect(calls.count).toBeGreaterThan(1);
    expect(taskOf(harness).ticketSnapshot?.title).toBe(TITLE);
    expect(ticketBlockOf(harness.specs[0]?.userPrompt ?? '').body).toContain(TITLE);
    // The audit tells the two reads apart: the intake one has no task yet and failed; the one that
    // succeeded was made from the stage job, against a task that exists.
    const audited = harness.audit.entriesFor('read_ticket');
    expect(audited.map((entry) => entry.status)).toEqual(['failed', 'ok']);
    expect(audited[0]?.taskId).toBeNull();
    expect(audited[1]?.taskId).toBe(taskOf(harness).task.id);
  });

  /**
   * The no-op check, asserted by a **count** rather than by an outcome: every later stage finds a
   * snapshot and makes no provider call. Deleting the `ticketSnapshot !== null` guard in
   * `ensureTicketSnapshot` turns 1 into one per agent stage and this dies.
   */
  it('reads the ticket once per task, however many stages run', async () => {
    const calls = { count: 0 };
    const harness = harnessWith({ taskManagement: ticketDouble(calls) });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    // Six agent stages ran; one read happened.
    expect(harness.specs.length).toBeGreaterThan(1);
    expect(calls.count).toBe(1);
  });

  /**
   * A ticket the platform could never read is **not** spelled as a ticket with no title
   * (standing rule 18), and it does not stop the task.
   */
  it('runs the task and says the ticket was not read when the provider never answers', async () => {
    const calls = { count: 0 };
    const harness = harnessWith({ taskManagement: ticketDouble(calls, 99) });
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(taskOf(harness).ticketSnapshot).toBeNull();
    expect(taskOf(harness).ticketSnapshotAt).toBeNull();
    const block = ticketBlockOf(harness.specs[0]?.userPrompt ?? '');
    expect(block.attributes.text).toBe('unread');
    expect(block.body).not.toContain('title:');
  });

  it('keeps a credential somebody pasted into the ticket out of the stored row', async () => {
    const SECRET = 'glpat-notarealtokenatall';
    const calls = { count: 0 };
    const double = ticketDouble(calls);
    const harness = harnessWith({
      taskManagement: {
        readTicket: async (ref: never) => ({
          ...(await double.readTicket(ref)),
          description: `${BODY} use ${SECRET} to reproduce`,
        }),
      },
      ticketRedactor: exactSecretRedactor([{ name: 'fake_jira_token', value: SECRET }]),
    });
    await harness.publish([ticketMatched()]);

    const snapshot = taskOf(harness).ticketSnapshot;
    expect(snapshot?.description).not.toContain(SECRET);
    expect(snapshot?.redaction_count).toBe(1);
    expect(harness.specs[0]?.userPrompt).not.toContain(SECRET);
  });
});
