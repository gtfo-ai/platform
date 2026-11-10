/**
 * WP-179 — the review conversation on the merge request: the Reviewer's findings as threads, the
 * Developer's replies on each thread it answered, and the Reviewer's own threads resolved after a
 * re-review (BD-031 ruling 6, TD-029 decision 10, PROGRESS backlog 537 (a) and (b)).
 *
 * The three duties are driven directly over the memory store and the **real**
 * `IntegrationActionExecutor` (its idempotency store, its shadow guard, its audit log), with a git
 * double whose discussions a case reads back and a tracker double whose comments it reads back. The
 * handler that decides which duty a completion asks for is driven through the pipeline harness at
 * the end. Every assertion is a countable effect — a note on the merge request, a comment on the
 * ticket, an audit row, a resolved flag, a log line — never a return value.
 *
 * Every note and comment is an invented fixture value; nothing is a real provider's.
 */
import type { ExternalIdentity, Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE, humanReturnDecision } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError, IntegrationUnsupportedError } from '../ports/integrations/common.js';
import type {
  Discussion,
  GitProviderPort,
  MergeBlocker,
} from '../ports/integrations/git-provider.js';
import type {
  TaskManagementPort,
  TicketComment,
  TicketRefInput,
} from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import {
  OUTBOUND_DUTY_LEASE_WAIT_MS,
  TASK_DUTY_LEASE_WAIT_MS,
  TaskDutyLeaseBusyError,
  withTaskDutyLease,
} from './duty-lease.js';
import { staticPipelineIntegrations } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import { performOwedDuties, underReviewConversationLease } from './owed-duties.js';
import { runReadyMergeCheck } from './ready-merge-check.js';
import {
  type ReviewConversationOptions,
  runConversationReplies,
  runReviewFindingsPost,
  runReviewThreadsResolve,
} from './review-conversation.js';
import {
  conversationReplyMarkerId,
  conversationReplyNoteMarker,
  reviewFindingMarkerFor,
  reviewFindingSummaryMarkerFor,
  reviewLeftOpenNoteMarker,
} from './review-notes.js';
import { mergeRequestWords, ticketCommentWords } from './review-threads.js';
import type { PipelineSagaOptions } from './saga.js';
import { defaultProjectSettings, staticProjectSettings } from './settings.js';
import type { StoredTask } from './store.js';
import type { TaskTransactionOptions } from './task-transaction.js';

const PROJECT = '00000000-0000-4000-8000-0000000017a1' as Id;
const TASK = '00000000-0000-4000-8000-0000000017a2' as Id;
const OTHER_TASK = '00000000-0000-4000-8000-0000000017a9' as Id;
const REVIEW_RUN = '00000000-0000-4000-8000-0000000017a3' as Id;
const DEV_RUN = '00000000-0000-4000-8000-0000000017a4' as Id;
const VERDICT_ID = '00000000-0000-4000-8000-0000000017a5' as Id;
const NOTES_ID = '00000000-0000-4000-8000-0000000017a6' as Id;
const NOW = '2026-06-01T09:00:00.000Z' as IsoDateTime;
const HEAD = 'b'.repeat(40);
/** The head the fix run pushed — different from the task's recorded `HEAD` (S-28.3 review). */
const LIVE_HEAD = 'c'.repeat(40);
const MR_URL = 'https://git.example.test/acme/api/-/merge_requests/7';
const MR = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: MR_URL,
  branch: 'agentic/ACME-1',
  head_sha: HEAD,
};
const TICKET = { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' };

const BOT: ExternalIdentity = {
  provider: 'fake-git',
  external_id: 'agentic-bot',
  email: null,
  display_name: 'agentic-bot',
  verified: true,
};
const PERSON: ExternalIdentity = {
  provider: 'fake-git',
  external_id: '42',
  email: null,
  display_name: 'A reviewer',
  verified: false,
};

/** An obviously fake credential (BD-002), planted so the redaction assertion has a target. */
const PLANTED = 'FAKE-git-token-not-a-real-secret-1790';

const FINDINGS = [
  {
    id: 'f1',
    severity: 'blocker',
    category: 'correctness',
    file: 'src/totals.ts',
    line: 12,
    explanation: 'The footer sums only the visible rows.',
    suggestion: 'Sum every row.',
  },
  {
    id: 'f2',
    severity: 'minor',
    category: 'naming',
    file: 'src/footer.ts',
    line: null,
    explanation: 'The helper name says nothing.',
    suggestion: null,
  },
  {
    id: 'not a valid id!',
    severity: 'nit',
    category: 'style',
    file: null,
    line: null,
    explanation: 'A trailing space.',
    suggestion: null,
  },
] as const;

const verdict = (overrides: Record<string, unknown> = {}) => ({
  verdict: 'request_changes',
  findings: FINDINGS,
  summary: 'One real problem, two small ones.',
  protected_path_changes_confirmed: [],
  ...overrides,
});

const notes = (threadReplies: readonly Record<string, unknown>[]) => ({
  summary: 'Fixed the footer.',
  deviations_from_plan: [],
  tests_added: [],
  commands_run: [],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: MR_URL, iid: 7, head_sha: HEAD, branch: 'agentic/ACME-1' },
  thread_replies: threadReplies,
});

interface Recorded {
  /** Every thread and (S-28.13, `note: true`) every general note, in the order posted. */
  readonly created: {
    path: string | null;
    line: number | null;
    markdown: string;
    note?: boolean;
  }[];
  readonly replied: { discussionId: string; markdown: string }[];
  readonly resolved: string[];
  readonly commented: { body: string; markerId: string | null }[];
  readonly logs: { level: string; message: string; fields: Record<string, unknown> }[];
}

let noteCounter = 0;
const note = (author: ExternalIdentity, body: string, path: string | null = null) => {
  noteCounter += 1;
  return {
    id: `n-${String(noteCounter)}`,
    author,
    body,
    created_at: NOW,
    path,
    line: path === null ? null : 3,
    system: false,
  };
};

