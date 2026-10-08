/**
 * WP-178 — one human-return window over four signals, at `qa` and at `ready_for_merge`, and the QA
 * stage's endings (BD-031 rulings 3 and 4, TD-029 decisions 6–9, technical/02's M10-head amendment).
 *
 * Driven through the real handlers, the real window job, the real interpreter and the real stage
 * executor over the harness, with a tracker double that keeps one ticket's assignee, status and
 * comments and a git double whose discussions a case writes. Every assertion is a countable effect
 * — a `task.stage.returned`, a `task.human_return`, the stage the task waits at, the next run's
 * `return_feedback` block — never a return value.
 *
 * Every status name, note and comment is an invented fixture value (BD-031 ruling 1).
 */
import type { DomainEvent, ExternalIdentity, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { readDataBlocks, resolveIterationLimits } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { Discussion } from '../ports/integrations/git-provider.js';
import type {
  TaskManagementPort,
  TicketComment,
  TicketRefInput,
} from '../ports/integrations/task-management.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import type { BindingLifecycle } from './binding-lifecycle.js';
import { MAX_REVIEW_FEEDBACK_CHARS } from './review-threads.js';
import { DEFAULT_REVIEW_COMMENT_WINDOW_MS } from './saga.js';
import { INITIAL_TASK_VERSION, type StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b8' as Id;
const SELF_ID = 'agentic-bot';
const WINDOW = DEFAULT_REVIEW_COMMENT_WINDOW_MS;

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-8',
  url: 'https://jira.example.test/browse/ACME-8',
} as const;

const person = (external_id: string, provider = 'fake-jira'): ExternalIdentity => ({
  provider,
  external_id,
  verified: false,
});

// ── The tracker double: one ticket's assignee, status and comments ──────────

const tracker = (options: { readonly refuseStatus?: string } = {}) => {
  const state = {
    assignee: null as string | null,
    status: 'Ready for the agent',
    comments: [] as TicketComment[],
  };
  const port: Partial<TaskManagementPort> = {
    readTicket: async (ref: TicketRefInput) => ({
      ref,
      issue_type: 'Story',
      title: 'Show the totals in the invoice footer',
      description: 'The footer sums the visible rows rather than all of them.',
      status: state.status,
      priority: null,
      labels: [],
      comments: [],
      links: [],
      epic: null,
      siblings: [],
      attachments_text: [],
      assignee: state.assignee === null ? null : person(state.assignee),
      reporter: null,
      updated_at: '2026-06-01T09:00:00.000Z',
    }),
    selfIdentity: async () => person(SELF_ID),
    assignToSelf: async () => {
      const changed = state.assignee !== SELF_ID;
      state.assignee = SELF_ID;
      return { changed, assignee: person(SELF_ID) };
    },
    unassign: async () => {
      const changed = state.assignee === SELF_ID;
      if (changed) state.assignee = null;
      return { changed };
    },
    transition: async (_ref: TicketRefInput, to: string) => {
      if (to === options.refuseStatus) {
        throw new Error(`the tracker refused the move to ${to}`);
      }
      const from = state.status;
      state.status = to;
      return { changed: from !== to, from, to };
    },
    listComments: async (_ref: TicketRefInput, listOptions: { since?: string | null }) => {
      const since = listOptions.since ?? null;
      const comments = state.comments
        .filter((comment) => since === null || Date.parse(comment.created_at) > Date.parse(since))
        .reverse();
      return { comments, total: comments.length };
    },
  };
  return { state, port };
};

// ── Fixtures: the feature template, every stage approving ──────────────────

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
      // biome-ignore lint/suspicious/noThenProperty: it is the published field name
      then: 'the footer shows the sum',
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

const MR_URL = 'https://git.example.test/acme/api/-/merge_requests/8';

const NOTES = {
  summary: 'Added the footer sum.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: 'green' }],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: MR_URL, iid: 8, head_sha: 'b'.repeat(40), branch: 'agentic/acme-8' },
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
  cost_summary: { total_usd: 1.25, is_estimate: false, by_stage: [] },
  proposals: [],
};

const LIBRARIAN = { proposals: [], health: [], summary: 'nothing to add' };

const completed = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

const RUNS = {
  refinement: completed(REFINED_SPEC),
  architecture: completed(PLAN),
  implementation: completed(NOTES),
  code_review: completed(REVIEW),
  business_review: completed(ACCEPTANCE),
  retrospective: completed(RETRO),
  librarian: completed(LIBRARIAN),
};

const MR_REF = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 8,
  url: MR_URL,
  branch: 'agentic/acme-8',
  head_sha: 'b'.repeat(40),
};

const mergeRequest = {
  ref: MR_REF,
  state: 'opened' as const,
  draft: true,
  title: 'Draft: totals',
  description: '',
  source_branch: 'agentic/acme-8',
  target_branch: 'main',
  head_sha: 'b'.repeat(40),
  mergeable: true,
  has_conflicts: false,
  labels: [],
  reviewers: [],
  web_url: MR_URL,
};

