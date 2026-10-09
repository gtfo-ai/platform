/**
 * **Every note the platform posts opens with a platform marker** — the census TD-029 decision 6
 * asks for (*"every platform write path opens its body with a marker; a census in the application
 * tier holds that"*), WP-179 criterion (6) and (e).
 *
 * Three halves, so a new renderer or a new write cannot slip past:
 *
 *  1. **The renderers.** Every function that renders a merge-request note is in {@link MR_NOTES},
 *     rendered with fixture input, and its body must open with `<!-- agentic:<kind>:<id> -->`
 *     (`isPlatformMergeRequestNote`); the ticket reply must open with its bare marker
 *     (`opensWithPlatformCommentMarker`). And each rendered body, read back as a person's word of
 *     every form, gives WP-178's decision **nothing** to return on.
 *  2. **The callers.** Every source file of this ring that posts a merge-request note
 *     (`.thread(`/`.reply(` on `reviewWrites`) is one of the files the table renders for, compared
 *     in both directions — a new caller fails here until its renderer is in the table.
 *  3. **The writes.** Every provider call that carries a body lives in `integrations.ts`, and each
 *     merge-request one is guarded by `assertOpensWithMarker` in the same helper, while each ticket
 *     one passes the port a marker id — so a caller that renders by hand is refused at run time.
 *
 * **What it does not claim, stated:** four **ticket** bodies — the workpad, the linter's comment,
 * the spike report and the claim refusal — do not open with a marker in the body; they carry it as
 * the port's `markerId`, which the adapters read back as `TicketComment.marker_id`, and decision 6's
 * ticket reading accepts either. Half 3 holds that they pass one. Making their bodies open with the
 * marker too is filed under WP-179's discovered work.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id, ReviewFinding } from '@platform/contracts';
import {
  type HumanWord,
  humanReturnDecision,
  isPlatformMergeRequestNote,
  opensWithPlatformCommentMarker,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { renderConflictWarning } from './conflict-warning.js';
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

const TICKET_REPLIES = KINDS.map((kind, index) => ({
  name: `ticket reply (${kind})`,
  markerId: conversationReplyMarkerId(TASK, RUN, index),
  body: renderConversationReply({
    marker: conversationReplyMarkerId(TASK, RUN, index),
    kind,
    reply: 'The footer renders now.',
    person: kind === 'needs_person' ? 'The maintainer' : null,
  }),
}));

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

  it.each(TICKET_REPLIES)('$name', ({ body, markerId }) => {
    expect(opensWithPlatformCommentMarker(body)).toBe(true);
    expect(body.startsWith(`${markerId}\n`)).toBe(true);
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
      expect(
        /port\.addComment\([^)]*\{ markerId: context\.markerId \}\)|port\.upsertWorkpad\(ticket, markerId,/.test(
          helper,
        ),
      ).toBe(true);
    }
  });
});
