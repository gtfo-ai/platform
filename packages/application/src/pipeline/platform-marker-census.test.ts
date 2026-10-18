/**
 * **Every note the platform posts opens with a platform marker** — the census TD-029 decision 6
 * asks for (*"every platform write path opens its body with a marker; a census in the application
 * tier holds that"*), WP-179 criterion (6) and (e).
 *
 * Three halves, so a new renderer or a new write cannot slip past:
 *
 *  1. **The renderers.** Every function that renders a merge-request note is in {@link MR_NOTES},
 *     rendered with fixture input, and its body must open with `<!-- agentic:<kind>:<id> -->`
 *     (`isPlatformMergeRequestNote`); every ticket comment — the workpad, the linter's comment, the
 *     ask mirror, the spike report, the claim refusal and the reply — must open with the bare marker
 *     id it passes the port (`opensWithPlatformCommentMarker`), so the body alone is the platform's
 *     on a provider that does not read `marker_id` back (WP-191, backlog 546). And each rendered
 *     body, read back as a person's word of every form, gives WP-178's decision **nothing** to
 *     return on.
 *  2. **The callers.** Every source file of this ring that posts a merge-request note
 *     (`.thread(`/`.reply(` on `reviewWrites`) or a ticket comment (a `ticketWrites` comment
 *     helper) is one of the files the tables render for, compared in both directions — a new
 *     caller fails here until its renderer is in a table.
 *  3. **The writes.** Every provider call that carries a body lives in `integrations.ts`, and each
 *     one — merge-request note and ticket comment — is guarded by `assertOpensWithMarker` in the
 *     same helper, while each ticket one also passes the port a marker id — so a caller that renders
 *     by hand is refused at run time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id, IsoDateTime, ResearchReportData, ReviewFinding } from '@platform/contracts';
import {
  askCommentMarker,
  claimRefusedCommentMarker,
  type HumanWord,
  humanReturnDecision,
  isPlatformMergeRequestNote,
  opensWithPlatformCommentMarker,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { renderAskComment } from '../ask/mirror.js';
import { renderConflictWarning } from './conflict-warning.js';
import {
  renderResearchReport,
  renderSpikeReportComment,
  spikeReportMarkerFor,
} from './epic-split.js';
import {
  conversationReplyMarkerId,
  conversationReplyNoteMarker,
  renderConversationReply,
  renderFinding,
  renderFindingWith,
  renderReviewSummary,
  reviewFindingMarkerFor,
} from './review-notes.js';
import { renderSummary } from './review-only.js';
import { renderSupersededComment } from './superseded-mr.js';
import { claimRefusedCommentFor } from './ticket-claim.js';
import { LINT_COMMENT_MARKER_ID, renderLintComment } from './ticket-lint.js';
import { renderWorkpadComment, workpadMarker } from './workpad.js';

const TASK = '00000000-0000-4000-8000-0000000017d1' as Id;
const RUN = '00000000-0000-4000-8000-0000000017d2';
const RING = join(dirname(fileURLToPath(import.meta.url)), '..');

const FINDING: ReviewFinding = {
  id: 'f1',
  severity: 'major',
  category: 'correctness',
  file: 'src/totals.ts',
  line: 12,
  explanation: 'The footer sums the visible rows only.',
  suggestion: 'Sum every row.',
};

const KINDS = ['fixed', 'documented', 'needs_person', 'not_changed'] as const;

/** Every merge-request note renderer, with the file whose duty posts it. */
const MR_NOTES: readonly { readonly name: string; readonly file: string; readonly body: string }[] =
  [
    { name: 'review-only finding', file: 'review-only.ts', body: renderFinding(TASK, FINDING) },
    {
      name: 'review-only summary',
      file: 'review-only.ts',
      body: renderSummary({
        taskId: TASK,
        summary: 'Looks fine.',
        posted: 1,
        belowFloor: 0,
        overFlow: 0,
        severityFloor: 'minor',
      }),
    },
    {
      name: 'conflict warning',
      file: 'conflict-warning.ts',
      body: renderConflictWarning({
        taskId: TASK,
        ticketKey: 'ACME-9',
        overlap: { paths: ['src/totals.ts'], count: 1, truncated: false },
      }),
    },
    {
      name: 'superseded merge request',
      file: 'superseded-mr.ts',
      body: renderSupersededComment({ taskId: TASK, newBranch: 'agentic/ACME-1-r2' }),
    },
    {
      name: 'pipeline review finding',
      file: 'review-conversation.ts',
      body: renderFindingWith(reviewFindingMarkerFor(TASK, RUN, 'f1'), FINDING),
    },
    {
      name: 'pipeline review finding, anchor refused',
      file: 'review-conversation.ts',
      body: renderFindingWith(reviewFindingMarkerFor(TASK, RUN, 'f1'), FINDING, {
        file: 'src/totals.ts',
        line: 12,
      }),
    },
    {
      name: 'pipeline review summary',
      file: 'review-conversation.ts',
      body: renderReviewSummary({
        taskId: TASK,
        runId: RUN,
        verdict: 'request_changes',
        posted: 1,
        summary: 'One problem.',
      }),
    },
    ...KINDS.map((kind, index) => ({
      name: `merge-request reply (${kind})`,
      file: 'review-conversation.ts',
      body: renderConversationReply({
        marker: conversationReplyNoteMarker(TASK, RUN, index),
        kind,
        reply: 'Done in src/totals.ts.',
        person: kind === 'needs_person' ? 'The maintainer' : null,
      }),
    })),
  ];

