/**
 * WP-184 — the duties a stage is owed, performed by its `stage.execute` job before the plan: the
 * review findings a `code_review` return left, the Developer's replies before the re-review, and the
 * entry's lifecycle move (TD-029 decisions 4, 10 and 11; BD-031 rulings 2 and 6).
 *
 * Driven through the real runtime over the harness, with the outbound duties the case races
 * **held** (`holdOutbound`), so whatever a prompt carries — and whatever the tracker records before
 * a run starts — was done by the stage job alone. A git double keeps the merge request's
 * discussions, so the planner's production conversation reader (`readsConversation`) reads back
 * what was posted, and every count is a call on a double.
 *
 * The concurrent case — both performers at once — and shadow mode are driven over the memory store
 * in `review-conversation.test.ts`, beside the duties themselves.
 *
 * Every note, name and status here is an invented fixture value (BD-031 ruling 1).
 */
import type { ExternalIdentity, Id } from '@platform/contracts';
import { readDataBlocks } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { IntegrationError } from '../ports/integrations/common.js';
import type { Discussion, GitProviderPort } from '../ports/integrations/git-provider.js';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import type { RunSpec } from '../ports/runner.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import type { BindingLifecycle } from './binding-lifecycle.js';

const PROJECT = '00000000-0000-4000-8000-0000000184a1' as Id;
const HEAD = 'b'.repeat(40);
const MR_URL = 'https://git.example.test/acme/api/-/merge_requests/7';
const BOT: ExternalIdentity = {
  provider: 'fake-git',
  external_id: 'agentic-bot',
  email: null,
  display_name: 'agentic-bot',
  verified: true,
};
const FINDING_MARKER = '<!-- agentic:review-finding:';
const REPLY_MARKER = '<!-- agentic:reply:';
const CONVERSATION_DUTIES = new Set([
  'review_findings_post',
  'conversation_replies',
  'review_threads_resolve',
]);

// ── Fixtures: the feature template ──────────────────────────────────────────

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

const notes = (threadReplies: readonly { thread_id: string }[] = []) => ({
  summary: 'Added the footer sum.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: 'green' }],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: MR_URL, iid: 7, head_sha: HEAD, branch: 'agentic/acme-1' },
  thread_replies: threadReplies.map((reply) => ({
    thread_id: reply.thread_id,
    kind: 'fixed',
    reply: 'Fixed: the footer sums the invoice model.',
  })),
});

const REQUEST_CHANGES = {
  verdict: 'request_changes',
  findings: [
    {
      id: 'f1',
      severity: 'major',
      category: 'correctness',
      file: 'src/totals.ts',
      line: 3,
      explanation: 'The footer sums the visible rows.',
      suggestion: 'Sum the model.',
    },
    {
      id: 'f2',
      severity: 'minor',
      category: 'tests',
      explanation: 'No case covers a hidden row.',
    },
  ],
  summary: 'Two findings to answer.',
  protected_path_changes_confirmed: [],
};

const approve = (resolved: readonly string[] = []) => ({
  verdict: 'approve',
  findings: [],
  summary: 'Reviewed.',
  protected_path_changes_confirmed: [],
  resolved_threads: [...resolved],
});