/** Every slot mapped to an invented name; `qa` only when the case wants the stage. */
const lifecycle = (withQa: boolean): BindingLifecycle => ({
  pickUpFrom: 'Ready for the agent',
  slots: {
    in_progress: 'Doing',
    in_review: 'Waiting for review',
    approved: 'Reviewed',
    ...(withQa ? { qa: 'Testing' } : {}),
    returned: ['Sent back'],
  },
});

type HumanStage = 'qa' | 'ready_for_merge';
const HUMAN_STAGES: readonly HumanStage[] = ['qa', 'ready_for_merge'];

interface Waiting {
  readonly harness: PipelineHarness;
  readonly ticket: ReturnType<typeof tracker>;
  readonly discussions: Discussion[];
}

/**
 * A task that waits at `stage`. `onCiCheck` runs on each CI read — the gate between the
 * implementation run and the agent's reviews — which is how a case writes a note "while the review
 * stages ran" on a clock that does not move by itself.
 */
const waitingAt = async (
  stage: HumanStage,
  options: {
    readonly harness?: Partial<HarnessOptions>;
    readonly onCiCheck?: (harness: PipelineHarness, discussions: Discussion[]) => void;
    readonly refuseStatus?: string;
    /** A lifecycle block other than the fully mapped one (WP-178 review: partial mapping). */
    readonly lifecycle?: BindingLifecycle;
  } = {},
): Promise<Waiting> => {
  const ticket = tracker(
    options.refuseStatus === undefined ? {} : { refuseStatus: options.refuseStatus },
  );
  const discussions: Discussion[] = [];
  const holder: { harness: PipelineHarness | null } = { harness: null };
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: RUNS,
    git: {
      getPipelineStatus: async () => {
        if (holder.harness !== null) {
          options.onCiCheck?.(holder.harness, discussions);
        }
        return {
          id: 'pipeline-1',
          head_sha: 'b'.repeat(40),
          status: 'success',
          url: null,
          jobs: [],
          coverage_pct: null,
          finished_at: '2026-06-01T09:30:00.000Z',
        };
      },
      getMergeRequest: async () => mergeRequest,
      listDiscussions: async () => discussions.map((discussion) => structuredClone(discussion)),
      closeMergeRequest: async (ref: { iid: number }) =>
        ({ ...mergeRequest, ref, state: 'closed' }) as never,
      createDiscussion: async () =>
        ({ id: 'd-1', resolvable: true, resolved: false, notes: [] }) as never,
    },
    taskManagement: ticket.port,
    ticketAssignPermission: 'Assign Issues',
    ...options.harness,
    settings: {
      ticketLifecycle: options.lifecycle ?? lifecycle(stage === 'qa'),
      ...options.harness?.settings,
    },
  });
  holder.harness = harness;
  await harness.publish([event(harness, 'ticket.matched', ticketMatchedPayload())]);
  expect(at(harness)).toEqual(
    stage === 'qa' ? ['active', 'qa'] : ['ready_for_merge', 'ready_for_merge'],
  );
  return { harness, ticket, discussions };
};

const ticketMatchedPayload = () => ({
  project_id: PROJECT,
  ticket: { ...TICKET },
  rule: 'label:agentic',
  priority: 'High',
  issue_type: 'Story',
  epic: null,
  links: [],
});