const world = async (
  options: {
    readonly mode?: 'normal' | 'shadow';
    /** Where a reply to an individual note lands — the fake's divergence 31. @default 'new_note' */
    readonly individualNoteReplies?: 'new_note' | 'thread';
    /** The provider refuses every diff anchor (`invalid_request`). */
    readonly refuseAnchors?: boolean;
    /** The anchored note lands, then the call fails as a 201 body that would not parse. */
    readonly anchoredThenUnparsable?: boolean;
    /** The first reply call posts, then throws — GitLab's fallback, POST and then a failed read. */
    readonly failAfterFirstReply?: boolean;
    /** When the artifacts' runs were created. @default NOW */
    readonly runCreatedAt?: IsoDateTime;
    /** The provider cannot resolve a discussion (S-28.3): `resolveDiscussion` is unsupported. */
    readonly resolveUnsupported?: boolean;
    /**
     * The merge request's live head (S-28.3 review). @default `'c'.repeat(40)` — a push past the
     * task's recorded `HEAD`; pass `HEAD` for a run that pushed nothing.
     */
    readonly liveHead?: string;
    readonly discussions?: readonly Discussion[];
    readonly comments?: readonly TicketComment[];
    readonly artifacts?: readonly { id: Id; type: string; run: Id; data: unknown }[];
    /** Every post yields first, so two performers really overlap (WP-184's concurrent case). */
    readonly slowWrites?: boolean;
    /** The duty lease's seams (WP-184); the lease is armed unless a case disarms it. */
    readonly dutyLease?: PipelineSagaOptions['dutyLease'];
    /** S-28.13: the task waits at `ready_for_merge` rather than at Implementation. */
    readonly atReady?: boolean;
    /** S-28.13: why the provider would not merge the merge request now (absent: nothing). */
    readonly mergeBlocker?: MergeBlocker | null;
  } = {},
) => {
  const discussions: (Discussion & { individual?: boolean })[] = (options.discussions ?? []).map(
    (discussion) => structuredClone(discussion),
  );
  const comments: TicketComment[] = [...(options.comments ?? [])];
  const recorded: Recorded = {
    created: [],
    replied: [],
    resolved: [],
    commented: [],
    logs: [],
  };
  let discussionCounter = 0;
  let replyCalls = 0;
  const git = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({ discussionResolution: true }),
    authenticatedUser: async () => BOT,
    listDiscussions: async () => discussions.map((discussion) => structuredClone(discussion)),
    getMergeRequest: async () => ({
      ref: MR,
      state: 'opened',
      draft: true,
      title: 'Draft: totals',
      description: '',
      source_branch: 'agentic/ACME-1',
      target_branch: 'main',
      head_sha: options.liveHead ?? LIVE_HEAD,
      mergeable: true,
      has_conflicts: false,
      ...(options.mergeBlocker == null ? {} : { merge_blocker: options.mergeBlocker }),
      labels: [],
      reviewers: [],
      web_url: MR_URL,
    }),
    createDiscussion: async (
      _ref: unknown,
      input: { path?: string | null; line?: number | null; markdown: string },
    ) => {
      if (options.slowWrites === true) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (options.refuseAnchors === true && input.path != null) {
        throw new IntegrationError(
          'invalid_request',
          'fake-git',
          'line_code is not a valid diff line',
          {
            action: 'create_discussion',
          },
        );
      }
      recorded.created.push({
        path: input.path ?? null,
        line: input.line ?? null,
        markdown: input.markdown,
      });
      discussionCounter += 1;
      const created: Discussion = {
        id: `created-${String(discussionCounter)}`,
        resolvable: true,
        resolved: false,
        notes: [note(BOT, input.markdown, input.path ?? null)],
      };
      discussions.push(created);
      if (options.anchoredThenUnparsable === true && input.path != null) {
        throw new IntegrationError('invalid_response', 'fake-git', 'the 201 body did not parse', {
          action: 'create_discussion',
        });
      }
      return structuredClone(created);
    },
    // S-28.13: a general note — its own discussion, never resolvable (GitLab's individual note).
    createMergeRequestNote: async (_ref: unknown, markdown: string) => {
      recorded.created.push({ path: null, line: null, markdown, note: true });
      discussionCounter += 1;
      const created = {
        id: `general-${String(discussionCounter)}`,
        resolvable: false,
        resolved: false,
        individual: true,
        notes: [note(BOT, markdown)],
      };
      discussions.push(created);
      return structuredClone(created);
    },
    replyToDiscussion: async (_ref: unknown, discussionId: string, markdown: string) => {
      replyCalls += 1;
      const target = discussions.find((discussion) => discussion.id === discussionId);
      if (target === undefined) {
        throw new IntegrationError('not_found', 'fake-git', `discussion ${discussionId}`);
      }
      recorded.replied.push({ discussionId, markdown });
      let answer: Discussion;
      if (
        target.individual === true &&
        (options.individualNoteReplies ?? 'new_note') === 'new_note'
      ) {
        // The fake's divergence 31 / GitLab's divergence 8: a new general note, its own discussion.
        discussionCounter += 1;
        const fresh = {
          id: `fallback-${String(discussionCounter)}`,
          resolvable: false,
          resolved: false,
          individual: true,
          notes: [note(BOT, `${markdown}\n\n_In reply to a note._`)],
        };
        discussions.push(fresh);
        answer = fresh;
      } else {
        target.notes.push(note(BOT, markdown));
        answer = target;
      }
      if (options.failAfterFirstReply === true && replyCalls === 1) {
        // Not retryable, so the executor gives up at once and the job's own retry is the next try.
        throw new IntegrationError(
          'invalid_response',
          'fake-git',
          'the read after the post failed',
        );
      }
      return structuredClone(answer);
    },
    resolveDiscussion: async (_ref: unknown, discussionId: string) => {
      if (options.resolveUnsupported === true) {
        throw new IntegrationUnsupportedError('fake-git', 'resolve_discussion');
      }
      const target = discussions.find((discussion) => discussion.id === discussionId);
      if (target === undefined) {
        throw new IntegrationError('not_found', 'fake-git', `discussion ${discussionId}`);
      }
      target.resolved = true;
      recorded.resolved.push(discussionId);
      return structuredClone(target);
    },
  } as unknown as GitProviderPort;
  const tracker = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a002',
      provider: 'fake-jira',
      type: 'task_management',
    },
    capabilities: () => ({ commentsRead: true }),
    selfIdentity: async () => ({ ...BOT, provider: 'fake-jira' }),
    listComments: async () => ({ comments: [...comments].reverse(), total: comments.length }),
    addComment: async (_ticket: TicketRefInput, body: string, extra?: { markerId?: string }) => {
      recorded.commented.push({ body, markerId: extra?.markerId ?? null });
      comments.push({
        id: `c-${String(comments.length + 1)}`,
        author: { ...BOT, provider: 'fake-jira' },
        body,
        created_at: NOW,
        marker_id: extra?.markerId ?? null,
      });
      return {
        provider: 'fake-jira',
        ticket_key: TICKET.key,
        comment_id: `c-${String(comments.length)}`,
        url: null,
        marker_id: extra?.markerId ?? null,
      };
    },
  } as unknown as TaskManagementPort;

  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  await memory.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, {
      task: {
        id: TASK,
        projectId: PROJECT,
        ticket: TICKET,
        template: 'feature',
        mode: options.mode ?? 'normal',
        state: options.atReady === true ? 'ready_for_merge' : 'active',
        currentStage: options.atReady === true ? 'ready_for_merge' : 'implementation',
        stageAttempts: { implementation: 2, code_review: 1 },
        iterationCounters: {},
        limits: {
          code_review: 3,
          business_review: 2,
          ci_fix: 3,
          human_rounds: 3,
          refinement_questions: 2,
          architecture_revisions: 2,
          rebase: 2,
          rebase_rechecks: 10,
          dependency_policy: 2,
        },
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      priorityRank: 2,
      createdAt: NOW,
      branch: 'agentic/ACME-1',
      mr: MR,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
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
      pipelineDial: null,
      qaStage: false,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      version: 1,
    } as unknown as StoredTask);
    for (const [index, artifact] of (options.artifacts ?? []).entries()) {
      await store.artifacts.insert(scope.tx, {
        id: artifact.id,
        taskId: TASK,
        type: artifact.type as never,
        version: index + 1,
        markdown: null,
        data: artifact.data as never,
        schemaVersion: '1',
        producedByRunId: artifact.run,
        createdAt: NOW,
        redactionCount: 0,
      });
    }
    // The runs that produced them, created at NOW: the handled ledger covers a thread only up to
    // the newest note written no later than the run was created (review of #139).
    for (const runId of new Set((options.artifacts ?? []).map((artifact) => artifact.run))) {
      await store.runs.insert(scope.tx, {
        id: runId,
        taskId: TASK,
        projectId: PROJECT,
        stage: null,
        role: 'developer',
        mode: 'normal',
        attempt: 1,
        model: 'claude-opus-5',
        effort: 'high',
        promptVersion: 'test@1',
        systemPrompt: null,
        userPrompt: null,
        redactionCount: 0,
        contextPack: null,
        settings: null,
        reserveUsd: null,
        promptsWithheld: null,
        providerMode: 'api',
        status: 'completed',
        terminalReason: null,
        sessionId: null,
        numTurns: 0,
        usage: null,
        cost: null,
        wallMs: 0,
        createdAt: options.runCreatedAt ?? NOW,
        startedAt: options.runCreatedAt ?? NOW,
      });
    }
  });
  const auditLog = createMemoryAuditLog();
  const logger: Logger = {
    debug: (fields, message) => recorded.logs.push({ level: 'debug', message, fields }),
    info: (fields, message) => recorded.logs.push({ level: 'info', message, fields }),
    warn: (fields, message) => recorded.logs.push({ level: 'warn', message, fields }),
    error: (fields, message) => recorded.logs.push({ level: 'error', message, fields }),
  };
  const conversationOptions: ReviewConversationOptions = {
    unitOfWork: memory,
    store,
    logger,
    integrations: staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog,
        idempotencyStore: createMemoryIdempotencyStore(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => NOW },
      }),
      git: {
        port: git,
        ref: git.ref,
        project: 'acme/api',
        redactor: exactSecretRedactor([{ name: 'git_token', value: PLANTED }]),
      },
      taskManagement: {
        port: tracker,
        ref: tracker.ref,
        redactor: exactSecretRedactor([]),
      },
      communication: null,
    }),
  };
  const data = (duty: PipelineOutboundData['duty'], artifactId: Id): PipelineOutboundData => ({
    duty,
    project_id: PROJECT,
    task_id: TASK,
    cause_event_id: '00000000-0000-4000-9000-0000000017a1',
    artifact_id: artifactId,
  });
  /**
   * What the `stage.execute` job's pre-plan step and the outbound queue's lease wrapper need
   * (WP-184): the conversation's options plus the lease's clock and ids, and a settings port with
   * no lifecycle, so the step is about the conversation alone.
   */
  let leaseCounter = 0;
  const taskOptions = {
    ...conversationOptions,
    settings: staticProjectSettings(() => defaultProjectSettings(PROJECT)),
    ids: {
      next: () => {
        leaseCounter += 1;
        return `00000000-0000-4000-8000-${leaseCounter.toString(16).padStart(12, '0')}` as Id;
      },
    },
    clock: { now: () => NOW },
    dutyLease: { pollMs: 1, ...options.dutyLease },
  } as unknown as TaskTransactionOptions;
  const loadTask = async (): Promise<StoredTask> => {
    const stored = await memory.transaction(async (scope) => store.tasks.load(scope.tx, TASK));
    if (stored === null) throw new Error('the world has no task');
    return stored;
  };
  return {
    taskOptions,
    loadTask,
    /** The outbound queue's `review_findings_post`, as `outbound.ts` runs it: under the lease. */
    outboundFindings: () =>
      underReviewConversationLease(
        taskOptions,
        data('review_findings_post', VERDICT_ID),
        async () => runReviewFindingsPost(taskOptions, data('review_findings_post', VERDICT_ID)),
      ),
    findings: () =>
      runReviewFindingsPost(conversationOptions, data('review_findings_post', VERDICT_ID)),
    replies: () =>
      runConversationReplies(conversationOptions, data('conversation_replies', NOTES_ID)),
    resolve: () =>
      runReviewThreadsResolve(conversationOptions, data('review_threads_resolve', VERDICT_ID)),
    /** S-28.13: the `ready_merge_check` duty, as the outbound queue's dispatch hands it the task. */
    readyCheck: () => runReadyMergeCheck(conversationOptions, { task_id: TASK }),
    /** S-28.13: what the last merge check recorded. */
    mergeCheck: () =>
      memory.transaction(async (scope) => store.tasks.readyMergeCheckOf(scope.tx, TASK)),
    discussions,
    comments,
    recorded,
    auditLog,
  };
};

