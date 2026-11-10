/**
 * **Who merges, said on the task page** (S-28.15, TD-038 decision 7): before (who merges and what
 * the platform waits for), a refusal (what · why · next), and after (merged by the platform, the
 * commit and the plan decision it rested on — each of the three).
 */
import type { ProviderSync, TaskDetailResponse, TaskMerge } from '@platform/contracts';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MergeStatusNotice, mergeStatusLines } from './merge-status.js';

afterEach(() => {
  cleanup();
});

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

const detailWith = (
  merge: TaskMerge | null,
  state = 'ready_for_merge',
  sync: readonly ProviderSync[] = [],
): TaskDetailResponse =>
  ({
    task: {
      state,
      ticket: { provider: 'jira-cloud', key: 'AUT-6655', url: 'https://jira.example.invalid/x' },
      mr_ref: {
        provider: 'gitlab',
        iid: 7,
        url: 'https://gitlab.example.invalid/acme/api/-/merge_requests/7',
      },
    },
    provider_sync: sync,
    merge,
  }) as unknown as TaskDetailResponse;

const ATTEMPT = {
  head_sha: 'a'.repeat(40),
  provider_status: null,
  merge_commit_sha: 'abc1234def567890abc1234def567890abc1234d',
  plan_decision: 'approved_by_person' as const,
  plan_approved_by: 'Jana Nováková',
  attempted_at: '2026-11-10T14:02:00.000Z',
};

describe('who merges, on the task page (S-28.15)', () => {
  it('says a person merges, by the project’s setting', () => {
    const said = mergeStatusLines(
      detailWith({ by: 'person', waiting_for: 'setting_person', last_attempt: null }),
    );
    expect(said?.lines[0]).toMatch(/^A person merges: this project’s setting\./);
  });

  it('says the platform merges when GitLab reports it mergeable, with what it waits for now', () => {
    const said = mergeStatusLines(
      detailWith({ by: 'platform', waiting_for: null, last_attempt: null }, 'ready_for_merge', [
        BLOCKED,
      ]),
    );
    expect(said?.lines[0]).toBe(
      'Merging automatically when GitLab reports it mergeable — now: 2 threads are unresolved.',
    );
    const moved = mergeStatusLines(
      detailWith({ by: 'platform', waiting_for: 'head_moved', last_attempt: null }),
    );
    expect(moved?.lines[0]).toContain('the branch moved since the reviewed commit');
    const bound = mergeStatusLines(
      detailWith({ by: 'platform', waiting_for: 'rebase_bound', last_attempt: null }),
    );
    expect(bound?.lines[0]).toContain(
      'the platform has rebased 3 times since this task reached Ready',
    );
  });

  it('says a refusal with what, why and next', () => {
    const said = mergeStatusLines(
      detailWith({
        by: 'platform',
        waiting_for: null,
        last_attempt: {
          ...ATTEMPT,
          outcome: 'refused',
          provider_status: 'head_moved',
          merge_commit_sha: null,
        },
      }),
    );
    expect(said?.tone).toBe('warning');
    expect(said?.lines[0]).toBe(
      'The platform’s merge was refused: GitLab said the branch moved (409) — merge it yourself or Send back.',
    );
  });

  it.each([
    ['approved_by_person', 'Jana Nováková', 'plan approved by Jana Nováková'],
    ['approved_by_platform', null, 'plan approved by the platform as low-risk'],
    ['not_required', null, 'no plan approval required'],
  ] as const)('says the merge, its commit and the plan decision %s', (decision, by, words) => {
    const view = render(
      <MergeStatusNotice
        detail={detailWith(
          {
            by: 'platform',
            waiting_for: null,
            last_attempt: {
              ...ATTEMPT,
              outcome: 'merged',
              plan_decision: decision,
              plan_approved_by: by,
            },
          },
          'merged',
        )}
      />,
    );
    const text = view.container.querySelector('[data-merge-status]')?.textContent ?? '';
    expect(text).toMatch(/^Merged by the platform at .+, commit abc1234 — /);
    expect(text).toContain(words);
    // No raw enum on screen.
    expect(view.container.textContent).not.toMatch(/approved_by_|not_required|head_moved/);
  });

  it('draws nothing when the read has no merge block', () => {
    const view = render(<MergeStatusNotice detail={detailWith(null)} />);
    expect(view.container.querySelector('[data-testid="merge-status"]')).toBeNull();
  });
});
