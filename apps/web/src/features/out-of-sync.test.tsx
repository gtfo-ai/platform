/**
 * **A ticket or a merge request out of sync, said on the task page** (S-28.10, TD-029's amendment
 * C). AUT-6655: Jira at *Ready for Merge* beside a Draft merge request after twenty failed moves,
 * and nothing on the page. Canary: the notice not mounted on the task page leaves the region absent.
 */
import type { ProviderSync, TaskDetailResponse } from '@platform/contracts';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeRequestBlockedSentence,
  mergeRequestStillDraftSentence,
  OutOfSyncNotice,
  ticketOutOfSyncSentence,
} from './out-of-sync.js';

afterEach(() => {
  cleanup();
});

const ROW: ProviderSync = {
  subject: 'ticket_status',
  slot: 'in_progress',
  target: 'In Progress',
  observed: 'Ready for Merge',
  available: ['Released', 'Done'],
  reason: 'jira-cloud: no transition to In Progress from Ready for Merge',
  reason_code: 'invalid_request',
  failed_at: '2026-11-10T09:00:00.000Z',
  attempts: 20,
};

const detailWith = (rows: readonly ProviderSync[], canResume = true): TaskDetailResponse =>
  ({
    task: {
      ticket: {
        provider: 'jira-cloud',
        key: 'AUT-6655',
        url: 'https://jira.example.invalid/browse/AUT-6655',
      },
      mr_ref: {
        provider: 'gitlab',
        iid: 7,
        url: 'https://gitlab.example.invalid/acme/api/-/merge_requests/7',
      },
    },
    can_resume: canResume,
    provider_sync: rows,
  }) as unknown as TaskDetailResponse;

const commandsWith = (mutate = vi.fn()) =>
  ({
    retryTicketSync: { isPending: false, isError: false, error: null, mutate },
  }) as never;

describe('out of sync (S-28.10)', () => {
  it('says what the tracker shows, what the platform wanted, and the moves it offers', () => {
    expect(ticketOutOfSyncSentence(ROW, 'jira-cloud')).toBe(
      'Ticket status out of sync: Jira still says Ready for Merge; the platform wanted In Progress (when work starts) — Jira offers no such move from there (it offers: Released and Done).',
    );
    // A tracker that could not list the moves says nothing about them; one that could not be read
    // says that, never a status it did not see.
    expect(ticketOutOfSyncSentence({ ...ROW, available: null, observed: null }, 'jira-cloud')).toBe(
      'Ticket status out of sync: Jira could not be read afterwards; the platform wanted In Progress (when work starts).',
    );
  });

  it('draws the ticket box with the reason, Retry and Open in Jira, and Retry sends the command', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    const view = render(
      <OutOfSyncNotice detail={detailWith([ROW])} commands={commandsWith(mutate)} />,
    );
    expect(view.getByRole('region', { name: 'Out of sync' })).toBeTruthy();
    expect(view.container.querySelector('[data-out-of-sync-reason]')?.textContent).toBe(
      'Why Jira refused (20 times): jira-cloud: no transition to In Progress from Ready for Merge',
    );
    expect(view.getByText('Open in Jira')).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Retry' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('offers no Retry to a reader who may not resume the task', () => {
    const view = render(
      <OutOfSyncNotice detail={detailWith([ROW], false)} commands={commandsWith()} />,
    );
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says a merge request still a draft after it was marked ready', () => {
    const view = render(
      <OutOfSyncNotice
        detail={detailWith([
          {
            ...ROW,
            subject: 'merge_request_draft',
            slot: null,
            target: 'ready',
            observed: 'draft',
            available: null,
            reason_code: 'still_draft',
            attempts: 1,
          },
        ])}
        commands={commandsWith()}
      />,
    );
    expect(
      view.container.querySelector('[data-out-of-sync="merge_request_draft"]')?.textContent,
    ).toBe(mergeRequestStillDraftSentence('gitlab'));
    expect(mergeRequestStillDraftSentence('gitlab')).toContain('still a draft on GitLab');
  });

  /**
   * S-28.13 (M28 ruling R3b (3)): AUT-6655 waited at Ready while GitLab refused the merge
   * (`discussions_not_resolved`), and the page said nothing. Canary: the branch removed from the
   * notice draws the draft box's sentence instead, which this asserts against.
   */
  const BLOCKED: ProviderSync = {
    subject: 'merge_request_blocked',
    slot: null,
    target: 'mergeable',
    observed: 'discussions_not_resolved',
    available: null,
    reason: 'discussions_not_resolved',
    reason_code: 'unresolved_threads',
    failed_at: '2026-11-10T09:00:00.000Z',
    attempts: 1,
    unresolved_threads: 2,
  };

  it('says GitLab will not merge it yet, why in plain words, what to do, and links the merge request (S-28.13)', () => {
    const view = render(
      <OutOfSyncNotice detail={detailWith([BLOCKED])} commands={commandsWith()} />,
    );
    const sentence = view.container.querySelector(
      '[data-out-of-sync="merge_request_blocked"]',
    )?.textContent;
    expect(sentence).toBe(
      'GitLab will not merge this yet: 2 threads are unresolved. Resolve them on the merge request — or write in one to send the task back to the agent with that change.',
    );
    expect(view.getByText('GitLab will not merge this yet')).toBeTruthy();
    expect(view.getByText('Open the merge request on GitLab')).toBeTruthy();
    // No raw enum on screen.
    expect(view.container.textContent).not.toContain('discussions_not_resolved');
    expect(view.container.textContent).not.toContain('unresolved_threads');
  });

  it('gives every other reason its own sentence, and an unknown provider word plain words (S-28.13)', () => {
    expect(mergeRequestBlockedSentence({ ...BLOCKED, unresolved_threads: 1 }, 'gitlab')).toContain(
      '1 thread is unresolved.',
    );
    expect(
      mergeRequestBlockedSentence(
        { reason_code: 'pipeline', observed: 'ci_must_pass', unresolved_threads: null },
        'gitlab',
      ),
    ).toBe(
      'GitLab will not merge this yet: its pipeline has not passed yet. Open the merge request to see the pipeline; the platform checks again once it passes.',
    );
    expect(
      mergeRequestBlockedSentence(
        { reason_code: 'conflict', observed: 'conflict', unresolved_threads: null },
        'gitlab',
      ),
    ).toContain('its branch conflicts with the target branch.');
    expect(
      mergeRequestBlockedSentence(
        { reason_code: 'approvals', observed: 'not_approved', unresolved_threads: null },
        'gitlab',
      ),
    ).toContain('it still needs approval from a reviewer.');
    expect(
      mergeRequestBlockedSentence(
        { reason_code: 'other', observed: 'title_regex', unresolved_threads: null },
        'gitlab',
      ),
    ).toContain('its title does not match the project’s rule for titles.');
    const unknown = mergeRequestBlockedSentence(
      { reason_code: 'other', observed: 'brand_new_rule', unresolved_threads: null },
      'gitlab',
    );
    expect(unknown).toContain('“brand new rule”');
    expect(unknown).not.toContain('brand_new_rule');
  });

  it('draws nothing when nothing is out of sync', () => {
    const view = render(<OutOfSyncNotice detail={detailWith([])} commands={commandsWith()} />);
    expect(view.container.innerHTML).toBe('');
  });
});