const reviewArtifact = (overrides: Record<string, unknown> = {}) => ({
  id: VERDICT_ID,
  type: 'ReviewVerdict',
  run: REVIEW_RUN,
  data: verdict(overrides),
});
const notesArtifact = (replies: readonly Record<string, unknown>[]) => ({
  id: NOTES_ID,
  type: 'ImplementationNotes',
  run: DEV_RUN,
  data: notes(replies),
});

/** The merge request's notes that open with a marker — how this module finds its own (criterion 8). */
const opening = (discussions: readonly Discussion[], marker: string) =>
  discussions.flatMap((discussion) =>
    discussion.notes.filter((entry) => entry.body.trimStart().startsWith(marker)),
  );

// ── (1) and (2) the findings ────────────────────────────────────────────────

describe('(1) the findings, one thread each, and one summary', () => {
  it('anchors a finding with a file and a line, posts the rest on the merge request, then the summary', async () => {
    const w = await world({ artifacts: [reviewArtifact()] });
    await w.findings();

    expect(w.recorded.created.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'src/totals.ts', line: 12 },
      { path: null, line: null },
      { path: null, line: null },
      { path: null, line: null },
    ]);
    const [first, second, third, summary] = w.recorded.created;
    expect(first?.markdown.startsWith(reviewFindingMarkerFor(TASK, REVIEW_RUN, 'f1'))).toBe(true);
    expect(first?.markdown).toContain('**blocker · correctness**');
    expect(first?.markdown).toContain('The footer sums only the visible rows.');
    // Half an anchor: posted on the merge request, still naming the file it has.
    expect(second?.markdown.startsWith(reviewFindingMarkerFor(TASK, REVIEW_RUN, 'f2'))).toBe(true);
    expect(second?.markdown).toContain('In `src/footer.ts`');
    // An id outside the alphabet is replaced by its index (decision 10).
    expect(third?.markdown.startsWith(reviewFindingMarkerFor(TASK, REVIEW_RUN, '_2'))).toBe(true);
    expect(summary?.markdown.startsWith(reviewFindingSummaryMarkerFor(TASK, REVIEW_RUN))).toBe(
      true,
    );
    expect(summary?.markdown).toContain('3 finding(s) posted as threads.');
    expect(summary?.markdown).toContain('One real problem, two small ones.');
    expect(w.auditLog.entriesFor('create_discussion').map((entry) => entry.status)).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
    // S-28.13 (M28 ruling R3b (1)): the summary is a general note, never a resolvable thread.
    expect(summary?.note).toBe(true);
    expect(w.auditLog.entriesFor('create_merge_request_note').map((entry) => entry.status)).toEqual(
      ['ok'],
    );
  });

  /**
   * S-28.13 (M28 ruling R3b (1)): AUT-6655's three summaries were three unresolved threads, and
   * GitLab refused the merge. Canary: posting the summary through `reviewWrites.thread` again
   * leaves a resolvable, unresolved discussion here.
   */
  it('leaves no unresolved thread behind for the summary (S-28.13)', async () => {
    const w = await world({ artifacts: [reviewArtifact()] });
    await w.findings();

    const summaries = w.discussions.filter((discussion) =>
      discussion.notes[0]?.body.startsWith('<!-- agentic:review-summary:'),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries.map((discussion) => discussion.resolvable)).toEqual([false]);
  });

  /**
   * The replay posts nothing twice, and the **key** is the guard: with the idempotency key dropped
   * from `review-conversation.ts` the second run posts four more threads (canary, PROGRESS WP-179).
   * Counted by marker on the merge request, never by a returned id (criterion 8).
   */
  it('posts nothing twice when the job is replayed', async () => {
    const w = await world({ artifacts: [reviewArtifact()] });
    await w.findings();
    await w.findings();

    expect(opening(w.discussions, '<!-- agentic:review-finding:')).toHaveLength(3);
    expect(opening(w.discussions, '<!-- agentic:review-summary:')).toHaveLength(1);
    expect(w.auditLog.entriesFor('create_discussion').map((entry) => entry.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'replayed',
      'replayed',
      'replayed',
    ]);
    expect(w.auditLog.entriesFor('create_merge_request_note').map((entry) => entry.status)).toEqual(
      ['ok', 'replayed'],
    );
  });

  it('gives two findings that share an id two threads, the second under its index', async () => {
    const twin = { ...FINDINGS[0], explanation: 'A second problem the model filed under f1.' };
    const w = await world({ artifacts: [reviewArtifact({ findings: [FINDINGS[0], twin] })] });
    await w.findings();

    expect(opening(w.discussions, reviewFindingMarkerFor(TASK, REVIEW_RUN, 'f1'))).toHaveLength(1);
    expect(opening(w.discussions, reviewFindingMarkerFor(TASK, REVIEW_RUN, '_1'))).toHaveLength(1);
  });

  it('keeps a planted credential out of what it posts', async () => {
    const leaky = { ...FINDINGS[0], explanation: `The token ${PLANTED} is in the log.` };
    const w = await world({ artifacts: [reviewArtifact({ findings: [leaky] })] });
    await w.findings();

    const everything = w.recorded.created.map((entry) => entry.markdown).join('\n');
    expect(everything).not.toContain(PLANTED);
    expect(everything).toContain('[REDACTED:integration:git_token]');
  });
});

