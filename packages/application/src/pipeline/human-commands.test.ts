/**
 * The nine commands of WP-15i, against the pipeline harness — every one of them from a state that
 * **admits** it and from a state that **refuses** it.
 *
 * Both halves matter and the second is the one that is usually missing (standing rule 42): a
 * command that refused everything would pass a test that only drove the happy path, and a command
 * that refused nothing would pass one that only drove the refusal. Each case below therefore names
 * the transition it expects to be refused, and asserts a **countable effect** for the admitted one —
 * an event, a run, an attempt number — rather than the absence of an exception (rule 79).
 *
 * ## Where the state comes from
 *
 * Nearly every state is reached by driving the real pipeline: `harness.publish([ticketMatched()])`
 * walks a feature ticket to `ready_for_merge`, and a refinement scripted to **ask** parks the task
 * at `waiting_answers` on an agent stage — the same shipped mechanism WP-15h's e2e uses.
 *
 * Three states are **seeded** through the store instead, and each is seeded because the harness
 * cannot produce it rather than because seeding was easier: an iteration counter that has already
 * been spent (the loop that would produce it escalates the task first, and `needs_human` refuses a
 * return by design), and a run that is still `running` (the harness's runner completes
 * synchronously, so no live run exists at any moment a test can observe). The e2e tier drives both
 * against a real instance, where a run really can be held open.
 */
import type { Id, Slug } from '@platform/contracts';
import { IllegalTransitionError, InvariantViolationError } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  createPipelineHarness,
  type PipelineHarness,
  type ScriptedRun,
} from '../testing/pipeline-harness.js';
import {
  answerTaskQuestion,
  CommandsUnavailableError,
  cancelRunCommand,
  cancelTaskCommand,
  decideTaskApproval,
  IterationLimitReachedError,
  pauseTaskCommand,
  RunNotLiveError,
  resumeTaskCommand,
  retryRunCommand,
  retryStageCommand,
  returnToStageCommand,
  reworkStageCommand,
  StageNotCurrentError,
  submitFeedbackCommand,
  UnknownAggregateError,
} from './commands.js';
import type { StoredTask } from './store.js';
import { TaskConcurrentModificationError } from './store.js';
import { TaskConflictExhaustedError } from './task-conflict.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const USER = '00000000-0000-4000-8000-0000000000e9' as Id;

/** Obviously fake, planted so its absence from a stored reason is a measurement (rule 45). */
const PLANTED_SECRET = 'glpat-FAKE-wp15i-planted-credential-00';

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
      // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
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