let eventCounter = 0;
/** A fresh suffix for a fixture id. */
const nextId = (): string => {
  eventCounter += 1;
  return String(eventCounter);
};
/** One event on the project's own stream, at the stream's next sequence. */
const event = <T extends DomainEvent['type']>(
  harness: PipelineHarness,
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
): DomainEvent => {
  eventCounter += 1;
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${eventCounter.toString(16).padStart(12, '0')}`,
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: harness.memory._committedLastSeq('project', PROJECT) + 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: harness.clock.now(),
    type,
    payload,
  }) as DomainEvent;
};

const taskOf = (harness: PipelineHarness): StoredTask => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const at = (harness: PipelineHarness) => [
  taskOf(harness).task.state,
  taskOf(harness).task.currentStage,
];

const eventsOf = <T extends DomainEvent['type']>(harness: PipelineHarness, type: T) =>
  harness.events().filter((entry) => entry.type === type) as Extract<DomainEvent, { type: T }>[];

const nowIso = (harness: PipelineHarness) => new Date(harness.clock.epochMs).toISOString();

/** A note on the merge request, written now. `path` makes it a diff note. */
const note = (
  harness: PipelineHarness,
  body: string,
  options: { readonly path?: string; readonly line?: number; readonly at?: string } = {},
): Discussion['notes'][number] => ({
  id: `n-${nextId()}`,
  author: { ...person('42', 'fake-git'), display_name: 'A reviewer', email: null },
  body,
  created_at: options.at ?? nowIso(harness),
  path: options.path ?? null,
  line: options.line ?? null,
  system: false,
});

const generalNote = (harness: PipelineHarness, body: string, at?: string): Discussion => ({
  id: `g-${nextId()}`,
  resolvable: false,
  resolved: false,
  notes: [note(harness, body, at === undefined ? {} : { at })],
});

const diffNote = (harness: PipelineHarness, body: string): Discussion => ({
  id: `d-${nextId()}`,
  resolvable: true,
  resolved: false,
  notes: [note(harness, body, { path: 'src/totals.ts', line: 12 })],
});

/** The webhook's event for a note — what arms the window from the merge request. */
const noteArrived = (harness: PipelineHarness, text: string) =>
  event(harness, 'mr.review.comment', {
    project_id: PROJECT,
    task_id: null,
    mr: MR_REF,
    thread_id: 'thread-1',
    author: person('42', 'fake-git'),
    text,
    resolved: false,
  });

/** A ticket comment, written now, and the webhook's event for it. */
const commentArrived = (
  waiting: Waiting,
  body: string,
  markerId: string | null = null,
  /** Whether the author maps to a platform user — what ask-the-task needs to answer (BD-022). */
  verified = false,
): DomainEvent => {
  const author: ExternalIdentity = { ...person('jane'), verified };
  const comment: TicketComment = {
    id: `c-${String(waiting.ticket.state.comments.length + 1)}`,
    author,
    body,
    created_at: nowIso(waiting.harness),
    ...(markerId === null ? {} : { marker_id: markerId }),
  };
  waiting.ticket.state.comments.push(comment);
  return event(waiting.harness, 'ticket.comment.added', {
    project_id: PROJECT,
    task_id: null,
    ticket: { ...TICKET },
    comment_id: comment.id,
    author,
    text: body,
  });
};

/** A person moves the ticket, and the webhook's event for it. */
const statusMoved = (waiting: Waiting, to: string): DomainEvent => {
  const from = waiting.ticket.state.status;
  waiting.ticket.state.status = to;
  return event(waiting.harness, 'ticket.status.changed', {
    project_id: PROJECT,
    task_id: null,
    ticket: { ...TICKET },
    from,
    to,
  });
};

/** Publishes the arming event, lets the batching window pass, and drains. */
const fire = async (harness: PipelineHarness, arming: DomainEvent) => {
  await harness.publish([arming]);
  harness.clock.advance(WINDOW + 1);
  await harness.drain();
};

/** Moves the clock a second on, so a word written now is newer than the latest run's start. */
const later = (harness: PipelineHarness) => harness.clock.advance(1_000);

const returnsFrom = (harness: PipelineHarness, stage: HumanStage) =>
  eventsOf(harness, 'task.stage.returned').filter((entry) => entry.payload.from_stage === stage);

/** The `return_feedback` block of the latest implementation run's prompt. */
const feedbackBlock = (harness: PipelineHarness): string | undefined => {
  const run = harness.specs.filter((spec) => spec.stage === 'implementation').at(-1);
  return readDataBlocks(run?.userPrompt ?? '').blocks.find(
    (block) => block.kind === 'return_feedback',
  )?.body;
};

// ── (1) every form returns, at both human stages ───────────────────────────

describe.each(HUMAN_STAGES)('(1) at %s, each form a person uses returns the task', (stage) => {
  it('a general note with resolvable: false — the shape of the product owner’s example', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    waiting.discussions.push(
      generalNote(waiting.harness, 'The totals row is still off by one on the second page.'),
    );
    await fire(waiting.harness, noteArrived(waiting.harness, 'The totals row is still off'));

    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload).toMatchObject({
      from_stage: stage,
      forms: ['mr_note'],
      counts: { mr_diff: 0, mr_note: 1, ticket_comment: 0 },
      status: null,
    });
    expect(feedbackBlock(waiting.harness)).toContain(
      '[mr note 1] — The totals row is still off by one on the second page.',
    );
    // It came back round: re-claimed, re-run, and waiting at the stage again.
    expect(at(waiting.harness)).toEqual(
      stage === 'qa' ? ['active', 'qa'] : ['ready_for_merge', 'ready_for_merge'],
    );
    expect(taskOf(waiting.harness).task.iterationCounters.human_rounds).toBe(1);
  });

  it('a note on a diff discussion', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    waiting.discussions.push(diffNote(waiting.harness, 'Use cents here, not floats.'));
    await fire(waiting.harness, noteArrived(waiting.harness, 'Use cents here'));

    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload.forms).toEqual(['mr_diff']);
    expect(feedbackBlock(waiting.harness)).toContain(
      '[mr thread 1] src/totals.ts:12 — Use cents here, not floats.',
    );
  });

  it('a ticket comment', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    await fire(
      waiting.harness,
      commentArrived(waiting, 'Tested on the staging invoice: the footer is empty.'),
    );

    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload).toMatchObject({
      forms: ['ticket_comment'],
      counts: { mr_diff: 0, mr_note: 0, ticket_comment: 1 },
    });
    expect(feedbackBlock(waiting.harness)).toContain(
      '[ticket comment 1] — Tested on the staging invoice: the footer is empty.',
    );
  });

  it('a status change to a returned status, whose feedback is platform text pointing to get_conversation', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Sent back'));

    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload).toMatchObject({
      forms: ['status'],
      status: 'Sent back',
    });
    const block = feedbackBlock(waiting.harness) ?? '';
    expect(block).toContain('[status] The ticket was moved to "Sent back"');
    expect(block).toContain('get_conversation');
    // The return re-claimed the ticket and moved it to `in_progress` again (BD-031 ruling 4).
    expect(waiting.ticket.state.assignee).toBe(SELF_ID);
  });

  it('a status change back to the in_progress status', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Doing'));

    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload).toMatchObject({
      forms: ['status'],
      status: 'Doing',
    });
  });
});

// ── (2)–(4) what does not return ────────────────────────────────────────────

describe.each(HUMAN_STAGES)('at %s, what does not return the task', (stage) => {
  it('(2) acknowledgements alone, and the thread counts are still recorded', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    waiting.discussions.push(generalNote(waiting.harness, 'LGTM 👍'));
    waiting.discussions.push(diffNote(waiting.harness, 'thanks!'));
    await waiting.harness.publish([commentArrived(waiting, 'Looks good, thank you')]);
    await fire(waiting.harness, noteArrived(waiting.harness, 'LGTM'));

    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    expect(eventsOf(waiting.harness, 'task.human_return')).toHaveLength(0);
    expect(taskOf(waiting.harness).reviewThreads).toMatchObject({ open: 1, resolved: 0 });
  });

  it('(3) a note that opens with a platform marker, and ticket comments the platform wrote', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    const task = taskOf(waiting.harness).task.id;
    waiting.discussions.push(
      generalNote(
        waiting.harness,
        `<!-- agentic:reply:${task}.r1.0 -->\nFixed in the last commit.`,
      ),
    );
    await waiting.harness.publish([
      commentArrived(waiting, `agentic:claim-refused:${task}\nThe agent did not start.`),
    ]);
    await fire(
      waiting.harness,
      commentArrived(waiting, 'The workpad body', `agentic:task:${task}`),
    );

    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
  });

  it('(4) a note older than the horizon — the start of the latest implementation run', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    waiting.discussions.push(
      generalNote(waiting.harness, 'An old request', '2026-05-31T09:00:00.000Z'),
    );
    await fire(waiting.harness, noteArrived(waiting.harness, 'An old request'));

    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
  });

  /**
   * (8) The batching window is a timer that cannot be cancelled, so two of them can fire. The
   * second finds the task at `implementation` — the first returned it — and does nothing.
   */
  it('(8) a second firing after the return does nothing', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    waiting.discussions.push(generalNote(waiting.harness, 'One more change, please.'));
    await waiting.harness.publish([noteArrived(waiting.harness, 'One more change')]);
    await waiting.harness.publish([noteArrived(waiting.harness, 'One more change')]);
    const windows = waiting.harness.jobs.enqueued.filter(
      (request) => request.queue === JOB_QUEUES.mrCommentDebounce,
    );
    expect(windows).toHaveLength(2);
    waiting.harness.clock.advance(WINDOW + 1);
    await waiting.harness.drain();

    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')).toHaveLength(1);
  });

  /**
   * (15) A person who quotes a whole platform comment while asking for a change is a person: the
   * marker counts at the start only (TD-029 decision 6).
   */
  it('(15) — but a person’s comment quoting a platform comment does return it', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    const quoted = `> agentic:ask:00000000-0000-4000-8000-0000000000d1\n> **Asked and answered**\n> It sums the model.\n\nplease rename X`;
    await fire(waiting.harness, commentArrived(waiting, quoted));

    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload.forms).toEqual([
      'ticket_comment',
    ]);
  });
});

describe('(4) a note written while the agent’s review stages ran', () => {
  it('returns the task once, at qa', async () => {
    let wrote = false;
    const waiting = await waitingAt('qa', {
      onCiCheck: (harness, discussions) => {
        if (wrote) return;
        wrote = true;
        // After the implementation run started, before the task reached `qa`: its webhook arrived
        // while the task was at an agent stage and armed nothing.
        later(harness);
        discussions.push(generalNote(harness, 'While you are at it, the header too.'));
        later(harness);
      },
    });
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    // At `qa`, the echo of the platform's own `qa` write arms the window.
    await fire(
      waiting.harness,
      event(waiting.harness, 'ticket.status.changed', {
        project_id: PROJECT,
        task_id: null,
        ticket: { ...TICKET },
        from: 'Reviewed',
        to: 'Testing',
      }),
    );
    expect(returnsFrom(waiting.harness, 'qa')).toHaveLength(1);
    expect(at(waiting.harness)).toEqual(['active', 'qa']);

    // The next firing reads a new horizon: the same note is older than it, and returns nothing.
    await fire(
      waiting.harness,
      event(waiting.harness, 'ticket.status.changed', {
        project_id: PROJECT,
        task_id: null,
        ticket: { ...TICKET },
        from: 'Reviewed',
        to: 'Testing',
      }),
    );
    expect(returnsFrom(waiting.harness, 'qa')).toHaveLength(1);
  });
});

// ── (5) a status change at an agent stage ──────────────────────────────────

describe('(5) a status change at an agent stage', () => {
  it('is logged and returns nothing', async () => {
    const lines: string[] = [];
    const logger = {
      info: (_fields: unknown, message: string) => lines.push(message),
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    } as unknown as Logger;
    const ticket = tracker();
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: RUNS,
      taskManagement: ticket.port,
      logger,
      settings: { ticketLifecycle: lifecycle(true) },
    });
    const stored: StoredTask = {
      ...harnessTask(harness),
      task: { ...harnessTask(harness).task, state: 'active', currentStage: 'implementation' },
    };
    await harness.memory.transaction(async (scope) => harness.store.tasks.insert(scope.tx, stored));
    const historyBefore = harness.jobs.history.length;
    await harness.publish([
      event(harness, 'ticket.status.changed', {
        project_id: PROJECT,
        task_id: null,
        ticket: { ...TICKET },
        from: 'Testing',
        to: 'Doing',
      }),
    ]);

    expect(
      harness.jobs.history
        .slice(historyBefore)
        .filter((request) => request.queue === JOB_QUEUES.mrCommentDebounce),
    ).toHaveLength(0);
    expect(eventsOf(harness, 'task.stage.returned')).toHaveLength(0);
    expect(lines).toContain(
      'the ticket’s status changed while the task is not at a human stage; nothing is returned',
    );
  });
});

/** A task row at an agent stage, with a merge request, for a case the walk cannot stop at. */
const harnessTask = (harness: PipelineHarness): StoredTask => ({
  task: {
    id: '00000000-0000-4000-8000-00000000c178' as Id,
    projectId: PROJECT,
    ticket: { ...TICKET },
    template: 'feature',
    mode: 'normal',
    state: 'active',
    currentStage: 'implementation',
    stageAttempts: { intake: 1, implementation: 1 },
    iterationCounters: {},
    limits: resolveIterationLimits(),
    sequence: 1,
  },
  template: harness.settings.templates.feature as StoredTask['template'],
  pipelineDial: null,
  qaStage: true,
  priorityRank: 2,
  createdAt: '2026-06-01T09:00:00.000Z',
  branch: 'agentic/acme-8',
  mr: MR_REF,
  workpad: null,
  costActualUsd: 0,
  estimateUsd: null,
  estimateBasis: null,
  estimateSamples: null,
  ticketSnapshot: null,
  ticketSnapshotAt: null,
  ticketSignalAt: null,
  reviewSubject: null,
  historySample: null,
  riskClasses: [],
  coverage: null,
  dependencies: null,
  requiredReviewers: null,
  reviewThreads: null,
  readyHeadSha: null,
  ciHeadSha: null,
  ciExcusedPaths: [],
  requestedByUserId: null,
  version: INITIAL_TASK_VERSION,
});

// ── (6) the qa stage's endings ──────────────────────────────────────────────

describe('(6) at qa, the stage’s three other endings', () => {
  it('moving the status on (out of the qa status) leads to ready_for_merge', async () => {
    const waiting = await waitingAt('qa');
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Finished'));

    expect(at(waiting.harness)).toEqual(['ready_for_merge', 'ready_for_merge']);
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    expect(eventsOf(waiting.harness, 'task.human_return')).toHaveLength(0);
  });

  it('mr.merged leads to merged_gate', async () => {
    const waiting = await waitingAt('qa');
    await waiting.harness.publish([
      event(waiting.harness, 'mr.merged', {
        project_id: PROJECT,
        task_id: null,
        mr: MR_REF,
        draft: false,
        head_sha: 'b'.repeat(40),
        diff_stats: null,
        merge_commit_sha: 'c'.repeat(40),
      }),
    ]);

    const entered = eventsOf(waiting.harness, 'task.stage.entered').map(
      (entry) => entry.payload.stage,
    );
    expect(entered.slice(entered.lastIndexOf('qa'))).toContain('merged_gate');
    expect(eventsOf(waiting.harness, 'task.escalated')).toHaveLength(0);
  });

  it('default_branch.moved leads to rebase_gate, spending the re-check and not a human round', async () => {
    const waiting = await waitingAt('qa');
    await waiting.harness.publish([
      event(waiting.harness, 'default_branch.moved', {
        project_id: PROJECT,
        branch: 'main',
        new_head: 'd'.repeat(40),
      }),
    ]);

    expect(taskOf(waiting.harness).task.stageAttempts.rebase_gate).toBe(2);
    expect(at(waiting.harness)).toEqual(['active', 'qa']);
    expect(taskOf(waiting.harness).task.iterationCounters.human_rounds ?? 0).toBe(0);
    expect(taskOf(waiting.harness).task.iterationCounters.rebase_rechecks).toBe(1);
  });
});

// ── (7) the feedback ────────────────────────────────────────────────────────

describe('(7) the feedback', () => {
  const SECRET = 'glpat-notarealtokenatall';

  it('carries every form with its tag, redacts a planted secret, and holds its bound', async () => {
    const redactor = exactSecretRedactor([{ name: 'fake_gitlab_token', value: SECRET }]);
    const waiting = await waitingAt('qa', {
      harness: { gitRedactor: redactor, ticketRedactor: redactor },
    });
    later(waiting.harness);
    waiting.discussions.push(diffNote(waiting.harness, `do not log ${SECRET} here`));
    waiting.discussions.push(generalNote(waiting.harness, 'x'.repeat(MAX_REVIEW_FEEDBACK_CHARS)));
    await waiting.harness.publish([commentArrived(waiting, 'The footer is empty.')]);
    await fire(waiting.harness, statusMoved(waiting, 'Sent back'));

    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload.forms).toEqual([
      'status',
      'mr_diff',
      'mr_note',
      'ticket_comment',
    ]);
    const returned = returnsFrom(waiting.harness, 'qa')[0]?.payload.reason ?? '';
    const lines = returned.split('\n');
    expect(lines[0]).toBe(
      'A person returned the task at qa: the ticket’s status, a note on a diff discussion, a general note on the merge request, a ticket comment.',
    );
    expect(lines[1]).toMatch(/^\[status\] /);
    expect(lines[2]).toBe(
      '[mr thread 1] src/totals.ts:12 — do not log [REDACTED:integration:fake_gitlab_token] here',
    );
    expect(lines[3]).toMatch(/^\[mr note 1\] — x+$/);
    // The bound cut the long note, so the ticket comment did not fit: no notice in the body.
    expect(returned).toHaveLength(MAX_REVIEW_FEEDBACK_CHARS);
    expect(JSON.stringify(waiting.harness.events())).not.toContain(SECRET);
    expect(waiting.harness.specs.map((spec) => spec.userPrompt).join('\n')).not.toContain(SECRET);
  });
});

// ── (11) the project's own acknowledgement words ────────────────────────────

describe.each(HUMAN_STAGES)('(11) at %s, a word added through the settings write', (stage) => {
  it('stops a note made only of that word from returning the task', async () => {
    const waiting = await waitingAt(stage, {
      harness: { settings: { config: { human_returns: { acknowledgements: ['díky'] } } } },
    });
    later(waiting.harness);
    waiting.discussions.push(generalNote(waiting.harness, 'Díky!'));
    await fire(waiting.harness, noteArrived(waiting.harness, 'Díky!'));
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
  });

  it('— and without it, the same note returns the task (the shipped vocabulary is English)', async () => {
    const waiting = await waitingAt(stage);
    later(waiting.harness);
    waiting.discussions.push(generalNote(waiting.harness, 'Díky!'));
    await fire(waiting.harness, noteArrived(waiting.harness, 'Díky!'));
    expect(returnsFrom(waiting.harness, stage)).toHaveLength(1);
  });
});

// ── (12) the record's invariant ─────────────────────────────────────────────

describe('(12) task.human_return is written to its payload invariant', () => {
  it('a status return whose only newer note is an acknowledgement records forms [status] and mr_note 0', async () => {
    const waiting = await waitingAt('ready_for_merge');
    later(waiting.harness);
    waiting.discussions.push(generalNote(waiting.harness, 'thanks!'));
    await fire(waiting.harness, statusMoved(waiting, 'Sent back'));

    const [recorded] = eventsOf(waiting.harness, 'task.human_return');
    expect(recorded).toBeDefined();
    // Parsed through the contracts schema, whose refinement holds `counts` to `forms`: a writer
    // that counted the acknowledgement would fail here, not in a field comparison.
    const parsed = domainEventSchemasByType['task.human_return'].safeParse(recorded);
    expect(parsed.success).toBe(true);
    expect(recorded?.payload).toMatchObject({
      forms: ['status'],
      counts: { mr_diff: 0, mr_note: 0, ticket_comment: 0 },
      status: 'Sent back',
    });
    // Recorded before the return it caused, on the task's stream.
    const types = waiting.harness.types();
    expect(types.indexOf('task.human_return')).toBeLessThan(
      types.indexOf('task.stage.returned', types.indexOf('task.human_return')),
    );
  });
});

// ── (14) a pass needs the ticket to have left qa ────────────────────────────

describe('(14) a pass needs the ticket to have left the qa status', () => {
  it('waits at qa while the ticket sits at its approved status, and passes once it leaves qa', async () => {
    // The `qa` lifecycle write is refused, so the ticket stays at the approved status ("Reviewed")
    // when the task enters `qa` (TD-029 decision 4: a failed write never blocks the stage).
    const waiting = await waitingAt('qa', { refuseStatus: 'Testing' });
    expect(waiting.ticket.state.status).toBe('Reviewed');
    later(waiting.harness);
    // An acknowledgement is enough to arm the window; the answer must be none, not pass.
    await fire(waiting.harness, commentArrived(waiting, 'thanks!'));
    expect(at(waiting.harness)).toEqual(['active', 'qa']);

    // A person moves it into `qa` and then out of it: the move out passes.
    waiting.ticket.state.status = 'Testing';
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Finished'));
    expect(at(waiting.harness)).toEqual(['ready_for_merge', 'ready_for_merge']);
  });
});

// The claim a return marks stale (TD-029 decision 5): the next agent admission re-claims.
describe('a return marks the claim stale for a human return', () => {
  it('records stale_cause human_return, and the next admission takes the ticket back', async () => {
    const waiting = await waitingAt('qa');
    // The QA person holds the ticket when they send it back.
    waiting.ticket.state.assignee = 'jane';
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Sent back'));

    expect(returnsFrom(waiting.harness, 'qa')).toHaveLength(1);
    // Re-claimed (a stale claim is a re-claim), so the agent holds it again.
    expect(waiting.ticket.state.assignee).toBe(SELF_ID);
    expect(eventsOf(waiting.harness, 'ticket.claimed')).toHaveLength(2);
  });
});

// ── WP-178 review: TD-029 decision 7's amendment (a)–(c) ───────────────────

/** A polled edit: `ticket.updated` with no field names, which is all a poll-only binding records. */
const polledEdit = (harness: PipelineHarness) =>
  event(harness, 'ticket.updated', {
    project_id: PROJECT,
    ticket: { ...TICKET },
    updated_at: nowIso(harness),
    changed_fields: [],
    truncated: false,
  });

describe('(a) the status form is a change, never a state — partial mapping', () => {
  it.each([
    ['only in_progress mapped', { in_progress: 'Doing' }, 'Doing'],
    ['an empty lifecycle block', {}, 'Ready for the agent'],
  ] as const)(
    '%s: an acknowledgement at ready_for_merge returns nothing, round after round',
    async (_name, slots, left) => {
      const waiting = await waitingAt('ready_for_merge', {
        lifecycle: { pickUpFrom: 'Ready for the agent', slots },
      });
      // The ticket reached Ready still at a status the form counts.
      expect(waiting.ticket.state.status).toBe(left);
      for (let round = 0; round < 3; round += 1) {
        later(waiting.harness);
        waiting.discussions.push(generalNote(waiting.harness, 'LGTM'));
        await fire(waiting.harness, noteArrived(waiting.harness, 'LGTM'));
      }
      expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
      expect(at(waiting.harness)).toEqual(['ready_for_merge', 'ready_for_merge']);
    },
  );

  it('only in_progress and returned mapped: a real move into a return status still returns the task', async () => {
    const waiting = await waitingAt('ready_for_merge', {
      lifecycle: {
        pickUpFrom: 'Ready for the agent',
        slots: { in_progress: 'Doing', returned: ['Sent back'] },
      },
    });
    later(waiting.harness);
    // The window's first firing records the entry status (an acknowledgement arms it).
    await fire(waiting.harness, commentArrived(waiting, 'thanks!'));
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Sent back'));
    expect(returnsFrom(waiting.harness, 'ready_for_merge')).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload).toMatchObject({
      forms: ['status'],
      status: 'Sent back',
    });
  });
});

describe('(b) the pass reads the same record — a binding that only polls', () => {
  it('passes qa when a polled edit shows the ticket moved on from the qa status', async () => {
    const waiting = await waitingAt('qa');
    expect(waiting.ticket.state.status).toBe('Testing');
    // The poll records the platform's own `qa` write as an edit with no field names: the first
    // firing reads the ticket at `qa`, which is the entry.
    later(waiting.harness);
    await fire(waiting.harness, polledEdit(waiting.harness));
    expect(at(waiting.harness)).toEqual(['active', 'qa']);
    // A person moves it on; the next poll records another edit — still no `from`.
    waiting.ticket.state.status = 'Finished';
    later(waiting.harness);
    await fire(waiting.harness, polledEdit(waiting.harness));
    expect(at(waiting.harness)).toEqual(['ready_for_merge', 'ready_for_merge']);
    expect(eventsOf(waiting.harness, 'ticket.status.changed')).toHaveLength(0);
  });
});

const ASKER = '00000000-0000-4000-8000-0000000000e8';
const QUESTION = 'why does the footer sum the visible rows?';

describe.each(HUMAN_STAGES)('(c) at %s, an @agentic ask', (stage) => {
  it('never returns the task, and ask-the-task still answers it (Q119)', async () => {
    const waiting = await waitingAt(stage, {
      harness: {
        // The comment's author maps to a platform user, so ask-the-task answers it (WP-31).
        askIdentities: { 'fake-jira': { jane: ASKER } },
        runs: {
          ...RUNS,
          [`ask:${QUESTION}`]: completed({
            answer: 'The plan sums the model, not the rendered rows.',
            citations: [],
            unanswered: [],
            confidence: 'high',
          }),
        },
      },
    });
    later(waiting.harness);
    await fire(waiting.harness, commentArrived(waiting, `@agentic ask ${QUESTION}`, null, true));
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    expect(eventsOf(waiting.harness, 'task.human_return')).toHaveLength(0);
    // Pinned: the ask door still answers it.
    const asks = waiting.harness.asks.all();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ source: 'ticket', status: 'answered' });
  });
});

// ── WP-178 review round 2: TD-029 decision 7's amendment (e) ───────────────

describe('(e) the entry status, with the webhook’s echo of the platform’s own qa move', () => {
  it('a person moving the ticket out of qa back to in_progress returns the task once', async () => {
    const waiting = await waitingAt('qa', {
      lifecycle: {
        pickUpFrom: 'Ready for the agent',
        slots: { in_progress: 'Doing', qa: 'Testing' },
      },
    });
    expect(waiting.ticket.state.status).toBe('Testing');
    // The webhook echoes the platform's own `qa` move: `Doing → Testing`. It arms the window, whose
    // first read records the entry — the echo's `to`, the stage's own slot, never its `from`.
    later(waiting.harness);
    await fire(
      waiting.harness,
      event(waiting.harness, 'ticket.status.changed', {
        project_id: PROJECT,
        task_id: null,
        ticket: { ...TICKET },
        from: 'Doing',
        to: 'Testing',
      }),
    );
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Doing'));

    expect(returnsFrom(waiting.harness, 'qa')).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload).toMatchObject({
      forms: ['status'],
      status: 'Doing',
    });
  });
});

/** Post-review fix, ruling (f): every slot the platform writes, and the earliest-first order. */
describe('(f) the entry status at ready_for_merge', () => {
  const echo = (harness: PipelineHarness, from: string, to: string) =>
    event(harness, 'ticket.status.changed', {
      project_id: PROJECT,
      task_id: null,
      ticket: { ...TICKET },
      from,
      to,
    });

  it('the approved echo is the entry, so a person moving the ticket back to in_progress returns the task once', async () => {
    const waiting = await waitingAt('ready_for_merge', {
      lifecycle: {
        pickUpFrom: 'Ready for the agent',
        slots: { in_progress: 'Doing', approved: 'Reviewed' },
      },
    });
    expect(waiting.ticket.state.status).toBe('Reviewed');
    // The webhook echoes the platform's own `approved` move after the stage's entry.
    later(waiting.harness);
    await fire(waiting.harness, echo(waiting.harness, 'Doing', 'Reviewed'));
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    later(waiting.harness);
    await fire(waiting.harness, statusMoved(waiting, 'Doing'));
    expect(returnsFrom(waiting.harness, 'ready_for_merge')).toHaveLength(1);
    expect(eventsOf(waiting.harness, 'task.human_return')[0]?.payload).toMatchObject({
      forms: ['status'],
      status: 'Doing',
    });
  });

  it('reads the entry from the earliest change: Doing → Sent back → Doing before the first firing returns nothing', async () => {
    const waiting = await waitingAt('ready_for_merge', {
      lifecycle: {
        pickUpFrom: 'Ready for the agent',
        slots: { in_progress: 'Doing', returned: ['Sent back'] },
      },
    });
    expect(waiting.ticket.state.status).toBe('Doing');
    // Two moves recorded before the window first reads the ticket, none into a platform slot. The
    // entry is the earliest change's `from` (`Doing`); newest-first would make it `Sent back`.
    later(waiting.harness);
    await waiting.harness.publish([echo(waiting.harness, 'Doing', 'Sent back')]);
    later(waiting.harness);
    waiting.ticket.state.status = 'Doing';
    await fire(waiting.harness, echo(waiting.harness, 'Sent back', 'Doing'));
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
  });
});

describe('(e) a second visit to the human stage records a fresh entry', () => {
  it('reads the second visit’s own entry, so a move from it returns the task again', async () => {
    const waiting = await waitingAt('ready_for_merge', {
      lifecycle: {
        pickUpFrom: 'Ready for the agent',
        slots: { in_progress: 'Doing', returned: ['Sent back'] },
      },
    });
    // First visit, poll-only shape: the person moved the ticket before the window first read it,
    // so `Sent back` is this visit's entry and returns nothing by itself (the stated residual)…
    waiting.ticket.state.status = 'Sent back';
    later(waiting.harness);
    await fire(waiting.harness, polledEdit(waiting.harness));
    expect(eventsOf(waiting.harness, 'task.stage.returned')).toHaveLength(0);
    // …and a note returns the task. The re-claim moves the ticket to `Doing` on the way back.
    later(waiting.harness);
    waiting.discussions.push(generalNote(waiting.harness, 'Please rename the totals helper.'));
    await fire(waiting.harness, noteArrived(waiting.harness, 'Please rename'));
    expect(returnsFrom(waiting.harness, 'ready_for_merge')).toHaveLength(1);
    expect(at(waiting.harness)).toEqual(['ready_for_merge', 'ready_for_merge']);
    expect(waiting.ticket.state.status).toBe('Doing');

    // Second visit: its first read records `Doing` — a fresh entry, not the first visit's.
    later(waiting.harness);
    await fire(waiting.harness, polledEdit(waiting.harness));
    expect(returnsFrom(waiting.harness, 'ready_for_merge')).toHaveLength(1);
    // So a move to `Sent back` is a change from this visit's entry, and returns the task. Read
    // against the first visit's entry (`Sent back`) it would have returned nothing.
    waiting.ticket.state.status = 'Sent back';
    later(waiting.harness);
    await fire(waiting.harness, polledEdit(waiting.harness));
    expect(returnsFrom(waiting.harness, 'ready_for_merge')).toHaveLength(2);
  });
});