describe('(2) a refused anchor', () => {
  /**
   * WP-179 review round 1: `invalid_response` is also a 201 whose body did not parse, after which
   * the anchored note exists. The finding's marker is looked for first, so nothing is re-posted.
   * Canary (PROGRESS WP-179): without that look, f1 has two threads.
   */
  it('does not re-post a finding whose anchored note landed before the call failed', async () => {
    const w = await world({ anchoredThenUnparsable: true, artifacts: [reviewArtifact()] });
    await w.findings();

    expect(opening(w.discussions, reviewFindingMarkerFor(TASK, REVIEW_RUN, 'f1'))).toHaveLength(1);
    expect(w.recorded.created[0]).toMatchObject({ path: 'src/totals.ts', line: 12 });
    expect(w.recorded.created).toHaveLength(4);
  });

  it('re-posts the finding on the merge request, with the location in the body', async () => {
    const w = await world({ refuseAnchors: true, artifacts: [reviewArtifact()] });
    await w.findings();

    const first = w.recorded.created[0];
    expect(first).toMatchObject({ path: null, line: null });
    expect(first?.markdown.startsWith(reviewFindingMarkerFor(TASK, REVIEW_RUN, 'f1'))).toBe(true);
    expect(first?.markdown).toContain('In `src/totals.ts` at line 12');
    expect(opening(w.discussions, '<!-- agentic:review-finding:')).toHaveLength(3);
    // The refused call is on the record, and the re-post under the same key succeeded.
    expect(w.auditLog.entriesFor('create_discussion').map((entry) => entry.status)).toEqual([
      'failed',
      'ok',
      'ok',
      'ok',
    ]);
  });
});

// ── (3) and (8) the replies ─────────────────────────────────────────────────

/** The task's handled ledger (M28 ruling R2), as the duties left it. */
const ledgerOf = async (w: Awaited<ReturnType<typeof world>>) =>
  w.taskOptions.unitOfWork.transaction(async (scope) =>
    w.taskOptions.store.tasks.conversationHandled(scope.tx, TASK),
  );

const personsThread = (): Discussion => ({
  id: 'person-diff',
  resolvable: true,
  resolved: false,
  notes: [note(PERSON, 'Use cents here, not floats.', 'src/totals.ts')],
});
const findingThread = (taskId: Id = TASK): Discussion => ({
  id: 'finding-thread',
  resolvable: true,
  resolved: false,
  notes: [
    note(BOT, `${reviewFindingMarkerFor(taskId, REVIEW_RUN, 'f1')}\n**blocker · correctness**`),
  ],
});
const generalNote = (): Discussion & { individual: boolean } => ({
  id: 'person-general',
  resolvable: false,
  resolved: false,
  individual: true,
  notes: [note(PERSON, 'Please also add the VAT line, and somebody must set the CI variable.')],
});
const ticketComment = (): TicketComment => ({
  id: '10042',
  author: {
    provider: 'fake-jira',
    external_id: 'acc-1',
    email: null,
    display_name: 'Jane',
    verified: false,
  },
  body: 'Tested on staging: the footer is empty.',
  created_at: NOW,
});

describe('(3) the replies', () => {
  const replies = [
    {
      thread_id: 'person-diff',
      kind: 'fixed',
      reply: 'Switched to integer cents in src/totals.ts.',
    },
    { thread_id: 'finding-thread', kind: 'fixed', reply: 'Every row is summed now.' },
    {
      thread_id: 'person-general',
      kind: 'needs_person',
      reply: 'The CI variable TOTALS_MODE has to be set in the project settings.',
      person: 'The project maintainer',
    },
    { thread_id: '10042', kind: 'fixed', reply: 'The footer renders on staging data now.' },
    { thread_id: 'invented-thread', kind: 'not_changed', reply: 'Nothing to do.' },
  ];

  const replied = async () => {
    const w = await world({
      individualNoteReplies: 'thread',
      discussions: [personsThread(), findingThread(), generalNote()],
      comments: [ticketComment()],
      artifacts: [notesArtifact(replies)],
    });
    await w.replies();
    return w;
  };

  it('gives each valid target one reply, opening with its own marker', async () => {
    const w = await replied();

    expect(w.recorded.replied.map((entry) => entry.discussionId)).toEqual([
      'person-diff',
      'finding-thread',
      'person-general',
    ]);
    w.recorded.replied.forEach((entry, index) => {
      expect(entry.markdown.startsWith(conversationReplyNoteMarker(TASK, DEV_RUN, index))).toBe(
        true,
      );
    });
    expect(w.recorded.replied[0]?.markdown).toContain('**Fixed.**');
    expect(w.recorded.replied[0]?.markdown).toContain('Switched to integer cents');
  });

  it('opens a needs_person reply with platform text naming the person and saying it is not done', async () => {
    const w = await replied();
    const needsPerson = w.recorded.replied[2]?.markdown ?? '';
    const [, heading] = needsPerson.split('\n');
    expect(heading).toBe(
      '**The project maintainer must act on this.** The agent has not done it and cannot.',
    );
    expect(needsPerson).toContain('The CI variable TOTALS_MODE has to be set');
  });

  it('answers a ticket comment on the ticket, with the marker opening the body and as the marker id', async () => {
    const w = await replied();
    const markerId = conversationReplyMarkerId(TASK, DEV_RUN, 3);
    expect(w.recorded.commented).toEqual([
      { body: expect.stringMatching(new RegExp(`^${markerId}\\n\\*\\*Fixed\\.\\*\\*`)), markerId },
    ]);
  });

  it('drops an unknown thread id and logs it, posting nothing for it', async () => {
    const w = await replied();
    expect(w.recorded.replied).toHaveLength(3);
    expect(w.recorded.commented).toHaveLength(1);
    expect(
      w.recorded.logs.filter(
        (entry) => entry.level === 'warn' && entry.message.startsWith('reply dropped'),
      ),
    ).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ reply: 4, thread_id: 'invented-thread' }),
      }),
    ]);
  });

  it('posts nothing twice when the job is replayed', async () => {
    const w = await replied();
    await w.replies();
    expect(w.recorded.replied).toHaveLength(3);
    expect(w.recorded.commented).toHaveLength(1);
  });

  /**
   * M28 ruling R2: every item the Developer answered is in the handled ledger, at the person's last
   * note, so the human-return window ignores it until a newer note; a replay adds nothing. Canary:
   * without `recordHandled` in `runConversationReplies` the ledger is empty.
   */
  it('records each answered item in the handled ledger once, and a replay adds nothing (M28 R2)', async () => {
    const w = await replied();
    const first = await ledgerOf(w);
    expect(first.map((row) => [row.source, row.threadId, row.kind]).sort()).toEqual([
      ['mr_note', 'person-general', 'answered'],
      ['mr_thread', 'finding-thread', 'answered'],
      ['mr_thread', 'person-diff', 'answered'],
      // S-28.3 (M28 ruling R3): the person's thread the fixed reply answered is resolved too.
      ['mr_thread', 'person-diff', 'resolved'],
      ['ticket_comment', '10042', 'answered'],
    ]);
    const person = first.find((row) => row.threadId === 'person-diff');
    expect(person?.lastNoteId).toBe(
      w.discussions.find((discussion) => discussion.id === 'person-diff')?.notes[0]?.id,
    );
    expect(person?.runId).toBe(DEV_RUN);
    // The finding thread's newest note written before the run is the platform's finding itself.
    expect(first.find((row) => row.threadId === 'finding-thread')?.lastNoteId).toBe(
      w.discussions.find((discussion) => discussion.id === 'finding-thread')?.notes[0]?.id,
    );
    expect(first.find((row) => row.threadId === '10042')?.lastNoteId).toBe('10042');

    await w.replies();
    expect(await ledgerOf(w)).toEqual(first);
  });

  /**
   * Review of #139: a person who adds "also X" to a thread while the run goes is **not** covered
   * by the run's answer — the row stops at the newest note written no later than the run was
   * created, so the window returns the task on the later note. Canary: with the row's last note
   * read at duty time (the newest note), the decision is `none` and the request is lost.
   */
  it('covers only the notes written before the run, so a later person note still returns the task', async () => {
    const later: Discussion = {
      ...personsThread(),
      notes: [
        note(PERSON, 'Use cents here, not floats.', 'src/totals.ts'),
        { ...note(PERSON, 'Also round the VAT line.'), created_at: '2026-06-01T09:30:00.000Z' },
      ],
    };
    const w = await world({
      discussions: [later],
      artifacts: [
        notesArtifact([{ thread_id: 'person-diff', kind: 'not_changed', reply: 'Kept.' }]),
      ],
    });
    await w.replies();
    const ledger = await ledgerOf(w);
    expect(ledger.map((row) => [row.threadId, row.lastNoteId])).toEqual([
      ['person-diff', later.notes[0]?.id],
    ]);
    const decision = humanReturnDecision({
      stage: 'ready_for_merge',
      slots: { lifecycle: {}, pickUpFrom: null },
      status: null,
      words: mergeRequestWords(w.discussions),
      horizon: null,
      handled: ledger.map((row) => ({
        source: row.source,
        threadId: row.threadId,
        lastNoteId: row.lastNoteId,
        handledAt: row.handledAt,
      })),
      forwardSeenAt: null,
      leftQa: null,
      entryStatus: null,
      seenAtQa: false,
    });
    expect(decision).toMatchObject({ kind: 'return', counts: { mr_diff: 1 } });
  });

  it('none of its replies is a person’s word to the human-return window (decision 6)', async () => {
    const w = await replied();
    const words = [...mergeRequestWords(w.discussions), ...ticketCommentWords(w.comments)];
    const platform = words.filter((word) => word.text.includes('agentic:reply:'));
    // Four replies were posted; the person's thread the fixed reply answered is resolved since
    // S-28.3 (M28 ruling R3), and the window reads no resolved discussion — so three are read.
    expect(platform).toHaveLength(3);
    const decision = humanReturnDecision({
      stage: 'ready_for_merge',
      slots: { lifecycle: {}, pickUpFrom: null },
      status: null,
      words: platform,
      horizon: null,
      handled: [],
      forwardSeenAt: null,
      leftQa: null,
      entryStatus: null,
      seenAtQa: false,
    });
    expect(decision).toEqual({ kind: 'none', seen: [] });
  });
});

