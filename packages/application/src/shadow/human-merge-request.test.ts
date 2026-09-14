/**
 * Q82 (b)'s lookup, both lookups and both refusals (WP-34).
 *
 * The property this file exists to hold is the one that silently produces a wrong similarity
 * figure: **a link that resolves to a different merge request is not a match.** The platform
 * addresses merge requests by iid within the bound project, so a link naming `other/project!12`
 * would otherwise be read against *this* project's `!12` — and every number downstream would be
 * about somebody else's change. The provider's own `ref.url` is compared with the link, and the
 * case below is the one that fails without that comparison.
 */
import { describe, expect, it } from 'vitest';
import type { MergedMergeRequest, MergeRequest } from '../ports/integrations/git-provider.js';
import {
  findHumanMergeRequest,
  mentionsTicketKey,
  parseMergeRequestIid,
} from './human-merge-request.js';

const HOST = 'https://git.example.test/acme/api/-/merge_requests';

const merged = (iid: number, overrides: Partial<MergedMergeRequest> = {}): MergedMergeRequest => ({
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid,
    url: `${HOST}/${iid}`,
    branch: `feature/proj-${iid}`,
    head_sha: 'a'.repeat(40),
  },
  author: { provider: 'fake-git', external_id: 'dana', email: null, verified: false },
  merged_at: '2026-04-01T09:00:00.000Z',
  title: `Sum the totals (PROJ-${iid})`,
  diff_stats: null,
  discussion_count: 1,
  ...overrides,
});

const full = (iid: number, baseSha: string | null, url?: string): MergeRequest =>
  ({
    ref: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid,
      url: url ?? `${HOST}/${iid}`,
      branch: `feature/proj-${iid}`,
      head_sha: 'a'.repeat(40),
    },
    state: 'merged' as const,
    draft: false,
    title: 'Sum the totals',
    description: '',
    source_branch: `feature/proj-${iid}`,
    target_branch: 'main',
    head_sha: 'a'.repeat(40),
    base_sha: baseSha,
    mergeable: true,
    has_conflicts: false,
    coverage_pct: null,
    labels: [],
    reviewers: [],
    web_url: url ?? `${HOST}/${iid}`,
    merged_at: '2026-04-01T09:00:00.000Z',
  }) as MergeRequest;

/** The three `gitReads` members this lookup uses, as the narrowest double that type-checks. */
const reads = (mergeRequest: (iid: number) => MergeRequest | null) =>
  ({
    mergeRequest: async (ref: { iid: number }) => mergeRequest(ref.iid),
  }) as never;

const context = { projectId: 'p' as never, taskId: null };

describe('parseMergeRequestIid', () => {
  it('reads GitLab’s and GitHub’s shapes, with a fragment, a query and a trailing slash', () => {
    expect(parseMergeRequestIid(`${HOST}/7`)).toBe(7);
    expect(parseMergeRequestIid(`${HOST}/7/`)).toBe(7);
    expect(parseMergeRequestIid(`${HOST}/7#note_1`)).toBe(7);
    expect(parseMergeRequestIid(`${HOST}/7?tab=diffs`)).toBe(7);
    expect(parseMergeRequestIid('https://github.test/acme/api/pull/42')).toBe(42);
  });

  it('refuses a sub-page, a non-number and a URL about something else', () => {
    // A link to a sub-page is a link somebody made to something more specific, and guessing which
    // merge request they meant is the guess this module exists not to make.
    expect(parseMergeRequestIid(`${HOST}/7/diffs`)).toBeNull();
    expect(parseMergeRequestIid(`${HOST}/seven`)).toBeNull();
    expect(parseMergeRequestIid(`${HOST}/0`)).toBeNull();
    expect(parseMergeRequestIid('https://jira.example.test/browse/PROJ-7')).toBeNull();
  });
});