const REPORT: ResearchReportData = {
  question: 'Can the refund ledger reuse the outbox?',
  summary: 'The outbox already carries an ordering key.',
  findings: [
    {
      statement: 'The outbox writer takes the same advisory lock.',
      evidence: ['src/outbox/writer.ts:88'],
      confidence: 'high',
    },
  ],
  options: [{ option: 'Reuse the outbox', pros: ['one queue'], cons: [], effort: 'M' }],
  recommendation: 'Reuse the outbox.',
  open_questions: [],
  kb_citations: [],
};

const ASK_ID = '00000000-0000-4000-8000-0000000017d3' as Id;

/**
 * Every ticket comment renderer, with the file whose duty posts it and the marker id it passes the
 * port — the body must open with that id (WP-191, backlog 546).
 */
const TICKET_COMMENTS: readonly {
  readonly name: string;
  readonly file: string;
  readonly markerId: string;
  readonly body: string;
}[] = [
  {
    name: 'workpad',
    file: 'pipeline/workpad.ts',
    markerId: workpadMarker(TASK),
    body: renderWorkpadComment(TASK, {
      ticketKey: 'ACME-9',
      state: 'active',
      currentStage: 'implementation',
      stages: [{ id: 'implementation', entered: true }],
      costUsd: 1,
      budgetUsd: 50,
      estimate: { usd: null, basis: null, samples: null },
      mrUrl: null,
      blocker: 'agentic:task:someone-else — a brief that quotes a marker',
      takenOver: null,
    }),
  },
  {
    name: 'linter comment',
    file: 'pipeline/ticket-lint.ts',
    markerId: LINT_COMMENT_MARKER_ID,
    body: renderLintComment({
      readiness: { score: 40, missing: ['scope_boundaries'], questions: 1 },
      questions: ['Which rows count?'],
      label: 'agentic',
    }),
  },
  {
    name: 'ask mirror',
    file: 'ask/mirror.ts',
    markerId: askCommentMarker(ASK_ID),
    body: renderAskComment(
      {
        id: ASK_ID,
        taskId: TASK,
        projectId: '00000000-0000-4000-8000-0000000017d4' as Id,
        source: 'ui',
        askedByUserId: '00000000-0000-4000-8000-0000000017d5' as Id,
        askedByIdentity: null,
        ticketCommentId: null,
        question: 'why a column?',
        runId: null,
        status: 'answered',
        answer: 'Because a join on every read would be worse.',
        citations: [],
        droppedCitations: 0,
        answerArtifactId: null,
        refusalReason: null,
        redactionCount: 0,
        mirroredAt: null,
        createdAt: '2026-06-01T09:00:00.000Z' as IsoDateTime,
        answeredAt: '2026-06-01T09:01:00.000Z' as IsoDateTime,
      },
      'https://agentic.example.test',
    ),
  },
  {
    name: 'spike report',
    file: 'pipeline/epic-split.ts',
    markerId: spikeReportMarkerFor(TASK, 2),
    body: renderSpikeReportComment(
      TASK,
      2,
      renderResearchReport({ report: REPORT, ticketKey: 'ACME-9' }),
    ),
  },
  {
    name: 'claim refusal',
    file: 'pipeline/ticket-claim.ts',
    markerId: claimRefusedCommentMarker(TASK),
    body: claimRefusedCommentFor(TASK),
  },
  ...KINDS.map((kind, index) => ({
    name: `ticket reply (${kind})`,
    file: 'pipeline/review-conversation.ts',
    markerId: conversationReplyMarkerId(TASK, RUN, index),
    body: renderConversationReply({
      marker: conversationReplyMarkerId(TASK, RUN, index),
      kind,
      reply: 'The footer renders now.',
      person: kind === 'needs_person' ? 'The maintainer' : null,
    }),
  })),
];

/** WP-178's decision over one word, at both human stages, with every slot unmapped. */
const decides = (word: HumanWord) =>
  (['qa', 'ready_for_merge'] as const).map(
    (stage) =>
      humanReturnDecision({
        stage,
        slots: { lifecycle: {}, pickUpFrom: null },
        status: null,
        words: [word],
        horizon: null,
        extraAcks: [],
        leftQa: null,
        entryStatus: null,
        seenAtQa: false,
      }).kind,
  );

