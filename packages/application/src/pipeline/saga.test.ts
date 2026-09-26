/**
 * The pipeline saga, driven by events.
 *
 * These run the *real* handlers, the *real* interpreter and the *real* stage executor over the
 * in-memory doubles of `../testing/pipeline-harness.js`. The e2e tier runs the same loop on a real
 * PostgreSQL with the real fake-Claude runner; this tier is where the branches live, because a
 * branch is cheap to reach here and expensive to reach there.
 */
import type { DomainEvent, IsoDateTime, Slug } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import type { CompiledPipeline } from '@platform/domain';
import {
  AUTONOMY_PRESETS,
  compilePipeline,
  DEFAULT_ITERATION_LIMITS,
  FEATURE_TEMPLATE,
  MAX_FEEDBACK_CHARS,
  materialiseAutonomy,
  readDataBlocks,
  SHIPPED_TEMPLATES,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { startShadowBatch } from '../shadow/batch.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import {
  answerTaskQuestion,
  decideTaskApproval,
  expireTaskQuestion,
  returnToStageCommand,
} from './commands.js';
import { MAX_GATE_CHECKS } from './gates.js';
import { staticPipelineIntegrations } from './integrations.js';
import { GATE_RECHECK_MS } from './jobs.js';
import {
  DEFAULT_REVIEW_COMMENT_WINDOW_MS,
  priorityRankOf,
  spendIsStillAhead,
  UNMATERIALISED_PLAN_APPROVAL,
} from './saga.js';
import { staticProjectSettings } from './settings.js';

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
  // `flag` is a **boolean** in `refinedSpecDataSchema`, and it used to read `'none'` here — which
  // made this fixture fail its own published schema and gave `CostStore.refinedSize` nothing to
  // read. Nothing noticed until WP-28 asked the harness for the spec's size (standing rule 45: a
  // fixture that never has to satisfy the thing under test is a fixture nobody validates).
  drift: { flag: false, justification: 'in the documented direction' },
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
  /**
   * WP-26's conflict resolution produces the developer's artifact too, so a *scripted* resolution
   * is a resolution that claims to have merged the default branch in. Whether the branch really
   * applies afterwards is the **gate's** answer and not this artifact's, which is why the tests
   * below drive `getMergeRequest` rather than this script to decide the outcome.
   */
  conflict_resolution: completedRun(NOTES(iid)),
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
    // The timer re-validates on fire (WP-56): before the stored deadline it expires nothing…
    expect(await expireTaskQuestion(harness.commands, asked.payload.question.id)).toEqual({
      kind: 'not_due',
      dueAt: asked.payload.question.deadline_at,
    });
    // …and at it, it does.
    harness.clock.advance(
      Date.parse(asked.payload.question.deadline_at as string) - harness.clock.epochMs,
    );
    expect(await expireTaskQuestion(harness.commands, asked.payload.question.id)).toEqual({
      kind: 'expired',
    });
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
    harness.clock.advance(
      Date.parse(asked.payload.question.deadline_at as string) - harness.clock.epochMs,
    );
    expect(await expireTaskQuestion(harness.commands, asked.payload.question.id)).toEqual({
      kind: 'settled',
    });
    await harness.drain();
    expect(taskOf(harness).task.state).not.toBe('needs_human');
    expect(harness.types()).not.toContain('task.question.expired');
  });
});

/**
 * **The dial, read by the pipeline** — WP-30's criterion 3.
 *
 * Before this work package `planApprovalGate` read `pipeline.template_overrides[…].plan_approval`
 * and nothing else, so fifteen materialised policies had no reader and a project moved to
 * Autonomous got the behaviour of Supervised. These cases drive each branch the gate now has, from
 * **both** sides (standing rule 42): a gate that fired on everything would pass half of them.
 */