const ASKING_SPEC = {
  ...REFINED_SPEC,
  decision: 'ask',
  questions: [{ id: 'q1', text: 'Which provider should the footer total?', blocking: true }],
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

const NOTES = {
  summary: 'Added the footer sum.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: 'green' }],
  known_gaps: [],
  followup_tickets: [],
  mr: {
    url: 'https://git.example.test/acme/api/-/merge_requests/7',
    iid: 7,
    head_sha: 'b'.repeat(40),
    branch: 'agentic/acme-1',
  },
};

const REVIEW = {
  verdict: 'approve',
  findings: [],
  summary: 'Reviewed.',
  protected_path_changes_confirmed: [],
};

const ACCEPTANCE = {
  verdict: 'approve',
  criteria: [{ id: 'ac1', status: 'met', evidence: 'test' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
};

const RETRO = {
  what_went_well: ['the plan held'],
  returns: [],
  human_corrections: [],
  cost_summary: '1.25 USD',
  proposals: [],
};

const LIBRARIAN = { proposals: [], health: [], summary: 'Nothing to curate.' };

const ok = (structuredOutput: unknown): ScriptedRun => ({
  status: 'completed',
  terminalReason: 'success',
  structuredOutput,
});

const runs = (overrides: Readonly<Record<string, ScriptedRun>> = {}) => ({
  refinement: ok(REFINED_SPEC),
  architecture: ok(PLAN),
  implementation: ok(NOTES),
  code_review: ok(REVIEW),
  business_review: ok(ACCEPTANCE),
  retrospective: ok(RETRO),
  librarian: ok(LIBRARIAN),
  ...overrides,
});

const harnessWith = (options: Parameters<typeof createPipelineHarness>[0] = {}) =>
  createPipelineHarness({
    projectId: PROJECT,
    runs: runs(options.runs),
    commandSecrets: [{ name: 'git-token', value: PLANTED_SECRET }],
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
      getMergeRequest: async () => ({
        ref: {
          provider: 'fake-git',
          project_path: 'acme/api',
          iid: 7,
          url: 'https://git.example.test/acme/api/-/merge_requests/7',
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
        has_conflicts: false,
        labels: [],
        reviewers: [],
        web_url: 'https://git.example.test/acme/api/-/merge_requests/7',
      }),
      ...options.git,
    },
    ...options,
  });

let stream = 0;

const ticketMatched = () => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return {
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project' as const,
    // A stream of its own per delivery, at sequence 1 — the shape an inbound adapter appends and
    // the one `saga.test.ts` uses: every case here builds a fresh harness, so a counter shared
    // across cases would claim a sequence the new log has never reached.
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: {
      kind: 'integration' as const,
      integration_id: PROJECT,
      provider: 'fake-jira',
    },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched' as const,
    payload: {
      project_id: PROJECT,
      ticket: TICKET,
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  };
};

const taskOf = (harness: PipelineHarness): StoredTask => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const countOf = (harness: PipelineHarness, type: string): number =>
  harness.events().filter((event) => event.type === type).length;

/** The payload of the first event of this type, or a failure that names the missing event. */
const payloadOf = <T>(harness: PipelineHarness, type: string): T => {
  const event = harness.events().find((entry) => entry.type === type);
  if (event === undefined) {
    throw new Error(`no ${type} event was appended`);
  }
  return event.payload as T;
};

/** A task at `ready_for_merge`, having walked the whole template. */
const walked = async (options: Parameters<typeof createPipelineHarness>[0] = {}) => {
  const harness = harnessWith(options);
  await harness.publish([ticketMatched()]);
  expect(taskOf(harness).task.state).toBe('ready_for_merge');
  return harness;
};

/** A task parked on a blocking question at `refinement` — an **agent** stage, unlike the above. */
const asking = async (options: Parameters<typeof createPipelineHarness>[0] = {}) => {
  const harness = harnessWith({
    ...options,
    runs: { refinement: ok(ASKING_SPEC), ...options.runs },
  });
  await harness.publish([ticketMatched()]);
  expect(taskOf(harness).task.state).toBe('waiting_answers');
  expect(taskOf(harness).task.currentStage).toBe('refinement');
  return harness;
};

describe('pause', () => {
  it('pauses a task that is running and refuses a second pause by naming the transition', async () => {
    const harness = await walked();
    const task = taskOf(harness).task.id;

    await pauseTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    expect(taskOf(harness).task.state).toBe('paused');
    expect(countOf(harness, 'task.paused')).toBe(1);

    await expect(
      pauseTaskCommand(harness.humanCommands, { taskId: task, userId: USER }),
    ).rejects.toThrow(IllegalTransitionError);
    // The refusal performed nothing: one event, not two (standing rule 79).
    expect(countOf(harness, 'task.paused')).toBe(1);
    expect(taskOf(harness).task.state).toBe('paused');
  });

  it('records the person as the actor, not the pipeline', async () => {
    const harness = await walked();
    await pauseTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
    });
    const paused = harness.events().find((event) => event.type === 'task.paused');
    expect(paused?.actor).toEqual({ kind: 'user', user_id: USER });
  });

  it('refuses a task that does not exist', async () => {
    const harness = harnessWith();
    await expect(
      pauseTaskCommand(harness.humanCommands, {
        taskId: '00000000-0000-4000-8000-00000000dead' as Id,
        userId: USER,
      }),
    ).rejects.toThrow(UnknownAggregateError);
  });
});

describe('resume', () => {
  it('re-enters the stage a paused task stopped at, and the stage runs again', async () => {
    const harness = await asking();
    const task = taskOf(harness).task.id;
    await pauseTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    const runsBefore = harness.specs.length;

    await resumeTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    expect(taskOf(harness).task.state).toBe('active');
    expect(taskOf(harness).task.currentStage).toBe('refinement');
    expect(countOf(harness, 'task.resumed')).toBe(1);
    // The countable effect: the stage was enqueued, and playing the worker runs it again.
    await harness.drain();
    expect(harness.specs.length).toBeGreaterThan(runsBefore);
    expect(harness.specs.at(-1)?.stage).toBe('refinement');
  });

  it('spends no iteration round: resuming is standing still, not going round', async () => {
    const harness = await asking();
    const task = taskOf(harness).task.id;
    const before = taskOf(harness).task.iterationCounters;
    await pauseTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    await resumeTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    expect(taskOf(harness).task.iterationCounters).toEqual(before);
  });

  it('refuses to resume at a stage the paused state has no edge to', async () => {
    // A task paused at `ready_for_merge` is the case: `paused → ready_for_merge` is not in
    // technical/02's table, so the honest answer is the refusal rather than a silent no-op or a
    // task quietly moved to `active` at a stage that means "waiting for a human to merge".
    const harness = await walked();
    const task = taskOf(harness).task.id;
    await pauseTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    await expect(
      resumeTaskCommand(harness.humanCommands, { taskId: task, userId: USER }),
    ).rejects.toThrow(IllegalTransitionError);
    expect(taskOf(harness).task.state).toBe('paused');
  });

  it('refuses on a process with no queue, before it writes anything', async () => {
    const harness = await asking();
    const task = taskOf(harness).task.id;
    await pauseTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    await expect(
      resumeTaskCommand({ ...harness.humanCommands, jobs: null }, { taskId: task, userId: USER }),
    ).rejects.toThrow(CommandsUnavailableError);
    // The task is where it was: a command that cannot finish must not half-finish.
    expect(taskOf(harness).task.state).toBe('paused');
  });
});

describe('cancel', () => {
  it('cancels with the totals the runs actually produced, and refuses a second cancel', async () => {
    const harness = await walked();
    const task = taskOf(harness).task.id;

    await cancelTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    expect(taskOf(harness).task.state).toBe('cancelled');
    const cancelled = harness.events().find((event) => event.type === 'task.cancelled');
    const totals = (cancelled?.payload as { totals: { runs: number } } | undefined)?.totals;
    expect(totals).toBeDefined();
    expect(totals?.runs).toBe(harness.specs.length);

    await expect(
      cancelTaskCommand(harness.humanCommands, { taskId: task, userId: USER }),
    ).rejects.toThrow(IllegalTransitionError);
    expect(countOf(harness, 'task.cancelled')).toBe(1);
  });
});

describe('retry-stage', () => {
  it('runs the current stage again as a new attempt', async () => {
    const harness = await asking();
    const task = taskOf(harness).task.id;
    expect(taskOf(harness).task.stageAttempts.refinement).toBe(1);

    await retryStageCommand(harness.humanCommands, {
      taskId: task,
      userId: USER,
      stage: 'refinement' as Slug,
    });
    expect(taskOf(harness).task.stageAttempts.refinement).toBe(2);
    await harness.drain();
    expect(harness.specs.at(-1)?.attempt).toBe(2);
  });

  it('refuses a stage the task is not at, because that would be a return', async () => {
    const harness = await asking();
    await expect(
      retryStageCommand(harness.humanCommands, {
        taskId: taskOf(harness).task.id,
        userId: USER,
        stage: 'architecture' as Slug,
      }),
    ).rejects.toThrow(StageNotCurrentError);
    expect(taskOf(harness).task.stageAttempts.architecture).toBeUndefined();
  });
});

describe('return-to-stage', () => {
  it('sends the task back, counts a human round and redacts the reason it stores', async () => {
    const harness = await walked();
    const task = taskOf(harness).task.id;

    await returnToStageCommand(harness.humanCommands, {
      taskId: task,
      userId: USER,
      stage: 'implementation' as Slug,
      reason: `redo it with the token ${PLANTED_SECRET} rotated`,
    });

    const returned = harness.events().find((event) => event.type === 'task.stage.returned');
    const payload = returned?.payload as unknown as {
      reason: string;
      to_stage: string;
      from_stage: string;
    };
    expect(payload.to_stage).toBe('implementation');
    expect(payload.from_stage).toBe('ready_for_merge');
    // TD-012 at the one place the text is written: the credential is gone and the rest is not.
    expect(payload.reason).not.toContain(PLANTED_SECRET);
    expect(payload.reason).toContain('redo it with the token');
    expect(taskOf(harness).task.iterationCounters.human_rounds).toBe(1);
  });

  it('refuses when the human loop is spent, and leaves the task where it was', async () => {
    // BD-008 bounds human rounds; with a limit of one, the second return has no round to spend.
    // The point of the case is the **ending**: `returnToStage` would escalate the task to
    // `needs_human`, and no HTTP request may do that (WP-15i, criterion 6).
    const harness = await walked({
      settings: { config: { pipeline: { limits: { human_rounds: 1 } } } },
    });
    const task = taskOf(harness).task.id;
    await returnToStageCommand(harness.humanCommands, {
      taskId: task,
      userId: USER,
      stage: 'implementation' as Slug,
      reason: 'once',
    });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('ready_for_merge');

    await expect(
      returnToStageCommand(harness.humanCommands, {
        taskId: task,
        userId: USER,
        stage: 'implementation' as Slug,
        reason: 'twice',
      }),
    ).rejects.toThrow(IterationLimitReachedError);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(countOf(harness, 'task.escalated')).toBe(0);
    expect(taskOf(harness).task.iterationCounters.human_rounds).toBe(1);
  });

  it('refuses a task that has finished', async () => {
    const harness = await walked();
    const task = taskOf(harness).task.id;
    await cancelTaskCommand(harness.humanCommands, { taskId: task, userId: USER });
    await expect(
      returnToStageCommand(harness.humanCommands, {
        taskId: task,
        userId: USER,
        stage: 'implementation' as Slug,
        reason: 'too late',
      }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

describe('rework', () => {
  it('returns the task and resets the agent-to-agent counters, keeping the human ones', async () => {
    const harness = await walked();
    const stored = taskOf(harness);
    // Seeded, because the loop that produces a spent counter escalates the task to `needs_human`
    // first — and a return from `needs_human` is refused by design (it is a hand-back, WP-27).
    await harness.memory.transaction(async (scope) => {
      await harness.store.tasks.save(scope.tx, {
        ...stored,
        task: { ...stored.task, iterationCounters: { code_review: 2, ci_fix: 1 } },
      });
    });

    await reworkStageCommand(harness.humanCommands, {
      taskId: stored.task.id,
      userId: USER,
      stage: 'architecture' as Slug,
      instructions: 'take the other approach',
    });

    const counters = taskOf(harness).task.iterationCounters;
    expect(counters.code_review).toBe(0);
    expect(counters.ci_fix).toBe(0);
    expect(counters.human_rounds).toBe(1);
    const returned = harness.events().find((event) => event.type === 'task.stage.returned');
    expect((returned?.payload as unknown as { reason: string } | undefined)?.reason).toBe(
      'take the other approach',
    );
  });

  it('refuses when the human loop is spent, exactly as a return does', async () => {
    const harness = await walked({
      settings: { config: { pipeline: { limits: { human_rounds: 0 } } } },
    });
    await expect(
      reworkStageCommand(harness.humanCommands, {
        taskId: taskOf(harness).task.id,
        userId: USER,
        stage: 'architecture' as Slug,
        instructions: 'again',
      }),
    ).rejects.toThrow(IterationLimitReachedError);
    expect(countOf(harness, 'task.escalated')).toBe(0);
  });
});

describe('feedback', () => {
  it('records the feedback as its event, redacted, and moves the task not at all', async () => {
    const harness = await walked();
    const stored = taskOf(harness);

    const { feedbackId } = await submitFeedbackCommand(harness.humanCommands, {
      taskId: stored.task.id,
      userId: USER,
      scope: 'stage',
      stage: 'code_review' as Slug,
      text: `the review missed ${PLANTED_SECRET} in the diff`,
      rating: 2,
      channel: 'ui',
    });

    const event = harness.events().find((entry) => entry.type === 'feedback.received');
    const feedback = (event?.payload as { feedback: Record<string, unknown> } | undefined)
      ?.feedback;
    expect(feedback).toBeDefined();
    expect(feedback?.id).toBe(feedbackId);
    expect(feedback?.scope).toBe('stage');
    expect(feedback?.stage).toBe('code_review');
    expect(feedback?.rating).toBe(2);
    expect(feedback?.author_user_id).toBe(USER);
    expect(feedback?.text).not.toContain(PLANTED_SECRET);
    expect(feedback?.text).toContain('the review missed');
    // An opinion is not a transition.
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('refuses feedback scoped to a stage it does not name', async () => {
    const harness = await walked();
    await expect(
      submitFeedbackCommand(harness.humanCommands, {
        taskId: taskOf(harness).task.id,
        userId: USER,
        scope: 'stage',
        text: 'no stage given',
        channel: 'ui',
      }),
    ).rejects.toThrow(InvariantViolationError);
    expect(countOf(harness, 'feedback.received')).toBe(0);
  });
});

describe('the two commands that predate this row', () => {
  /**
   * `answerTaskQuestion` and `decideTaskApproval` are the older pair, and until WP-15i's pre-merge
   * round they were the two whose free text was **not** redacted: the module note claimed every
   * command redacts what it stores and three of the five did. Both cases below plant a credential
   * and read the stored aggregate as well as the event, because the answer is read back into the
   * next prompt of the stage that asked (`StageRunRequest`) and the event is what a transcript and
   * every projection carry.
   */
  it('redacts the answer it stores on the question and publishes in the event', async () => {
    const harness = await asking();
    const questionId = payloadOf<{ question: { id: Id } }>(harness, 'task.question.asked').question
      .id;

    // The stage runs again on the answer, and its second attempt must not ask again.
    harness.script('refinement', ok(REFINED_SPEC));
    await answerTaskQuestion(harness.commands, {
      questionId,
      answer: `use the token ${PLANTED_SECRET} for the sandbox`,
      userId: USER,
      role: 'member',
      channel: 'ui',
    });
    await harness.drain();

    const stored = await harness.memory.transaction(async (scope) =>
      harness.store.questions.load(scope.tx, questionId),
    );
    expect(stored?.status).toBe('answered');
    expect(stored?.answer).not.toContain(PLANTED_SECRET);
    // The other half (rule 42): the words around the credential survive, so this is redaction and
    // not "the field was emptied".
    expect(stored?.answer).toContain('use the token');
    expect(stored?.answer).toContain('for the sandbox');
    expect(payloadOf<{ answer: string }>(harness, 'task.question.answered').answer).toBe(
      stored?.answer,
    );
    expect(JSON.stringify(harness.events())).not.toContain(PLANTED_SECRET);
  });

  it('redacts the reason a rejected approval carries', async () => {
    // `runs(...)` rather than a bare override: `harnessWith` spreads `options` last, so an
    // `options.runs` replaces the merged set instead of adding to it (the shape `asking()` uses).
    const harness = harnessWith({
      runs: runs({ architecture: ok({ ...PLAN, estimated_size: 'XL' }) }),
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('waiting_approval');
    const approvalId = payloadOf<{ approval: { id: Id } }>(harness, 'task.approval.requested')
      .approval.id;

    harness.script('architecture', ok(PLAN));
    await decideTaskApproval(harness.commands, {
      approvalId,
      decision: 'rejected',
      userId: USER,
      role: 'maintainer',
      reason: `the plan pastes ${PLANTED_SECRET} into the config`,
    });
    await harness.drain();

    const stored = await harness.memory.transaction(async (scope) =>
      harness.store.approvals.load(scope.tx, approvalId),
    );
    expect(stored?.approval.status).toBe('rejected');
    expect(stored?.approval.reason).not.toContain(PLANTED_SECRET);
    expect(stored?.approval.reason).toContain('the plan pastes');
    expect(payloadOf<{ reason: string | null }>(harness, 'task.approval.decided').reason).toBe(
      stored?.approval.reason,
    );
    expect(JSON.stringify(harness.events())).not.toContain(PLANTED_SECRET);
  });
});

/** A `running` run row for the task's current stage attempt — see this file's docblock. */
const seedLiveRun = async (harness: PipelineHarness, stage: Slug): Promise<Id> => {
  const stored = taskOf(harness);
  const runId = harness.ids.next();
  await harness.memory.transaction(async (scope) => {
    await harness.store.runs.insert(scope.tx, {
      id: runId,
      taskId: stored.task.id,
      projectId: stored.task.projectId,
      stage,
      role: 'product_manager',
      mode: 'normal',
      attempt: stored.task.stageAttempts[stage] ?? 1,
      model: 'claude-opus-5',
      effort: 'medium',
      promptVersion: 'harness@1',
      status: 'running',
      terminalReason: null,
      sessionId: 'session-live',
      numTurns: 2,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: harness.clock.now(),
      startedAt: harness.clock.now(),
    });
  });
  return runId;
};

describe('cancel a run', () => {
  it('ends the run, pauses its task and refuses a second cancellation', async () => {
    const harness = await asking();
    const runId = await seedLiveRun(harness, 'refinement' as Slug);

    const { taskId } = await cancelRunCommand(harness.humanCommands, { runId, userId: USER });
    expect(taskId).toBe(taskOf(harness).task.id);

    const run = await harness.memory.transaction(async (scope) =>
      harness.store.runs.load(scope.tx, runId),
    );
    expect(run?.status).toBe('cancelled');
    expect(run?.terminalReason).toBe('cancelled');
    // The task stops with it: the pipeline must not act on an attempt nobody will finish.
    expect(taskOf(harness).task.state).toBe('paused');
    const finished = harness
      .events()
      .filter((event) => event.type === 'run.finished' && event.stream_id === runId);
    expect(finished).toHaveLength(1);
    expect((finished[0]?.payload as { status: string } | undefined)?.status).toBe('cancelled');

    await expect(cancelRunCommand(harness.humanCommands, { runId, userId: USER })).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it('refuses a run that has already completed, naming its status', async () => {
    const harness = await asking();
    const completed = harness.specs.at(-1)?.runId as Id;
    await expect(
      cancelRunCommand(harness.humanCommands, { runId: completed, userId: USER }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it('refuses a run nobody has heard of', async () => {
    const harness = await asking();
    await expect(
      cancelRunCommand(harness.humanCommands, {
        runId: '00000000-0000-4000-8000-00000000beef' as Id,
        userId: USER,
      }),
    ).rejects.toThrow(UnknownAggregateError);
  });
});

describe('retry a run', () => {
  it('starts a new attempt of the run’s stage on the model the human chose', async () => {
    const harness = await asking();
    const completed = harness.specs.at(-1)?.runId as Id;

    const outcome = await retryRunCommand(harness.humanCommands, {
      runId: completed,
      userId: USER,
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
    expect(outcome.stage).toBe('refinement');
    expect(taskOf(harness).task.stageAttempts.refinement).toBe(2);

    await harness.drain();
    const retried = harness.specs.at(-1);
    expect(retried?.attempt).toBe(2);
    // The override reached the spec, which is the only thing that proves it was carried at all.
    expect(retried?.model).toBe('claude-haiku-4-5');
    expect(retried?.effort).toBe('low');
    // …and it is **this attempt's**: the project's configuration is untouched, so the next entry
    // of the same stage is back on the template's model.
    await retryStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage: 'refinement' as Slug,
    });
    await harness.drain();
    expect(harness.specs.at(-1)?.model).not.toBe('claude-haiku-4-5');
  });

  it('refuses a run that is still going: cancel it first', async () => {
    const harness = await asking();
    const runId = await seedLiveRun(harness, 'refinement' as Slug);
    await expect(retryRunCommand(harness.humanCommands, { runId, userId: USER })).rejects.toThrow(
      RunNotLiveError,
    );
  });

  it('refuses a run whose stage the task has already left', async () => {
    const harness = await walked();
    // The first run is refinement's; the task is at `ready_for_merge` now.
    const first = harness.specs[0]?.runId as Id;
    await expect(
      retryRunCommand(harness.humanCommands, { runId: first, userId: USER }),
    ).rejects.toThrow(StageNotCurrentError);
  });
});

describe('a command that loses every race', () => {
  it('answers the caller rather than escalating the task (WP-15e’s ending, inverted)', async () => {
    const harness = await walked();
    const stored = taskOf(harness);
    // A store whose `save` always refuses, which is what a command racing a running stage sees
    // once its bound is spent. The instrument is the refusal itself: `retryOnTaskConflict` re-runs
    // the unit, and every attempt loses.
    const conflicting = {
      ...harness.humanCommands,
      store: {
        ...harness.store,
        tasks: {
          ...harness.store.tasks,
          save: async () => {
            throw new TaskConcurrentModificationError(stored.task.id, stored.version, 999);
          },
        },
      },
    };

    await expect(
      pauseTaskCommand(conflicting, { taskId: stored.task.id, userId: USER }),
    ).rejects.toThrow(TaskConflictExhaustedError);
    // Not escalated, not paused, not moved: the caller is told and the task is where they left it.
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(countOf(harness, 'task.escalated')).toBe(0);
  });
});
