/**
 * `curateHistoryFindings` — the three things the platform checks about a mined proposal (WP-35).
 *
 * Every case is a **branch** rather than a shape: the module's whole value is what it refuses, so a
 * suite that only drove the accepting path would certify that the function returns an array
 * (standing rule 10). Each refusal is asserted **with the value at the boundary and one past it**
 * where there is a boundary (standing rule 42) — `occurrences` 3 and 2, `rounds` 3 and 2 — because
 * a curator that refused everything would pass a suite that only checked the refusals.
 */
import type { HistoryProposal, HistorySample } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  curateHistoryFindings,
  MIN_CONVENTION_OCCURRENCES,
  MIN_PITFALL_REVIEW_ROUNDS,
} from './history.js';

const MR_URL = 'https://git.example.test/acme/api/-/merge_requests/11';
const OTHER_URL = 'https://git.example.test/acme/api/-/merge_requests/12';
const TICKET_URL = 'https://jira.example.test/browse/ACME-3';

const mergeRequest = (ref: string, url: string, rounds: number) => ({
  ref,
  url,
  title: 'Sum the invoice footer',
  author: 'Dana Reviewer',
  merged_at: '2026-05-29T09:12:00.000Z' as HistorySample['merge_requests'][number]['merged_at'],
  rounds,
  files_changed: 3,
  notes: ['--- dana ---\nUse the money helper.'],
  truncated: false,
});

const SAMPLE: Pick<HistorySample, 'merge_requests' | 'tickets' | 'evidence_links'> = {
  merge_requests: [mergeRequest('!11', MR_URL, 4), mergeRequest('!12', OTHER_URL, 1)],
  tickets: [
    {
      key: 'ACME-3',
      url: TICKET_URL,
      title: 'Rounding',
      description: 'Rounding happens twice.',
      comments: [],
      truncated: false,
    },
  ],
  evidence_links: [MR_URL, OTHER_URL, TICKET_URL],
};

const proposal = (overrides: Partial<HistoryProposal> = {}): HistoryProposal => ({
  finding: 'rule',
  kind: 'technical',
  type: 'rule',
  target_path: 'technical/conventions.md',
  delta: '# Conventions\n\nMoney is never a float.\n',
  evidence: [{ kind: 'merge_request', ref: '!11', url: MR_URL }],
  occurrences: 2,
  significance: 0.7,
  reason: 'the same reviewer asked twice',
  ...overrides,
});

describe('curating a mining run’s proposals', () => {
  it('accepts a proposal whose every citation is in the batch it was shown', () => {
    const [entry] = curateHistoryFindings({ proposals: [proposal()], sample: SAMPLE });
    expect(entry?.refusedReason).toBeNull();
    // The citation travels as `<ref> <url>`, because a maintainer following one needs the URL and
    // `kb_proposals.evidence` is `text[]`.
    expect(entry?.librarian?.evidence).toEqual([`!11 ${MR_URL}`]);
    expect(entry?.librarian?.action).toBe('add');
    expect(entry?.librarian?.target_path).toBe('technical/conventions.md');
  });

  it('refuses a citation the run was never shown, naming it', () => {
    const invented = 'https://git.example.test/acme/api/-/merge_requests/999';
    const [entry] = curateHistoryFindings({
      proposals: [proposal({ evidence: [{ kind: 'merge_request', ref: '!999', url: invented }] })],
      sample: SAMPLE,
    });
    expect(entry?.librarian).toBeNull();
    expect(entry?.refusedReason).toContain('!999');
    expect(entry?.refusedReason).toContain('cannot resolve');
  });

  it('refuses a proposal that mixes a real citation with an invented one', () => {
    // The direction that matters: a model that cites one real merge request beside one it made up
    // must not be believed for the pair. The refusal is per proposal, not per citation.
    const [entry] = curateHistoryFindings({
      proposals: [
        proposal({
          evidence: [
            { kind: 'merge_request', ref: '!11', url: MR_URL },
            { kind: 'ticket', ref: 'ACME-9', url: 'https://jira.example.test/browse/ACME-9' },
          ],
        }),
      ],
      sample: SAMPLE,
    });
    expect(entry?.librarian).toBeNull();
    expect(entry?.refusedReason).toContain('ACME-9');
  });

  it('refuses a proposal with no citation at all', () => {
    // Unreachable through the schema (`evidence.min(1)`), and kept because the guarantee must not
    // rest on somebody else's parse — a row an older build wrote reaches this branch.
    const [entry] = curateHistoryFindings({
      proposals: [{ ...proposal(), evidence: [] } as HistoryProposal],
      sample: SAMPLE,
    });
    expect(entry?.librarian).toBeNull();
    expect(entry?.refusedReason).toContain('cites no merge request');
  });

  it('records a convention observed three times and refuses one observed twice', () => {
    const accepted = curateHistoryFindings({
      proposals: [proposal({ finding: 'convention', occurrences: MIN_CONVENTION_OCCURRENCES })],
      sample: SAMPLE,
    });
    expect(accepted[0]?.refusedReason).toBeNull();

    const refused = curateHistoryFindings({
      proposals: [proposal({ finding: 'convention', occurrences: MIN_CONVENTION_OCCURRENCES - 1 })],
      sample: SAMPLE,
    });
    expect(refused[0]?.librarian).toBeNull();
    expect(refused[0]?.refusedReason).toContain('observed 3 times');
  });

  it('records a pitfall from a merge request with enough review rounds and refuses one without', () => {
    // `!11` has four rounds, `!12` has one. The count is the **platform's**, taken when the sample
    // was built, so this compares the claim with the evidence rather than with itself.
    const accepted = curateHistoryFindings({
      proposals: [
        proposal({
          finding: 'pitfall',
          evidence: [{ kind: 'merge_request', ref: '!11', url: MR_URL }],
        }),
      ],
      sample: SAMPLE,
    });
    expect(accepted[0]?.refusedReason).toBeNull();

    const refused = curateHistoryFindings({
      proposals: [
        proposal({
          finding: 'pitfall',
          evidence: [{ kind: 'merge_request', ref: '!12', url: OTHER_URL }],
        }),
      ],
      sample: SAMPLE,
    });
    expect(refused[0]?.librarian).toBeNull();
    expect(refused[0]?.refusedReason).toContain(`${MIN_PITFALL_REVIEW_ROUNDS} review rounds`);
    expect(refused[0]?.refusedReason).toContain('has 1');
  });

  it('refuses a pitfall that cites only a ticket, because a ticket has no review rounds', () => {
    const [entry] = curateHistoryFindings({
      proposals: [
        proposal({
          finding: 'pitfall',
          evidence: [{ kind: 'ticket', ref: 'ACME-3', url: TICKET_URL }],
        }),
      ],
      sample: SAMPLE,
    });
    expect(entry?.librarian).toBeNull();
    expect(entry?.refusedReason).toContain('review rounds');
  });

  it('answers one entry per input, in input order, so a refusal is recorded rather than dropped', () => {
    const entries = curateHistoryFindings({
      proposals: [
        proposal({ reason: 'first' }),
        proposal({
          reason: 'second',
          evidence: [{ kind: 'merge_request', ref: '!404', url: 'https://x.example.test/1' }],
        }),
        proposal({ reason: 'third' }),
      ],
      sample: SAMPLE,
    });
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.proposal.reason)).toEqual(['first', 'second', 'third']);
    expect(entries.map((entry) => entry.refusedReason === null)).toEqual([true, false, true]);
  });
});