const ACCEPTANCE = {
  verdict: 'approve',
  criteria: [{ id: 'ac1', status: 'met', evidence: 'test' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
};

const completed = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

const mergeRequest = {
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid: 7,
    url: MR_URL,
    branch: 'agentic/acme-1',
    head_sha: HEAD,
  },
  state: 'opened' as const,
  draft: true,
  title: 'Draft: totals',
  description: '',
  source_branch: 'agentic/acme-1',
  target_branch: 'main',
  head_sha: HEAD,
  mergeable: true,
  has_conflicts: false,
  labels: [],
  reviewers: [],
  web_url: MR_URL,
};

// ── The doubles ─────────────────────────────────────────────────────────────

/** The merge request's discussions, kept, so the conversation reader reads back what was posted. */
const gitDouble = (order: string[]) => {
  const discussions: Discussion[] = [];
  const state = { failPosts: false };
  const counts = { created: 0, replied: 0, resolved: 0 };
  let counter = 0;
  const note = (body: string, path: string | null, line: number | null) => {
    counter += 1;
    return {
      id: `note-${String(counter)}`,
      author: BOT,
      body,
      created_at: '2026-06-01T09:00:00.000Z',
      path,
      line,
      system: false,
    };
  };
  const port: Partial<GitProviderPort> = {
    capabilities: () => ({ discussionResolution: true }) as never,
    authenticatedUser: async () => BOT,
    getPipelineStatus: async () => ({
      id: 'pipeline-1',
      head_sha: HEAD,
      status: 'success',
      url: null,
      jobs: [],
      coverage_pct: null,
      finished_at: '2026-06-01T09:30:00.000Z',
    }),
    getMergeRequest: async () => mergeRequest as never,
    listDiscussions: async () => discussions.map((discussion) => structuredClone(discussion)),
    createDiscussion: async (_ref, input) => {
      if (state.failPosts) {
        throw new IntegrationError('forbidden', 'fake-git', 'the account may not comment', {
          action: 'create_discussion',
        });
      }
      counts.created += 1;
      const id = `thread-${String(discussions.length + 1)}`;
      discussions.push({
        id,
        resolvable: true,
        resolved: false,
        notes: [note(input.markdown, input.path ?? null, input.line ?? null)],
      });
      order.push(`thread:${id}`);
      return structuredClone(discussions.at(-1) as Discussion);
    },
    replyToDiscussion: async (_ref, discussionId, markdown) => {
      const target = discussions.find((discussion) => discussion.id === discussionId);
      if (target === undefined) {
        throw new IntegrationError('not_found', 'fake-git', `discussion ${discussionId}`);
      }
      counts.replied += 1;
      target.notes.push(note(markdown, null, null));
      order.push(`reply:${discussionId}`);
      return structuredClone(target);
    },
    resolveDiscussion: async (_ref, discussionId) => {
      const target = discussions.find((discussion) => discussion.id === discussionId);
      if (target === undefined) {
        throw new IntegrationError('not_found', 'fake-git', `discussion ${discussionId}`);
      }
      counts.resolved += 1;
      target.resolved = true;
      return structuredClone(target);
    },
  };
  return { port, discussions, state, counts };
};

/** One ticket's status, and every transition, on the shared order log. */
const trackerDouble = (order: string[]) => {
  const state = { status: 'Ready for the agent', assignee: null as string | null };
  const identity = { provider: 'fake-jira', external_id: 'agentic-bot', verified: false };
  const port: Partial<TaskManagementPort> = {
    readTicket: async (ref: TicketRefInput) =>
      ({
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
        assignee: state.assignee === null ? null : identity,
        reporter: null,
        updated_at: '2026-06-01T09:00:00.000Z',
      }) as never,
    selfIdentity: async () => identity,
    assignToSelf: async () => {
      state.assignee = identity.external_id;
      return { changed: true, assignee: identity };
    },
    transition: async (_ref, to) => {
      order.push(`transition:${to}`);
      const from = state.status;
      state.status = to;
      return { changed: from !== to, from, to };
    },
    listComments: async () => ({ comments: [], total: 0 }),
  };
  return { port, state };
};

interface World {
  readonly harness: PipelineHarness;
  readonly git: ReturnType<typeof gitDouble>;
  readonly order: string[];
  readonly warnings: { readonly message: string; readonly fields: Record<string, unknown> }[];
}

/**
 * The feature template walked to Ready: `code_review` 1 asks for changes with two findings, the
 * fix answers both finding threads (`thread-1`, `thread-2`: the double numbers discussions in the
 * order they are posted, the findings first), and `code_review` 2 approves and resolves them.
 */
const world = (
  options: {
    readonly lifecycle?: BindingLifecycle | null;
    readonly beforeRun?: (spec: RunSpec, world: World) => void;
  } = {},
): World => {
  const order: string[] = [];
  const warnings: World['warnings'] = [];
  const git = gitDouble(order);
  const tracker = trackerDouble(order);
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (fields, message) => warnings.push({ message, fields }),
    error: () => {},
  };
  const self = { order, warnings, git } as { -readonly [K in keyof World]: World[K] };
  self.harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: completed(REFINED_SPEC),
      architecture: completed(PLAN),
      implementation: completed(notes()),
      code_review: completed(REQUEST_CHANGES),
      business_review: completed(ACCEPTANCE),
    },
    git: git.port,
    taskManagement: tracker.port,
    readsConversation: true,
    logger,
    // The waiting performer asks again quickly; nothing here waits for a holder.
    dutyLease: { pollMs: 5 },
    settings: { ticketLifecycle: options.lifecycle ?? null },
    whileRunning: async (spec) => {
      order.push(`run:${spec.stage ?? 'none'}:${String(spec.attempt)}`);
      options.beforeRun?.(spec, self);
      if (spec.stage === 'code_review' && spec.attempt === 1) {
        self.harness.script(
          'implementation',
          completed(notes([{ thread_id: 'thread-1' }, { thread_id: 'thread-2' }])),
        );
        self.harness.script('code_review', completed(approve(['thread-1', 'thread-2'])));
      }
    },
  });
  return self;
};

