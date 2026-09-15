/**
 * The mined sample's bounds and its redaction (WP-35).
 *
 * The three things worth asserting are the three the module exists for, and none of them is
 * checkable by reading it:
 *
 *  - **the budget is derived from the constants**, so the figure in the docblock cannot drift from
 *    what the code does (PROGRESS backlog 22: a number a reader cannot re-derive from the line
 *    below it is a number that has already drifted);
 *  - **redaction happens before the cut**, which a test can only show by planting a credential
 *    *past* a cap and finding the placeholder rather than the leading bytes;
 *  - **`evidence_links` is the platform's own list**, because the recorder's whole refusal rests on
 *    it being complete.
 */

import { describe, expect, it } from 'vitest';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type {
  Discussion,
  MergedMergeRequest,
  RepositoryCommit,
} from '../ports/integrations/git-provider.js';
import type { Ticket } from '../ports/integrations/task-management.js';
import {
  buildHistorySample,
  HISTORY_COMMITS_PER_CHUNK,
  HISTORY_SAMPLE_MAX_TEXT_CHARS,
  HISTORY_TICKETS_PER_CHUNK,
  MAX_HISTORY_COMMIT_CHARS,
  MAX_HISTORY_NOTE_CHARS,
  MAX_HISTORY_NOTES_PER_MR,
  MAX_HISTORY_TITLE_CHARS,
} from './sample.js';

const SECRET = 'sk-ant-api03-PLANTED-CREDENTIAL-0000';

/** An exact-match redactor over one planted value — the shape TD-012 step 1 produces. */
const redactor = (): SecretRedactor & { readonly calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    redactText: (text: string) => {
      const count = text.split(SECRET).length - 1;
      calls += 1;
      return { value: text.split(SECRET).join('[REDACTED:integration:git]'), count };
    },
    redactJson: (value: unknown) => ({ value, count: 0 }),
  } as SecretRedactor & { readonly calls: () => number };
};

const mergeRequest = (overrides: Partial<MergedMergeRequest> = {}): MergedMergeRequest =>
  ({
    ref: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid: 11,
      url: 'https://git.example.test/acme/api/-/merge_requests/11',
      branch: 'feature/totals',
      head_sha: 'a'.repeat(40),
    },
    author: {
      provider: 'fake-git',
      external_id: 'dana',
      email: null,
      display_name: 'Dana Reviewer',
      verified: true,
    },
    merged_at: '2026-05-29T09:12:00.000Z',
    title: 'Sum the invoice footer',
    diff_stats: { files_changed: 3, additions: 40, deletions: 2 },
    discussion_count: 2,
    ...overrides,
  }) as MergedMergeRequest;

const discussion = (body: string, system = false): Discussion =>
  ({
    id: 'd1',
    resolvable: true,
    resolved: false,
    notes: [
      {
        id: 'n1',
        author: {
          provider: 'fake-git',
          external_id: 'dana',
          email: null,
          display_name: 'Dana Reviewer',
          verified: true,
        },
        body,
        created_at: '2026-05-28T09:00:00.000Z',
        system,
      },
    ],
  }) as Discussion;

const ticket = (overrides: Partial<Ticket> = {}): Ticket =>
  ({
    ref: { provider: 'fake-jira', key: 'ACME-3', url: 'https://jira.example.test/browse/ACME-3' },
    issue_type: 'Story',
    title: 'Rounding happens twice',
    description: 'The totals disagree by a cent.',
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
    updated_at: '2026-05-29T09:00:00.000Z',
    ...overrides,
  }) as Ticket;

const commit = (message: string): RepositoryCommit => ({
  sha: 'b'.repeat(40),
  message,
  author: 'Dana Reviewer',
  committed_at: '2026-05-29T09:12:00.000Z',
  url: null,
});

describe('the sample’s byte budget', () => {
  it('is the sum of its own caps, so the docblock’s figure cannot drift', () => {
    // 20 × (512 + 8 × 400) + 5 × (512 + 2 000 + 4 × 400) + 20 × 200.
    expect(HISTORY_SAMPLE_MAX_TEXT_CHARS(20)).toBe(
      20 * (MAX_HISTORY_TITLE_CHARS + MAX_HISTORY_NOTES_PER_MR * MAX_HISTORY_NOTE_CHARS) +
        HISTORY_TICKETS_PER_CHUNK * (512 + 2_000 + 4 * MAX_HISTORY_NOTE_CHARS) +
        HISTORY_COMMITS_PER_CHUNK * MAX_HISTORY_COMMIT_CHARS,
    );
    expect(HISTORY_SAMPLE_MAX_TEXT_CHARS(20)).toBe(98_800);
  });
});