describe('(8) a reply that lands in a different discussion', () => {
  /**
   * The fake's default (`individualNoteReplies: 'new_note'`): the reply to a person's general note
   * arrives as a new general note, its own discussion. The first call posts and then fails — the
   * adapter's POST-then-read, whose answer the executor never recorded — so the retry has no
   * idempotency record to replay and must find the reply on the merge request by its marker. With
   * the check matching by the target thread (the returned id's discussion), the retry posts it a
   * second time (canary, PROGRESS WP-179).
   */
  it('finds its own reply by marker after a retry, and posts it once', async () => {
    const w = await world({
      failAfterFirstReply: true,
      discussions: [generalNote()],
      artifacts: [
        notesArtifact([
          { thread_id: 'person-general', kind: 'fixed', reply: 'Added the VAT line.' },
        ]),
      ],
    });
    await expect(w.replies()).rejects.toThrow('the read after the post failed');
    await w.replies();

    const marker = conversationReplyNoteMarker(TASK, DEV_RUN, 0);
    expect(opening(w.discussions, marker)).toHaveLength(1);
    // It went into a new discussion, not the one asked for.
    expect(
      w.discussions.find((discussion) => discussion.id === 'person-general')?.notes,
    ).toHaveLength(1);
    expect(w.recorded.replied).toHaveLength(1);
  });

  it('posts again when the note bearing the marker is a person’s, not the binding’s', async () => {
    const forged = generalNote();
    const w = await world({
      discussions: [
        forged,
        {
          id: 'forged',
          resolvable: false,
          resolved: false,
          notes: [note(PERSON, `${conversationReplyNoteMarker(TASK, DEV_RUN, 0)}\nalready done`)],
        },
      ],
      artifacts: [
        notesArtifact([
          { thread_id: 'person-general', kind: 'fixed', reply: 'Added the VAT line.' },
        ]),
      ],
    });
    await w.replies();
    expect(w.recorded.replied).toHaveLength(1);
  });
});

// ── (4) the resolution ──────────────────────────────────────────────────────

describe('(3) a person who types the ticket reply’s marker', () => {
  it('does not stop the platform’s reply on the ticket (author checked, as on the merge request)', async () => {
    const markerId = conversationReplyMarkerId(TASK, DEV_RUN, 0);
    const w = await world({
      comments: [
        ticketComment(),
        { ...ticketComment(), id: '10043', body: `${markerId}\nalready answered` },
      ],
      artifacts: [notesArtifact([{ thread_id: '10042', kind: 'fixed', reply: 'Renders now.' }])],
    });
    await w.replies();
    expect(w.recorded.commented.map((entry) => entry.markerId)).toEqual([markerId]);
    // …and a replay finds the platform's own, and posts nothing more.
    await w.replies();
    expect(w.recorded.commented).toHaveLength(1);
  });
});

describe('(4) resolving after a re-review', () => {
  /**
   * Canary (PROGRESS WP-179): with the marker check dropped from `runReviewThreadsResolve`, the
   * person's thread is resolved and this case fails.
   */
  it('resolves the Reviewer’s own finding thread and never a person’s', async () => {
    const w = await world({
      discussions: [personsThread(), findingThread()],
      artifacts: [reviewArtifact({ resolved_threads: ['person-diff', 'finding-thread'] })],
    });
    await w.resolve();

    expect(w.recorded.resolved).toEqual(['finding-thread']);
    expect(w.discussions.find((discussion) => discussion.id === 'person-diff')?.resolved).toBe(
      false,
    );
    // M28 ruling R2: the resolved thread is in the handled ledger, the person's is not; a replay
    // resolves nothing twice and records nothing twice.
    const ledger = await ledgerOf(w);
    expect(ledger.map((row) => [row.source, row.threadId, row.kind])).toEqual([
      ['mr_thread', 'finding-thread', 'resolved'],
    ]);
    expect(
      w.recorded.logs.filter((entry) => entry.message.includes('is not its own finding thread')),
    ).toHaveLength(1);
    await w.resolve();
    expect(await ledgerOf(w)).toEqual(ledger);
    expect(w.recorded.resolved).toEqual(['finding-thread']);
  });

  it('resolves neither another task’s finding thread nor a person’s thread that copies the marker', async () => {
    const copied: Discussion = {
      id: 'copied',
      resolvable: true,
      resolved: false,
      notes: [note(PERSON, `${reviewFindingMarkerFor(TASK, REVIEW_RUN, 'f1')}\nplease look`)],
    };
    const elsewhere = { ...findingThread(OTHER_TASK), id: 'elsewhere' };
    const w = await world({
      discussions: [copied, elsewhere],
      artifacts: [reviewArtifact({ resolved_threads: ['copied', 'elsewhere', 'gone'] })],
    });
    await w.resolve();
    expect(w.recorded.resolved).toEqual([]);
  });

  it('resolves nothing named in a verdict that names nothing', async () => {
    const w = await world({ discussions: [findingThread()], artifacts: [reviewArtifact()] });
    await w.resolve();
    expect(w.recorded.resolved).toEqual([]);
  });
});