describe('mentionsTicketKey', () => {
  it('matches a whole token, in either case, and never a longer key', () => {
    expect(mentionsTicketKey('Fix PROJ-1 in the footer', 'PROJ-1')).toBe(true);
    expect(mentionsTicketKey('feature/proj-1-totals', 'PROJ-1')).toBe(true);
    // The case that `\b` gets wrong: `\bPROJ-1\b` matches inside `PROJ-12` at the hyphen.
    expect(mentionsTicketKey('Fix PROJ-12 in the footer', 'PROJ-1')).toBe(false);
    expect(mentionsTicketKey('XPROJ-1', 'PROJ-1')).toBe(false);
  });

  it('is false for an empty key rather than true for everything', () => {
    expect(mentionsTicketKey('anything at all', '')).toBe(false);
  });
});

describe('findHumanMergeRequest', () => {
  it('prefers a link on the ticket, and records that it did', async () => {
    const match = await findHumanMergeRequest(
      { reads: reads((iid) => full(iid, 'b'.repeat(40))), context },
      {
        ticketKey: 'PROJ-1',
        links: [{ url: `${HOST}/7` }],
        // A scan candidate exists and must **not** win: the link is the authoritative answer.
        merged: [merged(9, { title: 'Sum the totals (PROJ-1)' })],
      },
    );
    expect(match?.source).toBe('ticket_link');
    expect(match?.mergeRequest.iid).toBe(7);
    expect(match?.baseSha).toBe('b'.repeat(40));
  });

  it('refuses a link whose iid resolves to a different merge request, and falls through', async () => {
    // The defect this comparison exists to stop: the link names another project's `!7`, and the
    // platform would resolve `7` inside *this* project. Without the URL check the comparison would
    // silently be about somebody else's change.
    const match = await findHumanMergeRequest(
      {
        reads: reads((iid) => full(iid, 'c'.repeat(40))),
        context,
      },
      {
        ticketKey: 'PROJ-9',
        links: [{ url: 'https://git.example.test/other/project/-/merge_requests/7' }],
        merged: [merged(9, { title: 'Sum the totals (PROJ-9)' })],
      },
    );
    expect(match?.source).toBe('title_scan');
    expect(match?.mergeRequest.iid).toBe(9);
  });

  it('scans titles and branches, takes the newest, and counts the candidates', async () => {
    const match = await findHumanMergeRequest(
      { reads: reads((iid) => full(iid, 'd'.repeat(40))), context },
      {
        ticketKey: 'PROJ-3',
        links: [],
        merged: [
          merged(3, { title: 'First attempt (PROJ-3)', merged_at: '2026-01-01T00:00:00.000Z' }),
          merged(4, {
            title: 'unrelated',
            merged_at: '2026-05-01T00:00:00.000Z',
            ref: {
              provider: 'fake-git',
              project_path: 'acme/api',
              iid: 4,
              url: `${HOST}/4`,
              branch: 'feature/proj-3-second',
              head_sha: 'a'.repeat(40),
            },
          }),
        ],
      },
    );
    expect(match?.source).toBe('title_scan');
    expect(match?.mergeRequest.iid).toBe(4);
    expect(match?.candidates).toBe(2);
  });

  it('answers null when nothing matches — which is not a refusal, and the report says so', async () => {
    const match = await findHumanMergeRequest(
      { reads: reads(() => null), context },
      { ticketKey: 'PROJ-99', links: [], merged: [merged(3)] },
    );
    expect(match).toBeNull();
  });

  it('carries a null merge base through, so the caller can refuse the ticket by name', async () => {
    // Q82 (a): a merge request whose `diff_refs` the provider has not populated. The platform
    // refuses the ticket rather than comparing against today's default branch; this is the input
    // that refusal is made from.
    const match = await findHumanMergeRequest(
      { reads: reads((iid) => full(iid, null)), context },
      { ticketKey: 'PROJ-3', links: [], merged: [merged(3)] },
    );
    expect(match?.baseSha).toBeNull();
  });

  it('survives a project with no git binding, where every read answers null', async () => {
    const match = await findHumanMergeRequest(
      { reads: reads(() => null), context },
      { ticketKey: 'PROJ-1', links: [{ url: `${HOST}/7` }], merged: [] },
    );
    expect(match).toBeNull();
  });
});