describe('building a sample', () => {
  it('carries the merge request, its review comments and the platform’s own round count', () => {
    const sample = buildHistorySample({
      mergeRequests: [
        {
          mr: mergeRequest(),
          discussions: [
            discussion('Use the money helper.'),
            discussion('branch was deleted', true),
          ],
        },
      ],
      tickets: [ticket()],
      commits: [commit('fix(totals): round once')],
      redactor: redactor(),
    });
    expect(sample.merge_requests[0]?.ref).toBe('!11');
    expect(sample.merge_requests[0]?.notes.join('')).toContain('Use the money helper.');
    // The system note is neither a comment nor a round: product/19's threshold counts what a human
    // opened, and a fake that let a provider's own bookkeeping count would inflate every pitfall.
    expect(sample.merge_requests[0]?.notes.join('')).not.toContain('branch was deleted');
    expect(sample.merge_requests[0]?.rounds).toBe(1);
    expect(sample.merge_requests[0]?.files_changed).toBe(3);
    expect(sample.tickets[0]?.key).toBe('ACME-3');
    expect(sample.commits[0]?.message).toBe('fix(totals): round once');
    expect(sample.truncated).toBe(false);
  });

  it('lists every merge-request and ticket URL as the evidence a citation must resolve into', () => {
    const sample = buildHistorySample({
      mergeRequests: [{ mr: mergeRequest(), discussions: [] }],
      tickets: [ticket()],
      commits: [],
      redactor: redactor(),
    });
    expect(sample.evidence_links).toEqual([
      'https://git.example.test/acme/api/-/merge_requests/11',
      'https://jira.example.test/browse/ACME-3',
    ]);
  });

  it('redacts before it cuts, so a credential past the cap leaves a placeholder and not its head', () => {
    // The whole point of the ordering: the secret sits *past* `MAX_HISTORY_NOTE_CHARS`, so a cut
    // applied first would leave `sk-ant-api03-PLANT…` in the stored text and an exact-match
    // redactor could never find it again.
    const body = `${'x'.repeat(MAX_HISTORY_NOTE_CHARS - 5)}${SECRET} trailing`;
    const sample = buildHistorySample({
      mergeRequests: [{ mr: mergeRequest(), discussions: [discussion(body)] }],
      tickets: [],
      commits: [],
      redactor: redactor(),
    });
    const notes = sample.merge_requests[0]?.notes.join('') ?? '';
    expect(notes).not.toContain('sk-ant-api03');
    // The cut lands **inside the placeholder**, which is the residual `ticket-snapshot.ts` states
    // at its own `clean`: half of `[REDACTED:integration:git]` is not a credential. What matters is
    // that the replacement happened first, which the prefix and the absent key together show.
    expect(notes).toContain('[RED');
    // …and the count is over the text as it was **read**, so a sample whose secret was cut off
    // still says a secret was there.
    expect(sample.redaction_count).toBe(1);
    expect(sample.merge_requests[0]?.truncated).toBe(true);
  });

  it('announces a cut rather than refusing the item, and says so on the sample', () => {
    const sample = buildHistorySample({
      mergeRequests: [
        { mr: mergeRequest({ title: 'T'.repeat(MAX_HISTORY_TITLE_CHARS + 50) }), discussions: [] },
      ],
      tickets: [],
      commits: [],
      redactor: redactor(),
    });
    expect(sample.merge_requests[0]?.title).toHaveLength(MAX_HISTORY_TITLE_CHARS);
    expect(sample.merge_requests[0]?.truncated).toBe(true);
    expect(sample.truncated).toBe(true);
  });

  it('drops the tickets and commits past the per-chunk window, and records that it did', () => {
    const sample = buildHistorySample({
      mergeRequests: [{ mr: mergeRequest(), discussions: [] }],
      tickets: Array.from({ length: HISTORY_TICKETS_PER_CHUNK + 2 }, () => ticket()),
      commits: Array.from({ length: HISTORY_COMMITS_PER_CHUNK + 3 }, () => commit('chore: bump')),
      redactor: redactor(),
    });
    expect(sample.tickets).toHaveLength(HISTORY_TICKETS_PER_CHUNK);
    expect(sample.commits).toHaveLength(HISTORY_COMMITS_PER_CHUNK);
    expect(sample.truncated).toBe(true);
  });

  it('skips a comment the platform itself wrote, so an agent is not shown its own workpad', () => {
    const sample = buildHistorySample({
      mergeRequests: [],
      tickets: [
        ticket({
          comments: [
            {
              id: 'c1',
              author: { provider: 'fake-jira', external_id: 'bot', email: null, verified: true },
              body: 'the platform’s own workpad',
              created_at: '2026-05-29T09:00:00.000Z',
              marker_id: 'agentic:workpad',
            },
            {
              id: 'c2',
              author: { provider: 'fake-jira', external_id: 'sam', email: null, verified: true },
              body: 'fixed by rounding at the boundary',
              created_at: '2026-05-29T10:00:00.000Z',
              marker_id: null,
            },
          ],
        } as Partial<Ticket>),
      ],
      commits: [],
      redactor: redactor(),
    });
    const comments = sample.tickets[0]?.comments.join('') ?? '';
    expect(comments).toContain('fixed by rounding');
    expect(comments).not.toContain('workpad');
  });
});