// ── (5) shadow mode ─────────────────────────────────────────────────────────

describe('(5) a shadow task', () => {
  it('records would_have for every write and makes none', async () => {
    const w = await world({
      mode: 'shadow',
      discussions: [personsThread(), findingThread()],
      comments: [ticketComment()],
      artifacts: [
        reviewArtifact({ resolved_threads: ['finding-thread'] }),
        notesArtifact([
          { thread_id: 'person-diff', kind: 'fixed', reply: 'Done in integer cents.' },
          { thread_id: '10042', kind: 'fixed', reply: 'Renders now.' },
        ]),
      ],
    });
    await w.findings();
    await w.replies();
    await w.resolve();

    expect(w.recorded.created).toEqual([]);
    expect(w.recorded.replied).toEqual([]);
    expect(w.recorded.resolved).toEqual([]);
    expect(w.recorded.commented).toEqual([]);
    const writes = [
      'create_discussion',
      'create_merge_request_note',
      'reply_to_discussion',
      'resolve_discussion',
      'add_comment',
    ];
    for (const action of writes) {
      for (const entry of w.auditLog.entriesFor(action)) {
        expect({ action, status: entry.status }).toEqual({ action, status: 'would_have' });
      }
    }
    // Three findings, and (S-28.13) the summary as a general note.
    expect(w.auditLog.entriesFor('create_discussion')).toHaveLength(3);
    expect(w.auditLog.entriesFor('create_merge_request_note')).toHaveLength(1);
    expect(w.auditLog.entriesFor('reply_to_discussion')).toHaveLength(1);
    expect(w.auditLog.entriesFor('add_comment')).toHaveLength(1);
    // The finding thread's resolve and, since S-28.3, the person's thread the fixed reply answered.
    expect(w.auditLog.entriesFor('resolve_discussion')).toHaveLength(2);
    // M28 ruling R2: nothing was answered on the provider, so nothing is handled.
    expect(await ledgerOf(w)).toEqual([]);
  });
});

// ── WP-184: the stage job's turn and the outbound duty's, on one key ───────────