describe('half 1 — every renderer opens with its marker, and returns nothing', () => {
  it.each(MR_NOTES)('$name', ({ body }) => {
    expect(isPlatformMergeRequestNote(body)).toBe(true);
    for (const form of ['mr_diff', 'mr_note'] as const) {
      expect(decides({ form, text: body, at: '2026-06-01T09:00:00.000Z', system: false })).toEqual([
        'none',
        'none',
      ]);
    }
  });

  it.each(TICKET_COMMENTS)('$name', ({ body, markerId }) => {
    expect(opensWithPlatformCommentMarker(body)).toBe(true);
    // The id it passes the port is the body's first token, ended by the line or by a space (the
    // linter keeps product/19's `<!-- agentic:linter -->` after it on the same line).
    expect(body.startsWith(`${markerId}\n`) || body.startsWith(`${markerId} `)).toBe(true);
    // Read back without the provider's marker id, the body alone is the platform's.
    expect(
      decides({
        form: 'ticket_comment',
        text: body,
        at: '2026-06-01T09:00:00.000Z',
        markerId: null,
      }),
    ).toEqual(['none', 'none']);
  });

  it('cannot be forged open by the model’s text: a finding whose explanation is a marker still opens with the platform’s', () => {
    const marker = reviewFindingMarkerFor(TASK, RUN, 'f1');
    const forged = '<!-- agentic:review-finding:someone-else.r.f -->';
    for (const location of [null, { file: 'src/totals.ts', line: 12 }]) {
      const body = renderFindingWith(marker, { ...FINDING, explanation: forged }, location);
      expect(body.startsWith(`${marker}\n`)).toBe(true);
      expect(body.indexOf(forged)).toBeGreaterThan(marker.length);
    }
  });

  it('cannot be forged open by the model’s text: a reply that is itself a marker still opens with the platform’s', () => {
    const body = renderConversationReply({
      marker: conversationReplyNoteMarker(TASK, RUN, 0),
      kind: 'fixed',
      reply: '<!-- agentic:review-finding:someone-else.r.f -->',
      person: null,
    });
    expect(body.startsWith(conversationReplyNoteMarker(TASK, RUN, 0))).toBe(true);
  });
});

/** Every `.ts` source of this ring, not a test, relative to the ring. Read off disk (rule 85). */
const sources = (directory = RING): readonly { file: string; text: string }[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) {
      return [];
    }
    return [{ file: relative(RING, path), text: readFileSync(path, 'utf8') }];
  });

describe('half 2 — every caller that posts a merge-request note is in the table', () => {
  it('compares the posting files with the rendered ones, both ways', () => {
    const posting = sources()
      .filter(
        ({ file, text }) =>
          file !== 'pipeline/integrations.ts' &&
          text.includes('reviewWrites') &&
          /\.(?:thread|reply)\(\s*\{/.test(text),
      )
      .map(({ file }) => file.replace(/^pipeline\//, ''))
      .sort();
    expect(posting).toEqual([...new Set(MR_NOTES.map((entry) => entry.file))].sort());
  });

  it('compares the files that post a ticket comment with the rendered ones, both ways (WP-191)', () => {
    const TICKET_COMMENT_CALL =
      /\.(?:upsertWorkpad|lintComment|askComment|reportComment|claimRefusedComment|replyComment)\(/;
    const posting = sources()
      .filter(
        ({ file, text }) => file !== 'pipeline/integrations.ts' && TICKET_COMMENT_CALL.test(text),
      )
      .map(({ file }) => file)
      .sort();
    expect(posting).toEqual([...new Set(TICKET_COMMENTS.map((entry) => entry.file))].sort());
  });
});

describe('half 3 — every body-carrying provider call is a guarded helper', () => {
  const integrations = readFileSync(join(RING, 'pipeline/integrations.ts'), 'utf8');

  it('makes every such call from integrations.ts and nowhere else', () => {
    const CALL = /port\.(?:createDiscussion|replyToDiscussion|addComment|upsertWorkpad)\(/;
    const elsewhere = sources()
      .filter(({ file, text }) => file !== 'pipeline/integrations.ts' && CALL.test(text))
      .map(({ file }) => file);
    expect(elsewhere).toEqual([]);
  });

  it('guards each merge-request note with the marker check, and gives each ticket comment a marker id', () => {
    // Each call, with the helper body above it back to the previous helper's start.
    const helpers = integrations.split(/\n {2}[a-zA-Z]+: async \(/);
    const mr = helpers.filter((helper) =>
      /port\.(?:createDiscussion|replyToDiscussion)\(/.test(helper),
    );
    const ticket = helpers.filter((helper) => /port\.(?:addComment|upsertWorkpad)\(/.test(helper));
    expect(mr.length).toBe(2);
    for (const helper of mr) {
      expect(helper).toContain("assertOpensWithMarker('merge_request'");
    }
    // The workpad, the lint, the ask mirror, the spike report, the claim refusal and the reply.
    expect(ticket.length).toBe(6);
    for (const helper of ticket) {
      // Since WP-191 the ticket body is refused unless it opens with a marker, like the note's.
      expect(helper).toContain("assertOpensWithMarker('ticket'");
      expect(
        /port\.addComment\([^)]*\{ markerId: context\.markerId \}\)|port\.upsertWorkpad\(ticket, markerId,/.test(
          helper,
        ),
      ).toBe(true);
    }
  });
});