describe('the plan-approval gate reads the materialised dial (BD-027, WP-30)', () => {
  const dialled = (
    level: 'observe' | 'assist' | 'supervised' | 'autonomous',
    extra: Partial<HarnessOptions> = {},
  ): PipelineHarness =>
    harnessWith({
      ...extra,
      settings: {
        autonomy: materialiseAutonomy({
          level,
          at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
          appliedBy: null,
        }),
        ...extra.settings,
      },
    });

  it('gates an M plan on a Supervised project because probation is on', async () => {
    // product/19 §11: Supervised is "above L; **probation first 5 tasks**". The happy path's plan
    // is M, which `above_size` at L lets through — so the only thing that can stop it is probation,
    // which is exactly the policy that had no reader.
    const harness = dialled('supervised');
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('waiting_approval');
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement', 'architecture']);
  });

  it('lets the same M plan through once the project has overridden probation off', async () => {
    // The other side, and it also drives the override path: `policies.probation_tasks: 0` is the
    // one granular override `.agentic/config.yml` can express today, and "probation for 0 tasks" is
    // "probation off" (`autonomyOverridesFromConfig`).
    const harness = dialled('supervised', {
      settings: { config: { policies: { probation_tasks: 0 } } },
    });
    await harness.publish([ticketMatched()]);
    expect(harness.types()).not.toContain('task.approval.requested');
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('lets an XL plan through on an Autonomous project, which the old gate would have stopped', async () => {
    // `planApproval: never` and probation off. The pre-WP-30 gate read `above_size` at L from the
    // template overrides' default and would have parked this task — so this case is the one that
    // shows the dial is being read at all, rather than agreeing with the old behaviour by accident.
    const harness = dialled('autonomous', {
      runs: { ...happyRuns(), architecture: completedRun({ ...PLAN, estimated_size: 'XL' }) },
    });
    await harness.publish([ticketMatched()]);
    expect(harness.types()).not.toContain('task.approval.requested');
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('still stops an Autonomous project when the plan touches a risk class', async () => {
    // product/19 §11's last exception — "never, **except risk classes**" — and product/19 §14's
    // classes, matched against the paths the plan declares (`files_to_change[].path`).
    const harness = dialled('autonomous', {
      settings: {
        config: {
          policies: {
            risk_classes: { payments: { paths: ['src/totals.ts'], require: ['plan_approval'] } },
          },
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('waiting_approval');
  });

  it('does not stop it for a class whose requirement this build does not enforce', async () => {
    // `reviewer:@ops` is parsed and unread, so a class that asks only for it must not silently
    // become a plan approval — which would be the platform inventing a gate nobody configured.
    const harness = dialled('autonomous', {
      settings: {
        config: {
          policies: {
            infra: undefined,
            risk_classes: { infra: { paths: ['src/totals.ts'], require: ['reviewer:@ops'] } },
          } as never,
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(harness.types()).not.toContain('task.approval.requested');
  });

  /**
   * **BD-027:14, driven through the pipeline rather than asserted in the domain.**
   *
   * The stored document says `plan_approval: never` while `AUTONOMY_PRESETS.supervised` says
   * `above_size`. A gate that re-derived the preset from `projects.autonomy_level` would park the
   * XL plan; one that reads what the project was given lets it through. Editing the source table in
   * a test is not possible without mutating a module, so the falsification is the same one the
   * domain test uses: a document the current table would not produce.
   */
  it('obeys the policies the project was given, not the ones the release now ships', async () => {
    const shipped = materialiseAutonomy({
      level: 'supervised',
      at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    const harness = harnessWith({
      runs: { ...happyRuns(), architecture: completedRun({ ...PLAN, estimated_size: 'XL' }) },
      settings: {
        autonomy: {
          ...shipped,
          policies: { ...shipped.policies, plan_approval: 'never', probation: false },
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(harness.types()).not.toContain('task.approval.requested');
    // …and the source table still says otherwise, which is what makes this a difference.
    expect(AUTONOMY_PRESETS.supervised.planApproval).toBe('above_size');
  });

  it('keeps the pre-WP-30 gate for a project whose dial was never materialised', async () => {
    // `autonomy: null` is a row a harness inserted (migration 0021 backfilled every real one). The
    // branch is named rather than defaulted: substituting the supervised preset here would turn
    // probation on for a project that never chose a position.
    expect(UNMATERIALISED_PLAN_APPROVAL.probation).toBe(false);
    const passes = harnessWith();
    await passes.publish([ticketMatched()]);
    expect(passes.types()).not.toContain('task.approval.requested');

    const stopped = harnessWith({
      runs: { ...happyRuns(), architecture: completedRun({ ...PLAN, estimated_size: 'XL' }) },
    });
    await stopped.publish([ticketMatched()]);
    expect(stopped.types()).toContain('task.approval.requested');
  });

  it('lets a per-stage template override decide the mode, in both directions', async () => {
    // The override is finer grained than the dial, so it wins over `planApproval` — and only over
    // that field. It is **not** a switch for probation: `policies.probation_tasks` is, and a key
    // named `plan_approval` that silently turned probation off would be one control with two jobs.
    const forced = dialled('autonomous', {
      settings: {
        config: {
          pipeline: {
            template_overrides: {
              feature: { stages: { architecture: { plan_approval: 'always' } } },
            },
          },
        },
      },
    });
    await forced.publish([ticketMatched()]);
    expect(taskOf(forced).task.state).toBe('waiting_approval');

    const released = dialled('supervised', {
      runs: { ...happyRuns(), architecture: completedRun({ ...PLAN, estimated_size: 'XL' }) },
      settings: {
        config: {
          policies: { probation_tasks: 0 },
          pipeline: {
            template_overrides: {
              feature: { stages: { architecture: { plan_approval: 'never' } } },
            },
          },
        },
      },
    });
    await released.publish([ticketMatched()]);
    expect(released.types()).not.toContain('task.approval.requested');
  });

  /**
   * **A shadow task is not gated on plan approval** — `planApprovalGate`'s first branch (WP-34).
   *
   * The pair isolates the **mode** and nothing else: one policy document, Observe's — whose
   * `plan_approval` is `always` and which is the only position `shadow_mode` is true at — with
   * `picks_up_new_tickets` turned on so the same dial can also produce an ordinary task. An
   * unconditional gate parks both; a gate that reads the mode parks one. Nothing named this branch
   * until WP-34's review round 2 (standing rule 42), and the reversal the notes offer — deleting
   * three lines of `saga.ts` — now fails here by name rather than in a founder's ten-click batch.
   */
  it('skips the plan approval for a shadow task and still asks for one on a normal task', async () => {
    const observe = materialiseAutonomy({
      level: 'observe',
      at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    // The two facts the case rests on, before anything is concluded from it (standing rule 4).
    expect(AUTONOMY_PRESETS.observe.planApproval).toBe('always');
    expect(AUTONOMY_PRESETS.observe.shadowMode).toBe(true);
    const settings = {
      config: { features: { shadow_mode: { enabled: true } } },
      autonomy: { ...observe, policies: { ...observe.policies, picks_up_new_tickets: true } },
    };

    const shadow = harnessWith({
      settings,
      git: {
        // `harnessWith` spreads `...options` last, so a `git` override replaces its defaults
        // wholesale rather than merging with them — both are restored here.
        getPipelineStatus: async () => ({
          id: 'pipeline-1',
          head_sha: 'b'.repeat(40),
          status: 'success' as const,
          url: null,
          jobs: [],
          coverage_pct: null,
          finished_at: '2026-06-01T09:30:00.000Z',
        }),
        getMergeRequest: async () => mergeRequest(false),
        // The batch's one scan, answered empty: this ticket has no human merge request, which
        // Q82 (b) reports rather than refuses.
        listMergedMergeRequests: async () => [],
      },
      taskManagement: {
        // The default stub **echoes the ref it is handed**, and the batch addresses a ticket by key
        // alone (`url: ''`) — which `createTask` refuses, because a ticket url is a url. The real
        // adapter answers the ticket's own ref, so the override is what production does rather than
        // a convenience.
        readTicket: async (ref: { readonly key: string }) =>
          ({
            ref: {
              provider: 'fake-jira',
              key: ref.key,
              url: `https://jira.example.test/browse/${ref.key}`,
            },
            issue_type: 'Story',
            title: 'Show the totals in the invoice footer',
            description: 'The footer sums the visible rows rather than all of them.',
            status: 'Done',
            priority: null,
            labels: [],
            comments: [],
            links: [],
            epic: null,
            siblings: [],
            attachments_text: [],
            assignee: null,
            reporter: null,
            updated_at: '2026-06-01T09:00:00.000Z',
          }) as never,
      },
    });
    await startShadowBatch(
      {
        unitOfWork: shadow.memory,
        store: shadow.store,
        shadow: shadow.shadow,
        settings: staticProjectSettings(() => shadow.settings),
        integrations: staticPipelineIntegrations(shadow.integrations),
        jobs: shadow.jobs,
        ids: shadow.ids,
        clock: { now: () => shadow.clock.now() as IsoDateTime },
      },
      { projectId: PROJECT as never, ticketKeys: [TICKET.key], requestedByUserId: null },
    );
    await shadow.drain();
    expect(shadow.types()).not.toContain('task.approval.requested');
    // Rule 10: "no approval was requested" is also true of a task that never reached the gate, so
    // the walk itself is asserted — and as a shadow walk.
    expect(shadow.specs.map((spec) => spec.stage)).toContain('implementation');
    expect(shadow.specs.every((spec) => spec.mode === 'shadow')).toBe(true);

    const normal = harnessWith({ settings });
    await normal.publish([ticketMatched()]);
    expect(normal.types()).toContain('task.approval.requested');
    expect(taskOf(normal).task.state).toBe('waiting_approval');
  });

  it('never lets a stage override switch off a risk class', async () => {
    // A risk class is a statement about the **change**, not about the stage, so `plan_approval:
    // never` on one stage cannot wave one through (product/19 §14).
    const risky = dialled('autonomous', {
      settings: {
        config: {
          pipeline: {
            template_overrides: {
              feature: { stages: { architecture: { plan_approval: 'never' } } },
            },
          },
          policies: {
            risk_classes: { payments: { paths: ['src/totals.ts'], require: ['plan_approval'] } },
          },
        },
      },
    });
    await risky.publish([ticketMatched()]);
    expect(taskOf(risky).task.state).toBe('waiting_approval');
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

/**
 * **The budget-approval gate — product/09's *"Estimate before spend"*, WP-28.**
 *
 * `requiresBudgetApproval` had been defined and unconsumed since WP-19, and `budgetApprovalGate` is
 * its one caller. Every case below drives the **real** estimator: the harness composes the cost
 * ledger (`cost: true`), which registers `costEstimateHandler` on the same bus, reads the size out
 * of the `RefinedSpec` the scripted refinement really produced and writes the four estimate columns
 * onto the task row the gate then reads. Only the *history* is seeded, because those are other,
 * already-finished tasks that a harness running one task genuinely does not have — the number the
 * gate compares is computed, never typed in (standing rule 82).
 *
 * The happy path's spec is size `M` and `SIZE_COST_WEIGHTS.M` is 2, so one finished `M` task
 * costing `c` gives this task an estimate of exactly `c`. That is what makes the threshold cases
 * below readable, and it is asserted once rather than assumed.
 */
describe('the budget-approval gate (product/09, WP-28, Q71)', () => {
  const THRESHOLD = AUTONOMY_PRESETS.supervised.budgetApprovalThresholdUsd ?? 0;

  const estimating = (
    history: readonly { size: 'S' | 'M' | 'L' | 'XL'; costUsd: number }[],
    extra: Partial<HarnessOptions> = {},
  ): PipelineHarness => {
    const harness = harnessWith({
      cost: true,
      ...extra,
      settings: {
        autonomy: materialiseAutonomy({
          level: 'supervised',
          at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
          appliedBy: null,
        }),
        // Probation off, so the *plan* gate cannot be the thing that stopped the task: Supervised
        // gates the first five tasks on their plan, and a case that asserted `waiting_approval`
        // without this would pass whichever gate fired (standing rule 10).
        config: { policies: { probation_tasks: 0 } },
        ...extra.settings,
      },
    });
    harness.cost?.seedHistory(PROJECT, [...history]);
    return harness;
  };

  const requestedApproval = (harness: PipelineHarness) =>
    harness.events().find((entry) => entry.type === 'task.approval.requested') as
      | Extract<DomainEvent, { type: 'task.approval.requested' }>
      | undefined;

  it('stops the task before Implementation when the estimate is over the threshold', async () => {
    const harness = estimating([{ size: 'M', costUsd: THRESHOLD + 10 }]);
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.estimateUsd).toBe(THRESHOLD + 10);
    expect(task.estimateBasis).toBe('project_history');
    expect(task.estimateSamples).toBe(1);
    expect(task.task.state).toBe('waiting_approval');
    expect(requestedApproval(harness)?.payload.approval.kind).toBe('budget');
    // product/09: *"before Implementation"*. Refinement ran and nothing after it did.
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement']);
  });

  it('lets a task estimated at exactly the threshold through (standing rule 42)', async () => {
    // The other side of the boundary, one cent away from the case above: a gate that fired on
    // everything, or one that read `>=`, passes the first half alone.
    const harness = estimating([{ size: 'M', costUsd: THRESHOLD }]);
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).estimateUsd).toBe(THRESHOLD);
    expect(harness.types()).not.toContain('task.approval.requested');
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('does not gate a task with no estimate, and records the refusal on the row (Q71 (b))', async () => {
    // The project's first task: no finished task to estimate from. `basis: 'unknown'` is the
    // estimator's refusal and must not be read as zero or as "gate everything" (standing rule 16),
    // and the absence is *recorded* rather than left as a blank the workpad cannot explain.
    const harness = estimating([]);
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.estimateUsd).toBeNull();
    expect(task.estimateBasis).toBe('unknown');
    expect(task.estimateSamples).toBe(0);
    expect(harness.types()).not.toContain('task.approval.requested');
    expect(task.task.state).toBe('ready_for_merge');
  });

  /**
   * **BD-027:14, for this gate**: the threshold comes from what the project was *given*.
   *
   * The stored document says `budget_approval_threshold_usd: 5` while `AUTONOMY_PRESETS.autonomous`
   * says `null` — a dial position with no budget gate at all. A gate that re-derived the preset from
   * `projects.autonomy_level` would let the task through; one that reads the materialised copy stops
   * it. The falsification is the same shape the plan gate's uses: a document the current table
   * cannot produce.
   */
  it('reads the threshold the project was given, not the one the release now ships', async () => {
    const shipped = materialiseAutonomy({
      level: 'autonomous',
      at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    const harness = harnessWith({
      cost: true,
      settings: {
        autonomy: {
          ...shipped,
          policies: { ...shipped.policies, budget_approval_threshold_usd: 5 },
        },
      },
    });
    harness.cost?.seedHistory(PROJECT, [{ size: 'M', costUsd: 6 }]);
    await harness.publish([ticketMatched()]);

    expect(requestedApproval(harness)?.payload.approval.kind).toBe('budget');
    // …and the source table still says this position has no budget gate, which is the difference.
    expect(AUTONOMY_PRESETS.autonomous.budgetApprovalThresholdUsd).toBeNull();
  });

  it('does not gate when the stored threshold is null, whatever the level’s name says', async () => {
    // The mirror of the case above, and the reason `null` is a statement rather than a missing
    // value: Observe and Autonomous both mean *"no budget approval at this position"*.
    const shipped = materialiseAutonomy({
      level: 'supervised',
      at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    const harness = harnessWith({
      cost: true,
      settings: {
        autonomy: {
          ...shipped,
          policies: {
            ...shipped.policies,
            budget_approval_threshold_usd: null,
            probation: false,
          },
        },
      },
    });
    harness.cost?.seedHistory(PROJECT, [{ size: 'M', costUsd: 10_000 }]);
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).estimateUsd).toBe(10_000);
    expect(harness.types()).not.toContain('task.approval.requested');
    expect(AUTONOMY_PRESETS.supervised.budgetApprovalThresholdUsd).toBe(THRESHOLD);
  });

  it('does not gate a project whose dial was never materialised', async () => {
    // `autonomy: null` keeps the **pre-WP-28** behaviour, which is no budget gate at all —
    // substituting a preset here would invent a threshold the project never chose (rule 16).
    const harness = harnessWith({
      cost: true,
      settings: { config: { policies: { probation_tasks: 0 } } },
    });
    harness.cost?.seedHistory(PROJECT, [{ size: 'M', costUsd: 10_000 }]);
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).estimateUsd).toBe(10_000);
    expect(harness.types()).not.toContain('task.approval.requested');
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('carries on to Implementation when a maintainer approves the spend', async () => {
    const harness = estimating([{ size: 'M', costUsd: THRESHOLD + 10 }]);
    await harness.publish([ticketMatched()]);
    const requested = requestedApproval(harness);

    await decideTaskApproval(harness.commands, {
      approvalId: requested?.payload.approval.id ?? '',
      decision: 'approved',
      userId: '00000000-0000-4000-8000-0000000000c1',
      role: 'maintainer',
    });
    await harness.drain();

    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(harness.specs.map((spec) => spec.stage)).toContain('implementation');
    // Countable effects, not a status code (standing rule 79): one approval row, one request, one
    // decision, and nothing asked a second time on the way through.
    expect(harness.types().filter((type) => type === 'task.approval.requested')).toHaveLength(1);
    expect(harness.types().filter((type) => type === 'task.approval.decided')).toHaveLength(1);
  });

  it('parks the task for a human when a maintainer rejects the spend, without spending it', async () => {
    // A rejected *budget* is not a rejected *plan*: there is no better plan to write, because the
    // estimate is written once and a second refinement round produces the same number. So the task
    // stops in the existing vocabulary — `needs_human` — instead of walking back into its own gate.
    const harness = estimating([{ size: 'M', costUsd: THRESHOLD + 10 }]);
    await harness.publish([ticketMatched()]);
    const requested = requestedApproval(harness);

    await decideTaskApproval(harness.commands, {
      approvalId: requested?.payload.approval.id ?? '',
      decision: 'rejected',
      userId: '00000000-0000-4000-8000-0000000000c1',
      role: 'maintainer',
      reason: 'not worth it this quarter',
    });
    await harness.drain();

    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement']);
    const escalated = harness.events().find((entry) => entry.type === 'task.escalated') as Extract<
      DomainEvent,
      { type: 'task.escalated' }
    >;
    expect(escalated.payload.blocker_brief).toContain('not worth it this quarter');
    expect(escalated.payload.blocker_brief).toContain('threshold');
    // Neither a second approval nor a return to refinement: the round is not spent.
    expect(harness.types().filter((type) => type === 'task.approval.requested')).toHaveLength(1);
    expect(taskOf(harness).task.stageAttempts.refinement).toBe(1);
  });

  it('does not ask again when the task goes round refinement a second time', async () => {
    // The estimate is written once, so a second round would put the *same* question to the same
    // maintainer. The lookup is therefore `(task, kind)` and not `(task, kind, stage, attempt)` —
    // `enteredAttempt` increments on every re-entry, which is what makes the attempt-keyed form
    // (the plan gate's, correctly) the wrong key here.
    const harness = estimating([{ size: 'M', costUsd: THRESHOLD + 10 }]);
    await harness.publish([ticketMatched()]);
    const requested = requestedApproval(harness);
    await decideTaskApproval(harness.commands, {
      approvalId: requested?.payload.approval.id ?? '',
      decision: 'approved',
      userId: '00000000-0000-4000-8000-0000000000c1',
      role: 'maintainer',
    });
    await harness.drain();
    const firstEstimate = taskOf(harness).estimateUsd;

    await returnToStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: '00000000-0000-4000-8000-0000000000c1',
      stage: 'refinement',
      reason: 'the scope changed',
    });
    await harness.drain();

    expect(taskOf(harness).task.stageAttempts.refinement).toBe(2);
    expect(taskOf(harness).estimateUsd).toBe(firstEstimate);
    expect(harness.types().filter((type) => type === 'task.approval.requested')).toHaveLength(1);
  });

  /**
   * The *"before Implementation"* half of product/09, over every shipped template.
   *
   * `ticket_lint`'s one stage also produces a `RefinedSpec` (WP-25) and its whole task is that one
   * short run, so gating it would park a lint comment in front of a maintainer for a spend that has
   * already happened. The predicate therefore asks the **compiled pipeline** rather than the
   * artifact type, and it is exported so this can drive it directly: reached through the saga it is
   * unreachable from the templates the harness runs, which would make it an untested inner layer
   * (standing rule 22).
   */
  describe('spendIsStillAhead, over every shipped template (standing rule 68)', () => {
    const compiled = (template: string): CompiledPipeline => {
      const shipped = SHIPPED_TEMPLATES[template];
      if (shipped === undefined) {
        throw new Error(`no shipped template "${template}"`);
      }
      return compilePipeline(template, shipped);
    };

    const specStageOf = (template: string): Slug => {
      const stage = compiled(template).stages.find((entry) => entry.produces === 'RefinedSpec');
      if (stage === undefined) {
        throw new Error(`no RefinedSpec stage in "${template}"`);
      }
      return stage.id;
    };

    it.each([
      ['feature', true],
      ['bug', true],
      ['chore', true],
      ['ticket_lint', false],
    ] as const)('answers %s with %s', (template, expected) => {
      expect(spendIsStillAhead(compiled(template), specStageOf(template))).toBe(expected);
    });

    it('answers false for a stage that does not produce the spec, and for one nobody has', () => {
      // Both halves of the first condition, so a predicate that returned true for every stage of a
      // template with an implementation in it would fail here rather than pass three cases above.
      expect(spendIsStillAhead(compiled('feature'), 'implementation' as Slug)).toBe(false);
      expect(spendIsStillAhead(compiled('feature'), 'nowhere' as Slug)).toBe(false);
    });

    it('has no RefinedSpec stage to gate at all in the discovery template', () => {
      // Stated rather than left implicit: `discovery` produces a draft, so the gate's first
      // condition can never hold for it and there is no stage id to pass above.
      expect(compiled('discovery').stages.some((stage) => stage.produces === 'RefinedSpec')).toBe(
        false,
      );
    });
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

  /**
   * WP-55 (PROGRESS backlog 67): the gate's finding reaches the run it was sent back to, inside the
   * data block the role prompt presents as feedback — and the gate's row says where it went.
   */
  it('hands the failing jobs to the next implementation run, and closes the gate’s row as a return', async () => {
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

    const [first, second] = harness.specs.filter((spec) => spec.stage === 'implementation');
    const feedbackOf = (prompt: string) =>
      readDataBlocks(prompt).blocks.filter((block) => block.kind === 'return_feedback');
    expect(feedbackOf(first?.userPrompt ?? '')).toEqual([]);
    const [feedback] = feedbackOf(second?.userPrompt ?? '');
    expect(feedback?.body).toContain('test:unit');

    const gateRow = harness.store.stageRows.find(
      (row) => row.stage === 'ci_gate' && row.attempt === 1,
    );
    expect(gateRow).toMatchObject({
      state: 'returned',
      outcome: 'returned',
      returnedTo: 'implementation',
    });
    expect(gateRow?.returnReason).toContain('test:unit');
  });

  /** WP-55 (PROGRESS backlog 95, items 1 and 2): guarded both ways, on both settlement paths. */
  it('closes a gate the event settled with its verdict, and leaves a gate still waiting open', async () => {
    const harness = withPendingCi();
    await harness.publish([ticketMatched()]);
    const waiting = harness.store.stageRows.find((row) => row.stage === 'ci_gate');
    // At the gate: neither an outcome nor an exit.
    expect(waiting).toMatchObject({ state: 'running', outcome: null, exitedAt: null });

    await harness.publish([
      event('ci.pipeline.finished', {
        project_id: PROJECT,
        task_id: taskOf(harness).task.id,
        mr: mergeRequest(false).ref,
        head_sha: 'b'.repeat(40),
        status: 'success',
        failed_jobs: [],
        coverage_pct: null,
      }),
    ]);
    const passed = harness.store.stageRows.find((row) => row.stage === 'ci_gate');
    expect(passed).toMatchObject({ state: 'completed', outcome: 'pass', returnedTo: null });
    expect(passed?.exitedAt).not.toBeNull();
  });

  it('closes a gate that fails forward as completed with the fail verdict', async () => {
    // No shipped template points a gate's `fail_to` forward; a project's own may, and the verdict
    // the row carries must be the one the gate reached, not the direction the task went.
    const feature = FEATURE_TEMPLATE;
    const forward = {
      ...feature,
      stages: feature.stages.map((stage) =>
        stage.id === 'ci_gate' ? { ...stage, fail_to: 'code_review' } : stage,
      ),
    };
    const harness = harnessWith({
      settings: { templates: { ...SHIPPED_TEMPLATES, feature: forward } as never },
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
    await harness.publish([
      event('ci.pipeline.finished', {
        project_id: PROJECT,
        task_id: taskOf(harness).task.id,
        mr: mergeRequest(false).ref,
        head_sha: 'b'.repeat(40),
        status: 'failed',
        failed_jobs: [{ name: 'test:unit', log_ref: 'log:1' }],
        coverage_pct: null,
      }),
    ]);
    const row = harness.store.stageRows.find((candidate) => candidate.stage === 'ci_gate');
    expect(row).toMatchObject({ state: 'completed', outcome: 'fail', returnedTo: null });
    expect(harness.specs.map((spec) => spec.stage)).toContain('code_review');
  });

  it('closes every gate the job settled on the way to ready_for_merge', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.currentStage).toBe('ready_for_merge');
    for (const stage of ['ci_gate', 'rebase_gate']) {
      const row = harness.store.stageRows.find((candidate) => candidate.stage === stage);
      expect(row, stage).toMatchObject({ state: 'completed', outcome: 'pass' });
      expect(row?.exitedAt, stage).not.toBeNull();
    }
    // The human stage the task is at is still open — a gate's close is not a sweep.
    expect(harness.store.stageRows.find((row) => row.stage === 'ready_for_merge')).toMatchObject({
      state: 'running',
      exitedAt: null,
    });
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
    // WP-55: the implementation run the first review sent back was given the review's own findings
    // in its feedback block — not the interpreter's literal "requested changes".
    const rerun = harness.specs.filter((spec) => spec.stage === 'implementation')[1];
    const feedback = readDataBlocks(rerun?.userPrompt ?? '').blocks.filter(
      (block) => block.kind === 'return_feedback',
    );
    expect(feedback.map((block) => block.body)).toEqual([
      '[summary] Reviewed.\n[major] src/totals.ts:12 — the footer sums the visible rows\n' +
        '[major] src/totals.ts:12 — the footer sums the visible rows',
    ]);
  });

  it('hands a review longer than the feedback cap to the next run cut in the marker, blockers intact', async () => {
    // The builder cuts nothing (WP-55 round 3): the assembler's `MAX_FEEDBACK_CHARS` is the only
    // cut, announced as `truncated="true"` on the block's marker — and blockers-first ordering is
    // what keeps the blocker inside it, although the reviewer listed it last.
    const long = (id: string) => ({
      ...FINDING(id),
      severity: 'minor',
      explanation: 'y'.repeat(3_000),
    });
    const harness = withRepeatedFindings([
      long('m1'),
      long('m2'),
      long('m3'),
      long('m4'),
      { ...FINDING('b1'), severity: 'blocker', explanation: 'the footer rounds twice' },
    ]);
    await harness.publish([ticketMatched()]);
    const rerun = harness.specs.filter((spec) => spec.stage === 'implementation')[1];
    const [block] = readDataBlocks(rerun?.userPrompt ?? '').blocks.filter(
      (entry) => entry.kind === 'return_feedback',
    );
    expect(block?.attributes.truncated).toBe('true');
    expect(Number(block?.attributes.original_chars)).toBeGreaterThan(MAX_FEEDBACK_CHARS);
    expect(block?.body.length).toBe(MAX_FEEDBACK_CHARS);
    expect(block?.body.split('\n').slice(0, 2)).toEqual([
      '[summary] Reviewed.',
      '[blocker] src/totals.ts:12 — the footer rounds twice',
    ]);
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
  it('resolves the conflict in a short run and stops at the loop’s limit (product/04 S6b)', async () => {
    const harness = harnessWith({ git: { getMergeRequest: async () => mergeRequest(true) } });
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);
    // product/04 S6b bounds the rebase gate at 2 attempts; a branch that conflicts every time uses
    // both and then parks for a human rather than looping.
    expect(task.task.iterationCounters.rebase).toBe(2);
    expect(task.task.state).toBe('needs_human');
    expect(task.task.currentStage).toBe('rebase_gate');
    // **Two resolution runs, not three implementation runs** (WP-26). The failure used to re-enter
    // `implementation`, which re-did the ticket at $15 a go to fix a merge conflict; it now enters
    // the short run product/04 S6b asks for, and the *implementation* stage runs exactly once.
    expect(harness.specs.filter((spec) => spec.stage === 'conflict_resolution')).toHaveLength(2);
    expect(harness.specs.filter((spec) => spec.stage === 'implementation')).toHaveLength(1);
    // Each attempt re-runs CI through the gate the platform already has, which is what putting the
    // stage before `ci_gate` buys: three passes of the CI gate — the first delivery and one per
    // resolution.
    expect(task.task.stageAttempts.ci_gate).toBe(3);
    // The metric product/16 asks for, on the events rather than derived from the escalation's prose.
    const outcomes = harness
      .events()
      .filter((entry) => entry.type === 'task.rebase.checked')
      .map((entry) => (entry.payload as { outcome: string }).outcome);
    expect(outcomes).toEqual(['conflicted', 'conflicted', 'exhausted']);
  });

  it('records a clean check as clean, and one that took a run as resolved', async () => {
    // The other direction (standing rule 42): the same harness with a branch that applies.
    const clean = harnessWith();
    await clean.publish([ticketMatched()]);
    expect(
      clean
        .events()
        .filter((entry) => entry.type === 'task.rebase.checked')
        .map((entry) => (entry.payload as { outcome: string; attempt: number }).outcome),
    ).toEqual(['clean']);
    expect(clean.specs.filter((spec) => spec.stage === 'conflict_resolution')).toHaveLength(0);

    // And a branch that conflicts once: the resolution run, then a gate that passes — which is
    // product/16's "resolved automatically".
    let conflicts = true;
    const resolved = harnessWith({
      git: {
        getMergeRequest: async () => {
          const answer = mergeRequest(conflicts);
          conflicts = false;
          return answer;
        },
      },
    });
    await resolved.publish([ticketMatched()]);
    expect(taskOf(resolved).task.state).toBe('ready_for_merge');
    expect(resolved.specs.filter((spec) => spec.stage === 'conflict_resolution')).toHaveLength(1);
    expect(
      resolved
        .events()
        .filter((entry) => entry.type === 'task.rebase.checked')
        .map((entry) => {
          const payload = entry.payload as {
            outcome: string;
            attempt: number;
            conflicts: boolean;
          };
          return {
            outcome: payload.outcome,
            attempt: payload.attempt,
            conflicts: payload.conflicts,
          };
        }),
    ).toEqual([
      { outcome: 'conflicted', attempt: 0, conflicts: true },
      { outcome: 'resolved', attempt: 1, conflicts: false },
    ]);
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
    /**
     * **The re-check spends its own loop, and not a human round** (WP-26).
     *
     * This line read `human_rounds` until WP-26, which is the defect rather than the assertion: a
     * merge to the default branch is not a round with a person, and BD-008 bounds human MR rounds
     * at 3 — so the fourth merge to `main` under a waiting merge request escalated the task with
     * *"human_rounds iteration limit of 3 reached: main moved to …"*. Both counters are asserted,
     * because "the right one moved" and "the wrong one did not" are two facts (standing rule 42).
     */
    expect(taskOf(harness).task.iterationCounters.rebase_rechecks).toBe(1);
    expect(taskOf(harness).task.iterationCounters.human_rounds).toBeUndefined();
  });

  it('keeps re-checking past the human-round limit, and parks when its own loop is spent', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    const moves = DEFAULT_ITERATION_LIMITS.rebase_rechecks;
    for (let move = 0; move < moves; move += 1) {
      await harness.publish([
        event('default_branch.moved', {
          project_id: PROJECT,
          branch: 'main',
          new_head: `${move}`.padStart(40, 'd'),
        }),
      ]);
    }
    // Ten merges to `main` — more than three times BD-008's human-round limit — and the task is
    // still waiting for its human rather than parked under somebody else's counter.
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(taskOf(harness).task.iterationCounters.rebase_rechecks).toBe(moves);

    // The bound is real, though: the next one spends a round that is not there.
    await harness.publish([
      event('default_branch.moved', {
        project_id: PROJECT,
        branch: 'main',
        new_head: 'e'.repeat(40),
      }),
    ]);
    expect(taskOf(harness).task.state).toBe('needs_human');
    const escalation = harness
      .events()
      .filter((entry) => entry.type === 'task.escalated')
      .at(-1) as Extract<DomainEvent, { type: 'task.escalated' }>;
    expect(escalation.payload.reason).toContain('rebase_rechecks iteration limit of 10');
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