describe('WP-184: the pre-plan step and the outbound duty take turns under the task’s lease', () => {
  const entry = { stage: 'implementation', attempt: 2 } as const;

  it('(2) both at once post each finding once and one summary — the second turn replays', async () => {
    const w = await world({ artifacts: [reviewArtifact()], slowWrites: true });
    const stored = await w.loadTask();
    await Promise.all([performOwedDuties(w.taskOptions, stored, entry), w.outboundFindings()]);

    // Three findings and one summary: one call each, whichever performer ran first.
    expect(w.recorded.created).toHaveLength(4);
    // S-28.13: the three findings are threads, the summary a general note.
    const statuses = [
      ...w.auditLog.entriesFor('create_discussion'),
      ...w.auditLog.entriesFor('create_merge_request_note'),
    ].map((row) => row.status);
    expect(statuses.filter((status) => status === 'ok')).toHaveLength(4);
    expect(statuses.filter((status) => status === 'replayed')).toHaveLength(4);
  });

  it('needs the lease: the executor records a key only after its call, so an overlap posts twice', async () => {
    // The reading the WP-184 row asked for, kept as a case: with the lease disarmed, both
    // performers miss the idempotency record and both call. The memory store then refuses the
    // second record (its divergence 2), which the outbound turn throws; the posts happened.
    const w = await world({
      artifacts: [reviewArtifact()],
      slowWrites: true,
      dutyLease: { disarmed: true },
    });
    const stored = await w.loadTask();
    await Promise.allSettled([
      performOwedDuties(w.taskOptions, stored, entry),
      w.outboundFindings(),
    ]);
    expect(w.recorded.created.length).toBeGreaterThan(4);
  });

  it('(6) a shadow task: the pre-plan step makes no write, so each finding has one would_have row', async () => {
    const w = await world({ mode: 'shadow', artifacts: [reviewArtifact()] });
    await performOwedDuties(w.taskOptions, await w.loadTask(), entry);
    expect(w.auditLog.entriesFor('create_discussion')).toEqual([]);

    await w.outboundFindings();
    const rows = [
      ...w.auditLog.entriesFor('create_discussion'),
      ...w.auditLog.entriesFor('create_merge_request_note'),
    ];
    // Three findings and (S-28.13) the summary as a general note: one row each.
    expect(rows.map((row) => row.status)).toEqual([
      'would_have',
      'would_have',
      'would_have',
      'would_have',
    ]);
    expect(w.recorded.created).toEqual([]);
  });

  it('an outbound duty that finds the lease held gives up after the short wait, and its retry posts', async () => {
    const w = await world({ artifacts: [reviewArtifact()] });
    const holder = {
      taskId: TASK,
      lease: 'review_conversation',
      holder: 'duty:stage-job',
    } as const;
    await w.taskOptions.unitOfWork.transaction(async (scope) =>
      w.taskOptions.store.dutyLeases.claim(scope.tx, {
        ...holder,
        now: NOW,
        expiresAt: '2026-06-01T09:02:00.000Z' as IsoDateTime,
      }),
    );
    const started = Date.now();
    // The turn pg-boss runs: refused by name after OUTBOUND_DUTY_LEASE_WAIT_MS, nothing posted —
    // so the one outbound worker is held for the short wait, not the stage job's thirty seconds.
    await expect(w.outboundFindings()).rejects.toBeInstanceOf(TaskDutyLeaseBusyError);
    expect(Date.now() - started).toBeLessThan(TASK_DUTY_LEASE_WAIT_MS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(OUTBOUND_DUTY_LEASE_WAIT_MS - 50);
    expect(w.recorded.created).toEqual([]);

    // The holder finishes; the job's retry is the next turn.
    await w.taskOptions.unitOfWork.transaction(async (scope) =>
      w.taskOptions.store.dutyLeases.release(scope.tx, holder),
    );
    await w.outboundFindings();
    expect(w.recorded.created).toHaveLength(4);
  });

  it('a lease another performer holds for the whole wait is refused by name, and nothing is posted', async () => {
    const w = await world({ artifacts: [reviewArtifact()] });
    // Another performer holds the lease and never lets go within the wait.
    await w.taskOptions.unitOfWork.transaction(async (scope) =>
      w.taskOptions.store.dutyLeases.claim(scope.tx, {
        taskId: TASK,
        lease: 'review_conversation',
        holder: 'duty:elsewhere',
        now: NOW,
        expiresAt: '2026-06-01T09:02:00.000Z' as IsoDateTime,
      }),
    );
    const quick = {
      ...w.taskOptions,
      dutyLease: { pollMs: 1 },
    } as TaskTransactionOptions;
    await expect(
      withTaskDutyLease(
        quick,
        { taskId: TASK, lease: 'review_conversation', waitMs: 10 },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(TaskDutyLeaseBusyError);
    expect(w.recorded.created).toEqual([]);
  });
});

// ── S-28.3 (M28 ruling R3): resolve what was fixed; no thread left silent ────────

describe('(R3) resolving a person’s thread after the Developer’s reply', () => {
  const personThread = (id: string): Discussion => ({
    id,
    resolvable: true,
    resolved: false,
    notes: [note(PERSON, `Please change ${id}.`, 'src/totals.ts')],
  });
  const kinds = [
    { thread_id: 'p-fixed', kind: 'fixed', reply: 'Changed.' },
    { thread_id: 'p-documented', kind: 'documented', reply: 'Documented in the README.' },
    { thread_id: 'p-not-changed', kind: 'not_changed', reply: 'Kept on purpose.' },
    {
      thread_id: 'p-needs-person',
      kind: 'needs_person',
      reply: 'Set the variable.',
      person: 'The maintainer',
    },
    { thread_id: 'p-mixed', kind: 'fixed', reply: 'Code changed.' },
    { thread_id: 'p-mixed', kind: 'needs_person', reply: 'Rotate the key.', person: 'Ops' },
  ];
  const ids = ['p-fixed', 'p-documented', 'p-not-changed', 'p-needs-person', 'p-mixed'];

  /**
   * Canary: without `resolvePersonThread` in `runConversationReplies`, `resolved` is empty. A
   * `fixed` or `documented` reply resolves; `not_changed`, `needs_person` and a mixed note do not.
   */
  it('resolves a thread every entry of which is fixed or documented, and leaves the rest open', async () => {
    const w = await world({
      discussions: ids.map(personThread),
      artifacts: [notesArtifact(kinds)],
    });
    await w.replies();
    expect(w.recorded.resolved).toEqual(['p-fixed', 'p-documented']);
    for (const id of ['p-not-changed', 'p-needs-person', 'p-mixed']) {
      expect(w.discussions.find((discussion) => discussion.id === id)?.resolved, id).toBe(false);
    }
    expect(w.auditLog.entriesFor('resolve_discussion').map((entry) => entry.status)).toEqual([
      'ok',
      'ok',
    ]);
  });

  it('names the commit in a fixed or documented reply, and in no other', async () => {
    const w = await world({
      discussions: ids.map(personThread),
      artifacts: [notesArtifact(kinds)],
    });
    await w.replies();
    const byThread = (id: string) =>
      w.recorded.replied
        .filter((entry) => entry.discussionId === id)
        .map((entry) => entry.markdown);
    // The live head the run left, never the task's recorded one (S-28.3 review).
    expect(byThread('p-fixed')[0]).toContain(`Addressed in \`${LIVE_HEAD.slice(0, 8)}\`.`);
    expect(byThread('p-fixed')[0]).not.toContain(HEAD.slice(0, 8));
    expect(byThread('p-documented')[0]).toContain('Addressed in');
    expect(byThread('p-not-changed')[0]).not.toContain('Addressed in');
    expect(byThread('p-needs-person')[0]).not.toContain('Addressed in');
  });

  it('resolves nothing twice when the job is replayed', async () => {
    const w = await world({
      discussions: ids.map(personThread),
      artifacts: [notesArtifact(kinds)],
    });
    await w.replies();
    await w.replies();
    expect(w.recorded.resolved).toEqual(['p-fixed', 'p-documented']);
  });

  it('records would_have in shadow mode and resolves nothing', async () => {
    const w = await world({
      mode: 'shadow',
      discussions: ids.map(personThread),
      artifacts: [notesArtifact(kinds)],
    });
    await w.replies();
    expect(w.recorded.resolved).toEqual([]);
    expect(w.auditLog.entriesFor('resolve_discussion').map((entry) => entry.status)).toEqual([
      'would_have',
      'would_have',
    ]);
  });

  it('skips a provider that cannot resolve a discussion: the reply is posted, the thread stays open', async () => {
    const w = await world({
      resolveUnsupported: true,
      discussions: [personThread('p-fixed')],
      artifacts: [notesArtifact(kinds.slice(0, 1))],
    });
    await w.replies();
    expect(w.recorded.replied.map((entry) => entry.discussionId)).toEqual(['p-fixed']);
    expect(w.recorded.resolved).toEqual([]);
    expect(
      (await ledgerOf(w)).map((row) => row.kind),
      'answered, never resolved',
    ).toEqual(['answered']);
  });

  /** A person who wrote in the thread after the run began asked something the run never read. */
  it('does not resolve a fixed thread a person wrote in after the run was created', async () => {
    const thread: Discussion = {
      ...personThread('p-fixed'),
      notes: [
        note(PERSON, 'Please change p-fixed.', 'src/totals.ts'),
        { ...note(PERSON, 'And the footer too.'), created_at: '2026-06-01T09:30:00.000Z' },
      ],
    };
    const w = await world({ discussions: [thread], artifacts: [notesArtifact(kinds.slice(0, 1))] });
    await w.replies();
    expect(w.recorded.replied.map((entry) => entry.discussionId)).toEqual(['p-fixed']);
    expect(w.recorded.resolved).toEqual([]);
  });

  /**
   * S-28.3 review: a `fixed` reply after a run that pushed nothing (the live head is still the
   * recorded one) says so and resolves nothing.
   */
  it('resolves nothing and says not pushed yet when the live head did not move', async () => {
    const w = await world({
      liveHead: HEAD,
      discussions: [personThread('p-fixed')],
      artifacts: [notesArtifact(kinds.slice(0, 1))],
    });
    await w.replies();
    expect(w.recorded.resolved).toEqual([]);
    expect(w.recorded.replied[0]?.markdown).toContain('**Not pushed yet — still open.**');
    expect(w.recorded.replied[0]?.markdown).not.toContain('Addressed in');
  });

  /** S-28.3 review: a run that answered nothing still tells a person's open thread so. */
  it('tells an open person thread it is still open when the run wrote no replies at all', async () => {
    const w = await world({
      discussions: [personThread('p-silent')],
      artifacts: [notesArtifact([])],
    });
    await w.replies();
    expect(w.recorded.replied.map((entry) => entry.discussionId)).toEqual(['p-silent']);
    expect(w.recorded.replied[0]?.markdown).toContain('Not addressed in this run — still open.');
  });

  /** S-28.3 review: once per thread until a person writes again, never once per run. */
  it('does not say still open again on a thread an earlier run already told, until a person writes', async () => {
    const told: Discussion = {
      ...personThread('p-silent'),
      notes: [
        note(PERSON, 'Please change p-silent.', 'src/totals.ts'),
        note(
          BOT,
          `<!-- agentic:reply:${TASK}.earlier-run.open-p-silent -->\n**Not addressed in this run — still open.**`,
        ),
      ],
    };
    const w = await world({ discussions: [told], artifacts: [notesArtifact([])] });
    await w.replies();
    expect(w.recorded.replied).toEqual([]);
    const again: Discussion = { ...told, notes: [...told.notes, note(PERSON, 'Any news?')] };
    const w2 = await world({ discussions: [again], artifacts: [notesArtifact([])] });
    await w2.replies();
    expect(w2.recorded.replied.map((entry) => entry.discussionId)).toEqual(['p-silent']);
  });

  /** No thread is left silent: a person's open thread the run did not answer is told so, once. */
  it('tells a person’s open thread the run did not answer that it is still open, once', async () => {
    const w = await world({
      discussions: [personThread('p-fixed'), personThread('p-silent')],
      artifacts: [notesArtifact(kinds.slice(0, 1))],
    });
    await w.replies();
    await w.replies();
    const silent = w.recorded.replied.filter((entry) => entry.discussionId === 'p-silent');
    expect(silent).toHaveLength(1);
    expect(silent[0]?.markdown).toContain('Not addressed in this run — still open.');
    expect(silent[0]?.markdown.startsWith('<!-- agentic:reply:')).toBe(true);
    expect(w.recorded.resolved).toEqual(['p-fixed']);
    expect(w.discussions.find((discussion) => discussion.id === 'p-silent')?.resolved).toBe(false);
  });
});

// ── (S-28.13) the platform closes its own threads, and Ready reads the provider ─────────────

describe('(S-28.13) the platform closes its own threads after an approval (M28 ruling R3b)', () => {
  /** AUT-6655's five, plus the two the platform must leave alone. */
  const ownThreads = (): Discussion[] => [
    // An old review summary, posted as a thread before S-28.13.
    {
      id: 'old-summary',
      resolvable: true,
      resolved: false,
      notes: [note(BOT, `${reviewFindingSummaryMarkerFor(TASK, 'old-run')}\nThe reviewer asked.`)],
    },
    // A nit the Developer answered *Not changed*.
    {
      id: 'nit-not-changed',
      resolvable: true,
      resolved: false,
      notes: [
        note(BOT, `${reviewFindingMarkerFor(TASK, 'old-run', 'n1')}\n**nit · style**`),
        note(BOT, `${conversationReplyNoteMarker(TASK, DEV_RUN, 0)}\n**Not changed.**`),
      ],
    },
    // A finding the Developer fixed, which the re-review did not name.
    {
      id: 'finding-fixed',
      resolvable: true,
      resolved: false,
      notes: [
        note(BOT, `${reviewFindingMarkerFor(TASK, 'old-run', 'f9')}\n**major · correctness**`),
        note(BOT, `${conversationReplyNoteMarker(TASK, DEV_RUN, 1)}\n**Fixed.**`),
      ],
    },
    // The platform's finding in which a person wrote: the person's conversation now.
    {
      id: 'finding-person',
      resolvable: true,
      resolved: false,
      notes: [
        note(BOT, `${reviewFindingMarkerFor(TASK, 'old-run', 'f8')}\n**minor · naming**`),
        note(PERSON, 'I disagree — keep the old name.'),
      ],
    },
    // A person typed this task's marker: not the platform's, by author.
    {
      id: 'spoofed',
      resolvable: true,
      resolved: false,
      notes: [note(PERSON, `${reviewFindingMarkerFor(TASK, 'old-run', 'x')}\nmine`)],
    },
  ];
  const developerNotes = () =>
    notesArtifact([
      { thread_id: 'nit-not-changed', kind: 'not_changed', reply: 'Kept: it matches the module.' },
      { thread_id: 'finding-fixed', kind: 'fixed', reply: 'Summed every row.' },
    ]);
  const approving = () => reviewArtifact({ verdict: 'approve', findings: [] });

  it('resolves its own threads nobody wrote in, notes the one left as is, and never a person’s', async () => {
    const w = await world({
      discussions: ownThreads(),
      artifacts: [developerNotes(), approving()],
    });
    await w.findings();

    expect([...w.recorded.resolved].sort()).toEqual(
      ['finding-fixed', 'nit-not-changed', 'old-summary'].sort(),
    );
    const byId = (id: string) => w.discussions.find((discussion) => discussion.id === id);
    expect(byId('finding-person')?.resolved).toBe(false);
    expect(byId('spoofed')?.resolved).toBe(false);
    // The nit left as is gets one closing note first; the fixed one and the summary get none.
    const closing = w.recorded.replied.filter((entry) =>
      entry.markdown.startsWith(reviewLeftOpenNoteMarker(TASK, 'nit-not-changed')),
    );
    expect(closing).toHaveLength(1);
    expect(closing[0]?.markdown).toContain('Left as is.');
    expect(closing[0]?.markdown).toContain('reopen this thread and write what you want here');
    expect(w.recorded.replied.map((entry) => entry.discussionId)).toEqual(['nit-not-changed']);
    // The approving review's own summary is a note; of the platform's threads only the one a
    // person wrote in is still open.
    expect(
      w.discussions
        .filter(
          (discussion) =>
            discussion.resolvable &&
            !discussion.resolved &&
            discussion.notes[0]?.author.external_id === BOT.external_id,
        )
        .map((discussion) => discussion.id),
    ).toEqual(['finding-person']);
  });

  /** A replay posts no second note and resolves nothing again — and a person's reopen stands. */
  it('is idempotent across replays, and leaves a thread a person reopened open', async () => {
    const w = await world({
      discussions: ownThreads(),
      artifacts: [developerNotes(), approving()],
    });
    await w.findings();
    const resolvedOnce = w.recorded.resolved.length;
    // A person reopens the nit without writing.
    const nit = w.discussions.find((discussion) => discussion.id === 'nit-not-changed');
    if (nit !== undefined) nit.resolved = false;
    await w.findings();

    expect(w.recorded.resolved).toHaveLength(resolvedOnce);
    expect(nit?.resolved).toBe(false);
    expect(
      w.recorded.replied.filter((entry) =>
        entry.markdown.startsWith(reviewLeftOpenNoteMarker(TASK, 'nit-not-changed')),
      ),
    ).toHaveLength(1);
  });

  it('closes nothing after a review that asked for changes', async () => {
    const w = await world({
      discussions: ownThreads(),
      artifacts: [developerNotes(), reviewArtifact({ findings: [] })],
    });
    await w.findings();
    expect(w.recorded.resolved).toEqual([]);
    expect(w.recorded.replied).toEqual([]);
  });

  it('records would_have in shadow mode and changes nothing', async () => {
    const w = await world({
      mode: 'shadow',
      discussions: ownThreads(),
      artifacts: [developerNotes(), approving()],
    });
    await w.findings();
    expect(w.recorded.resolved).toEqual([]);
    expect(w.recorded.replied).toEqual([]);
    const statuses = w.auditLog.entriesFor('resolve_discussion').map((entry) => entry.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status === 'would_have')).toBe(true);
  });
});

describe('(S-28.13) Ready tells the truth about the provider (M28 ruling R3b (3))', () => {
  /**
   * A task already waiting at Ready when this shipped — AUT-6655: the check closes the platform's
   * own threads and records what the provider says, with the unresolved threads that remain.
   */
  it('closes the platform’s own threads at Ready, then records the block with the threads left', async () => {
    const person: Discussion = {
      id: 'person-open',
      resolvable: true,
      resolved: false,
      notes: [note(PERSON, 'Please rename this.')],
    };
    const w = await world({
      atReady: true,
      mergeBlocker: { reason: 'unresolved_threads', provider_status: 'discussions_not_resolved' },
      discussions: [
        {
          id: 'old-summary',
          resolvable: true,
          resolved: false,
          notes: [note(BOT, `${reviewFindingSummaryMarkerFor(TASK, 'old-run')}\nApproved.`)],
        },
        person,
      ],
      artifacts: [reviewArtifact({ verdict: 'approve', findings: [] })],
    });
    expect(await w.readyCheck()).toBe('blocked');
    expect(w.recorded.resolved).toEqual(['old-summary']);
    expect(await w.mergeCheck()).toMatchObject({
      mergeable: false,
      reason: 'unresolved_threads',
      providerStatus: 'discussions_not_resolved',
      unresolvedThreads: 1,
    });
  });

  it('records a mergeable merge request as mergeable, and says nothing while the provider decides', async () => {
    const clean = await world({
      atReady: true,
      artifacts: [reviewArtifact({ verdict: 'approve' })],
    });
    expect(await clean.readyCheck()).toBe('mergeable');
    expect((await clean.mergeCheck())?.mergeable).toBe(true);

    const deciding = await world({
      atReady: true,
      mergeBlocker: { reason: 'checking', provider_status: 'checking' },
    });
    expect(await deciding.readyCheck()).toBe('unknown');
    expect((await deciding.mergeCheck())?.mergeable).toBeNull();
  });

  it('checks nothing for a task that is not at Ready', async () => {
    const w = await world({
      mergeBlocker: { reason: 'pipeline', provider_status: 'ci_must_pass' },
    });
    expect(await w.readyCheck()).toBe('not_at_ready');
    expect(await w.mergeCheck()).toBeNull();
  });
});
