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
import { IntegrationError } from '../ports/integrations/common.js';
import type { Discussion, GitProviderPort } from '../ports/integrations/git-provider.js';
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
import { staticPipelineIntegrations } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
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
} from './review-notes.js';
import { mergeRequestWords, ticketCommentWords } from './review-threads.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000017a1' as Id;
const TASK = '00000000-0000-4000-8000-0000000017a2' as Id;
const OTHER_TASK = '00000000-0000-4000-8000-0000000017a9' as Id;
const REVIEW_RUN = '00000000-0000-4000-8000-0000000017a3' as Id;
const DEV_RUN = '00000000-0000-4000-8000-0000000017a4' as Id;
const VERDICT_ID = '00000000-0000-4000-8000-0000000017a5' as Id;
const NOTES_ID = '00000000-0000-4000-8000-0000000017a6' as Id;
const NOW = '2026-06-01T09:00:00.000Z' as IsoDateTime;
const HEAD = 'b'.repeat(40);
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
  readonly created: { path: string | null; line: number | null; markdown: string }[];
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
    readonly discussions?: readonly Discussion[];
    readonly comments?: readonly TicketComment[];
    readonly artifacts?: readonly { id: Id; type: string; run: Id; data: unknown }[];
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
    createDiscussion: async (
      _ref: unknown,
      input: { path?: string | null; line?: number | null; markdown: string },
    ) => {
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
        state: 'active',
        currentStage: 'implementation',
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
  return {
    findings: () =>
      runReviewFindingsPost(conversationOptions, data('review_findings_post', VERDICT_ID)),
    replies: () =>
      runConversationReplies(conversationOptions, data('conversation_replies', NOTES_ID)),
    resolve: () =>
      runReviewThreadsResolve(conversationOptions, data('review_threads_resolve', VERDICT_ID)),
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
      'ok',
    ]);
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
      'ok',
      'replayed',
      'replayed',
      'replayed',
      'replayed',
    ]);
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
      'ok',
    ]);
  });
});

// ── (3) and (8) the replies ─────────────────────────────────────────────────

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

  it('none of its replies is a person’s word to the human-return window (decision 6)', async () => {
    const w = await replied();
    const words = [...mergeRequestWords(w.discussions), ...ticketCommentWords(w.comments)];
    const platform = words.filter((word) => word.text.includes('agentic:reply:'));
    expect(platform).toHaveLength(4);
    const decision = humanReturnDecision({
      stage: 'ready_for_merge',
      slots: { lifecycle: {}, pickUpFrom: null },
      status: null,
      words: platform,
      horizon: null,
      extraAcks: [],
      leftQa: null,
      entryStatus: null,
      seenAtQa: false,
    });
    expect(decision.kind).toBe('none');
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
    expect(
      w.recorded.logs.filter((entry) => entry.message.includes('is not its own finding thread')),
    ).toHaveLength(1);
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
      'reply_to_discussion',
      'resolve_discussion',
      'add_comment',
    ];
    for (const action of writes) {
      for (const entry of w.auditLog.entriesFor(action)) {
        expect({ action, status: entry.status }).toEqual({ action, status: 'would_have' });
      }
    }
    expect(w.auditLog.entriesFor('create_discussion')).toHaveLength(4);
    expect(w.auditLog.entriesFor('reply_to_discussion')).toHaveLength(1);
    expect(w.auditLog.entriesFor('add_comment')).toHaveLength(1);
    expect(w.auditLog.entriesFor('resolve_discussion')).toHaveLength(1);
  });
});