const ticketMatched = (harness: PipelineHarness) =>
  ({
    id: '00000000-0000-4000-9000-0000000184b1',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: harness.projectId,
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-1',
        url: 'https://jira.example.test/browse/ACME-1',
      },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as never;

const specOf = (harness: PipelineHarness, stage: string, attempt: number): RunSpec => {
  const spec = harness.specs.find((each) => each.stage === stage && each.attempt === attempt);
  if (spec === undefined) {
    throw new Error(`no ${stage}:${String(attempt)} run was started`);
  }
  return spec;
};

/** The merge-request `conversation` blocks of a prompt: each one's `thread_id` and body. */
const mergeRequestEntries = (spec: RunSpec) =>
  readDataBlocks(spec.userPrompt)
    .blocks.filter((block) => block.kind === 'conversation' && block.attributes.source === 'mr')
    .map((block) => ({ thread: block.attributes.thread_id ?? '', body: block.body }));

const holdConversation = (data: Record<string, unknown>) =>
  CONVERSATION_DUTIES.has(String(data.duty));

// ── (1), (2) and (4): the prompt carries the conversation it must answer ───────

describe('a returned stage is planned after the conversation it owes is posted (WP-184)', () => {
  it('(1) the fix run’s prompt carries one conversation block per finding thread, with the outbound duties held', async () => {
    const w = world();
    w.harness.holdOutbound(holdConversation);
    await w.harness.publish([ticketMatched(w.harness)]);

    const fix = mergeRequestEntries(specOf(w.harness, 'implementation', 2));
    const findingThreads = fix
      .filter((entry) => entry.body.trimStart().startsWith(FINDING_MARKER))
      .map((entry) => entry.thread);
    expect(findingThreads).toEqual(['thread-1', 'thread-2']);
    // Posted before the fix run started, by the stage job alone (the duties are still held).
    expect(w.order.indexOf('thread:thread-2')).toBeLessThan(
      w.order.indexOf('run:implementation:2'),
    );
    expect(
      w.harness.jobs.enqueued.filter((job) => holdConversation((job.data ?? {}) as never)).length,
    ).toBeGreaterThan(0);
  });

  it('(4) the re-review’s prompt carries the Developer’s replies on those threads', async () => {
    const w = world();
    w.harness.holdOutbound(holdConversation);
    await w.harness.publish([ticketMatched(w.harness)]);

    const reReview = mergeRequestEntries(specOf(w.harness, 'code_review', 2));
    const replies = reReview.filter((entry) => entry.body.trimStart().startsWith(REPLY_MARKER));
    expect(replies.map((entry) => entry.thread)).toEqual(['thread-1', 'thread-2']);
    expect(w.order.indexOf('reply:thread-2')).toBeLessThan(w.order.indexOf('run:code_review:2'));
  });

  it('(2) the outbound duties fired afterwards post nothing more: one thread per finding, one summary per review', async () => {
    const w = world();
    w.harness.holdOutbound(holdConversation);
    await w.harness.publish([ticketMatched(w.harness)]);
    const before = { ...w.git.counts };
    // Two findings and code_review 1's summary, then code_review 2's summary (before business review).
    expect(before).toEqual({ created: 4, replied: 2, resolved: 2 });

    w.harness.holdOutbound(null);
    await w.harness.drain();
    expect(
      w.harness.jobs.enqueued.filter((job) => holdConversation((job.data ?? {}) as never)),
    ).toEqual([]);
    expect(w.git.counts).toEqual(before);
    const findingThreads = w.git.discussions.filter((discussion) =>
      discussion.notes[0]?.body.trimStart().startsWith(FINDING_MARKER),
    );
    expect(findingThreads.map((thread) => thread.notes.length)).toEqual([2, 2]);
    // The outbound turns replayed the keys the stage job recorded: no write was made twice.
    const created = w.harness.audit.entriesFor('create_discussion');
    expect(created.filter((entry) => entry.status === 'ok')).toHaveLength(4);
    expect(created.filter((entry) => entry.status === 'replayed').length).toBeGreaterThan(0);
  });
});

// ── (3): a failed post never fails the stage ────────────────────────────────

describe('a post that fails before the plan (WP-184 (3))', () => {
  it('plans the run without the threads, logs one warn naming the duty, and the outbound duty posts later', async () => {
    const w = world({
      beforeRun: (spec, self) => {
        // The provider refuses comments until the fix run has been planned and started.
        if (spec.stage === 'code_review' && spec.attempt === 1) self.git.state.failPosts = true;
        if (spec.stage === 'implementation' && spec.attempt === 2) self.git.state.failPosts = false;
      },
    });
    w.harness.holdOutbound(holdConversation);
    await w.harness.publish([ticketMatched(w.harness)]);

    const fix = mergeRequestEntries(specOf(w.harness, 'implementation', 2));
    expect(fix.filter((entry) => entry.body.trimStart().startsWith(FINDING_MARKER))).toEqual([]);
    const named = w.warnings.filter((warning) => warning.fields.duty === 'review_findings_post');
    expect(named.map((warning) => warning.message)).toEqual([
      'an owed review-conversation duty failed before the plan; the run is planned without it, and the outbound duty posts it later',
    ]);
    expect(w.harness.store.snapshot()[0]?.task.state).not.toBe('needs_human');

    w.harness.holdOutbound(null);
    await w.harness.drain();
    const findings = w.git.discussions.filter((discussion) =>
      discussion.notes[0]?.body.trimStart().startsWith(FINDING_MARKER),
    );
    // code_review 1's two findings, posted by the outbound duty once it ran.
    expect(findings).toHaveLength(2);
  });
});

// ── (8): the entry's lifecycle move lands before the stage's run starts ─────

describe('the lifecycle move a stage entry owes (WP-184 (8))', () => {
  it('moves the ticket to in_review before code_review’s run starts, with the outbound moves held', async () => {
    const w = world({
      lifecycle: {
        pickUpFrom: 'Ready for the agent',
        slots: { in_progress: 'Doing', in_review: 'Waiting for review' },
      },
    });
    w.harness.holdOutbound((data) => data.duty === 'ticket_lifecycle' || holdConversation(data));
    await w.harness.publish([ticketMatched(w.harness)]);

    for (const attempt of [1, 2]) {
      const run = w.order.indexOf(`run:code_review:${String(attempt)}`);
      const moves = w.order
        .slice(0, run)
        .filter((step) => step.startsWith('transition:') || step.startsWith('run:'));
      expect(moves.at(-1)).toBe('transition:Waiting for review');
    }
    // The fix run after the return starts with the ticket back in progress.
    const fix = w.order.indexOf('run:implementation:2');
    expect(
      w.order
        .slice(0, fix)
        .filter((step) => step.startsWith('transition:'))
        .at(-1),
    ).toBe('transition:Doing');

    const moved = w.order.filter((step) => step.startsWith('transition:')).length;
    w.harness.holdOutbound(null);
    await w.harness.drain();
    // The entry duties replay the stage job's moves: no transition is asked twice.
    expect(w.order.filter((step) => step.startsWith('transition:')).length).toBe(moved);
  });
});
