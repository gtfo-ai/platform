/**
 * S-28.15 (TD-038 decisions 2–3, amended by the M28 ruling of 2026-11-10): who merges, and what
 * stops the platform's merge at the moment of merging. Every guard here is a dangerous negative —
 * removing one makes the platform merge into a team's default branch when it must not.
 */
import type { TicketLifecycle, TicketStatusCategory } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ticketStatusPolicyOf } from '../lifecycle/status-disposition.js';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type ChangeDigestFile,
  changeDigest,
  changeDigestWithContext,
  classifyMovedHead,
  freshTicketAtMerge,
  MERGE_BY_PERSON_REASONS,
  type MergeByInput,
  MOVED_HEAD_WAITS,
  mergeByPersonReasons,
  PLATFORM_MERGE_WAITS,
  type PlatformMergeFacts,
  platformMergeWait,
  REBASE_ONLY_WAITS,
} from './merge.js';

const PLATFORM: MergeByInput = { setting: 'platform', providerCanMerge: true, shadow: false };

describe('mergeByPersonReasons (TD-038 decision 2)', () => {
  it('is empty only with the setting at platform, a provider that can merge and no shadow', () => {
    expect(mergeByPersonReasons(PLATFORM)).toEqual([]);
  });

  it('keeps a person merging when the setting is person or absent (the default)', () => {
    expect(mergeByPersonReasons({ ...PLATFORM, setting: 'person' })).toEqual(['setting_person']);
    expect(mergeByPersonReasons({ ...PLATFORM, setting: undefined })).toEqual(['setting_person']);
  });

  it('keeps a person merging for a provider without the capability and for shadow mode', () => {
    expect(mergeByPersonReasons({ ...PLATFORM, providerCanMerge: false })).toEqual([
      'provider_cannot_merge',
    ]);
    expect(mergeByPersonReasons({ ...PLATFORM, shadow: true })).toEqual(['shadow_mode']);
  });

  it('has no probation or risk-class reason — the plan decision is the human checkpoint', () => {
    expect(MERGE_BY_PERSON_REASONS).toEqual([
      'setting_person',
      'provider_cannot_merge',
      'shadow_mode',
    ]);
  });

  it(
    'names every reason that holds, in the fixed order, and is empty exactly when none does',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom('person', 'platform', undefined),
          fc.boolean(),
          fc.boolean(),
          (setting, providerCanMerge, shadow) => {
            const reasons = mergeByPersonReasons({ setting, providerCanMerge, shadow });
            const order = reasons.map((reason) => MERGE_BY_PERSON_REASONS.indexOf(reason));
            expect([...order].sort((a, b) => a - b)).toEqual(order);
            expect(reasons.length === 0).toBe(
              setting === 'platform' && providerCanMerge && !shadow,
            );
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

const HEAD = 'a'.repeat(40);

const READY: PlatformMergeFacts = {
  atReady: true,
  paused: false,
  personWordsPending: false,
  latestVerdict: 'approve',
  plan: 'approved_by_person',
  ticket: 'open',
  mergeRequest: {
    state: 'opened',
    draft: false,
    mergeable: true,
    blocked: false,
    headSha: HEAD,
    optionsKnown: true,
  },
  readyHeadSha: HEAD,
  ciHeadSha: HEAD,
  hasCiGate: true,
};

describe('platformMergeWait (TD-038 decision 3)', () => {
  it('lets the merge go ahead only when every item holds', () => {
    expect(platformMergeWait(READY)).toBeNull();
  });

  it.each<[string, Partial<PlatformMergeFacts>, string]>([
    ['not at Ready', { atReady: false }, 'not_at_ready'],
    ['paused', { paused: true }, 'not_at_ready'],
    ['a person’s words younger than the window', { personWordsPending: true }, 'person_words'],
    [
      'the latest verdict asks for changes',
      { latestVerdict: 'request_changes' },
      'review_not_approved',
    ],
    ['no verdict at all', { latestVerdict: null }, 'review_not_approved'],
    ['a plan approval neither approved nor absent', { plan: null }, 'plan_not_decided'],
    ['the ticket closed', { ticket: 'closed' }, 'ticket_closed'],
    ['the ticket taken by a person', { ticket: 'hands_off' }, 'ticket_hands_off'],
    ['the ticket not at a QA-passed status', { qaPassed: false }, 'ticket_not_qa_passed'],
    [
      'a qa-stage task whose tracker lifecycle cannot be judged (review of #206)',
      { ticket: null, lifecycleUnknown: true },
      'ticket_lifecycle_unknown',
    ],
    [
      'the ticket at a person’s status QA has not passed',
      { ticket: 'hands_off', qaPassed: false },
      'ticket_not_qa_passed',
    ],
    ['the ticket unread', { ticket: 'unread' }, 'ticket_unread'],
    [
      'the merge request closed',
      { mergeRequest: { ...READY.mergeRequest, state: 'closed' } },
      'merge_request_not_open',
    ],
    [
      'the merge request a draft',
      { mergeRequest: { ...READY.mergeRequest, draft: true } },
      'provider_blocked',
    ],
    [
      'a provider blocker',
      { mergeRequest: { ...READY.mergeRequest, blocked: true } },
      'provider_blocked',
    ],
    [
      'mergeable false',
      { mergeRequest: { ...READY.mergeRequest, mergeable: false } },
      'provider_blocked',
    ],
    [
      'mergeable not decided',
      { mergeRequest: { ...READY.mergeRequest, mergeable: null } },
      'provider_blocked',
    ],
    [
      'the head moved since the review',
      { mergeRequest: { ...READY.mergeRequest, headSha: 'b'.repeat(40) } },
      'head_moved',
    ],
    [
      'the repository’s merge settings unknown',
      { mergeRequest: { ...READY.mergeRequest, optionsKnown: false } },
      'merge_settings_unknown',
    ],
    // S-28.18 (BACKLOG 1616): no recorded head is not a moved branch, and is not worded as one.
    ['no reviewed head recorded', { readyHeadSha: null }, 'head_not_recorded'],
    ['the reviewed head is not the CI-gated one', { ciHeadSha: 'c'.repeat(40) }, 'head_moved'],
  ])('waits when %s', (_name, change, wait) => {
    expect(platformMergeWait({ ...READY, ...change })).toBe(wait);
  });

  it('merges on every plan decision: a person’s approval, the platform’s low-risk one, none required', () => {
    for (const plan of ['approved_by_person', 'approved_by_platform', 'not_required'] as const) {
      expect(platformMergeWait({ ...READY, plan })).toBeNull();
    }
  });

  it('answers needs_rebase only when a rebase is the provider’s one obstacle and everything else holds', () => {
    const rebase = { ...READY.mergeRequest, blocked: true, mergeable: false, rebaseOnly: true };
    expect(platformMergeWait({ ...READY, mergeRequest: rebase })).toBe('needs_rebase');
    // Every other item still decides first: a moved head, a person's words, a draft.
    expect(
      platformMergeWait({ ...READY, mergeRequest: { ...rebase, headSha: 'b'.repeat(40) } }),
    ).toBe('head_moved');
    expect(platformMergeWait({ ...READY, personWordsPending: true, mergeRequest: rebase })).toBe(
      'person_words',
    );
    expect(platformMergeWait({ ...READY, mergeRequest: { ...rebase, draft: true } })).toBe(
      'provider_blocked',
    );
  });

  it('does not ask for a CI head on a pipeline without a CI gate', () => {
    expect(platformMergeWait({ ...READY, hasCiGate: false, ciHeadSha: null })).toBeNull();
  });

  it('a ticket the project does not judge stops nothing', () => {
    expect(platformMergeWait({ ...READY, ticket: null })).toBeNull();
  });

  it('names every wait it can answer in PLATFORM_MERGE_WAITS, in its order', () => {
    expect(new Set(PLATFORM_MERGE_WAITS).size).toBe(PLATFORM_MERGE_WAITS.length);
    expect(PLATFORM_MERGE_WAITS).toContain('ticket_not_qa_passed');
    expect(PLATFORM_MERGE_WAITS.indexOf('ticket_not_qa_passed')).toBeLessThan(
      PLATFORM_MERGE_WAITS.indexOf('ticket_hands_off'),
    );
  });
});

/**
 * S-28.24 — TD-029 amendment G decision 4, TD-038 amendment D: *"Releasable can merge, nothing
 * else."* The owner's flow with invented names: `qa` CR accepted, Testing (no slot, In Progress
 * category), Releasable (`done`), and a second accepting status that is no slot at all.
 */
describe('the merge asks QA again: qa_pass (TD-029 amendment G)', () => {
  const LIFECYCLE: TicketLifecycle = {
    in_progress: 'In progress',
    qa: 'CR accepted',
    ready_for_merge: 'Mergeable',
    returned: ['To do'],
    done: 'Releasable',
    qa_pass: ['Releasable', 'Accepted by QA'],
  };
  const POLICY = ticketStatusPolicyOf(null, LIFECYCLE);
  const waitAt = (
    status: string,
    category: TicketStatusCategory | null,
    overrides: { lifecycle?: TicketLifecycle; qaStage?: boolean } = {},
  ) => {
    const lifecycle = overrides.lifecycle ?? LIFECYCLE;
    const fresh = freshTicketAtMerge({
      status,
      category,
      policy: ticketStatusPolicyOf(null, lifecycle),
      lifecycle,
      qaStage: overrides.qaStage ?? true,
    });
    return platformMergeWait({ ...READY, ...fresh });
  };

  it.each<[string, TicketStatusCategory | null]>([
    ['Testing', 'in_progress'],
    ['CR accepted', 'in_progress'],
    ['Blocked', 'todo'],
    ['Somewhere', null],
  ])('waits with ticket_not_qa_passed at %s (%s)', (status, category) => {
    expect(waitAt(status, category)).toBe('ticket_not_qa_passed');
  });

  it.each<[string, TicketStatusCategory | null]>([
    // A qa_pass name that is also `done`.
    ['Releasable', 'done'],
    // A qa_pass name that is no slot, in the In Progress category — today it reads hands-off.
    ['accepted by qa', 'in_progress'],
    // The `ready_for_merge` slot: the platform writes it itself after QA's pass.
    ['Mergeable', 'in_progress'],
  ])('merges at %s (%s)', (status, category) => {
    expect(waitAt(status, category)).toBeNull();
  });

  it('a closed status is still ticket_closed, before the QA item', () => {
    const lifecycle = { ...LIFECYCLE, closed: ['Done'] };
    expect(waitAt('Done', 'done', { lifecycle })).toBe('ticket_closed');
  });

  it('changes nothing for a task with no qa stage, or a binding with no qa_pass', () => {
    const { qa_pass: _list, ...withoutList } = LIFECYCLE;
    // Testing is a person's In Progress status: hands-off, exactly as before S-28.24.
    expect(waitAt('Testing', 'in_progress', { qaStage: false })).toBe('ticket_hands_off');
    expect(waitAt('Testing', 'in_progress', { lifecycle: withoutList })).toBe('ticket_hands_off');
    expect(waitAt('Accepted by QA', 'in_progress', { qaStage: false })).toBe('ticket_hands_off');
    expect(waitAt('Blocked', 'todo', { lifecycle: withoutList })).toBeNull();
    expect(
      freshTicketAtMerge({
        status: 'Testing',
        category: 'in_progress',
        policy: POLICY,
        lifecycle: withoutList,
        qaStage: true,
      }).qaPassed,
    ).toBeNull();
  });
});

describe('changeDigest (TD-038 amendment A)', () => {
  const file = (diff: string, path = 'src/a.ts'): ChangeDigestFile => ({
    oldPath: path,
    newPath: path,
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    diff,
    omitted: false,
  });
  const PATCH =
    '@@ -10,3 +10,3 @@ function a() {\n const x = 1;\n-const y = 2;\n+const y = 3;\n return x;';

  it('keeps the digest when only the hunk position and the context change', () => {
    const moved =
      '@@ -40,3 +40,3 @@ function b() {\n const other = 0;\n-const y = 2;\n+const y = 3;\n return other;';
    expect(changeDigest([file(PATCH)], false)).toBe(changeDigest([file(moved)], false));
    expect(changeDigest([file(PATCH)], false)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the digest when any added or removed line changes', () => {
    const other = PATCH.replace('+const y = 3;', '+const y = 4;');
    expect(changeDigest([file(PATCH)], false)).not.toBe(changeDigest([file(other)], false));
  });

  it('is independent of the order the provider listed the files in', () => {
    const a = file(PATCH, 'a.ts');
    const b = file('@@ -1 +1 @@\n-x\n+y', 'b.ts');
    expect(changeDigest([a, b], false)).toBe(changeDigest([b, a], false));
  });

  it('gives no digest for a file whose change has no added or removed line (binary edit, mode change)', () => {
    expect(changeDigest([file('Binary files a/logo.png and b/logo.png differ')], false)).toBeNull();
    expect(changeDigest([{ ...file(''), oldMode: '100644', newMode: '100755' }], false)).toBeNull();
    // A pure rename with no patch is a change the paths show.
    expect(
      changeDigest(
        [{ ...file(''), oldPath: 'a.ts', newPath: 'b.ts', renamedFile: true, diff: null }],
        false,
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives no digest for a rename whose patch is not empty but has no added or removed line, nor for any binary patch', () => {
    expect(
      changeDigest(
        [
          {
            ...file('@@ -1 +1 @@\n context only'),
            oldPath: 'a.ts',
            newPath: 'b.ts',
            renamedFile: true,
          },
        ],
        false,
      ),
    ).toBeNull();
    // A binary line beside real lines still gives none.
    expect(
      changeDigest([file(`${PATCH}\nBinary files a/x.bin and b/x.bin differ`)], false),
    ).toBeNull();
  });

  it('moves the digest with a mode change or a rename beside the same lines', () => {
    const base = changeDigest([file(PATCH)], false);
    expect(
      changeDigest([{ ...file(PATCH), oldMode: '100644', newMode: '100755' }], false),
    ).not.toBe(base);
    expect(
      changeDigest([{ ...file(PATCH), oldPath: 'src/old.ts', renamedFile: true }], false),
    ).not.toBe(base);
  });

  it('gives no digest for a cut list, an omitted patch, a missing patch or no files', () => {
    expect(changeDigest([file(PATCH)], true)).toBeNull();
    expect(changeDigest([{ ...file(PATCH), omitted: true }], false)).toBeNull();
    expect(changeDigest([{ ...file(PATCH), diff: null }], false)).toBeNull();
    expect(changeDigest([], false)).toBeNull();
  });

  it(
    'any added or removed line changes it; any context or position change keeps it',
    () => {
      const line = fc.string({ maxLength: 20 }).filter((text) => !text.includes('\n'));
      fc.assert(
        fc.property(
          fc.array(line, { minLength: 1, maxLength: 5 }),
          fc.array(line, { maxLength: 5 }),
          fc.nat(500),
          line,
          (added, context, start, extra) => {
            const patchOf = (lines: readonly string[], at: number, around: readonly string[]) =>
              [
                `@@ -${at},1 +${at},1 @@`,
                ...around.map((c) => ` ${c}`),
                ...lines.map((l) => `+${l}`),
              ].join('\n');
            const base = changeDigest([file(patchOf(added, 1, []))], false);
            expect(changeDigest([file(patchOf(added, start + 1, context))], false)).toBe(base);
            expect(changeDigest([file(patchOf([...added, extra], 1, []))], false)).not.toBe(base);
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

/**
 * TD-038 Amendment C (the owner's ruling of 2026-11-20): a head at Ready that is not the reviewed
 * one is classified by the change digest, never just refused. Only an identical digest is a rebase;
 * every other answer is a person's, and each says which.
 */
describe('classifyMovedHead (TD-038 Amendment C)', () => {
  const DIGEST = 'a'.repeat(64);

  it('is a rebase only when the reviewed version exists and both digests are identical', () => {
    expect(
      classifyMovedHead({ reviewedVersionFound: true, reviewedDigest: DIGEST, liveDigest: DIGEST }),
    ).toBe('rebase');
  });

  it.each<[string, Parameters<typeof classifyMovedHead>[0], string]>([
    [
      'the digests differ (new changes)',
      { reviewedVersionFound: true, reviewedDigest: DIGEST, liveDigest: 'b'.repeat(64) },
      'head_changed',
    ],
    [
      'no version has the reviewed head',
      { reviewedVersionFound: false, reviewedDigest: null, liveDigest: DIGEST },
      'head_version_missing',
    ],
    [
      // Defensive: a digest without a version is not trusted as one.
      'no version, whatever digest a caller passes',
      { reviewedVersionFound: false, reviewedDigest: DIGEST, liveDigest: DIGEST },
      'head_version_missing',
    ],
    [
      'the reviewed version gives no digest (cut or unrendered)',
      { reviewedVersionFound: true, reviewedDigest: null, liveDigest: DIGEST },
      'head_change_unknown',
    ],
    [
      'the live diff gives no digest',
      { reviewedVersionFound: true, reviewedDigest: DIGEST, liveDigest: null },
      'head_change_unknown',
    ],
    [
      // Two `null`s are not equal changes: nothing is known about either.
      'neither side gives a digest',
      { reviewedVersionFound: true, reviewedDigest: null, liveDigest: null },
      'head_change_unknown',
    ],
  ])('is not a rebase when %s', (_name, facts, wait) => {
    expect(classifyMovedHead(facts)).toBe(wait);
  });

  it('names only rebase states as rebase-only, so Send back is offered for every other wait', () => {
    expect([...REBASE_ONLY_WAITS].sort()).toEqual(
      ['head_rebase_bound', 'head_rebased_ci_failed', 'head_rebased_ci_pending'].sort(),
    );
    for (const wait of ['head_changed', 'head_version_missing', 'head_change_unknown']) {
      expect(MOVED_HEAD_WAITS).toContain(wait);
      expect(REBASE_ONLY_WAITS.has(wait)).toBe(false);
    }
  });
});

/**
 * Review of #177 (TD-038 Amendment C): a person's rebase is judged by the context-keeping identity.
 * GitLab's own rebase fails on a conflict, so amendment A may ignore where the lines sit; a local
 * rebase can move the same added line into another function.
 */
describe('changeDigestWithContext (TD-038 Amendment C)', () => {
  const file = (diff: string): ChangeDigestFile => ({
    oldPath: 'src/auth.ts',
    newPath: 'src/auth.ts',
    newFile: false,
    deletedFile: false,
    renamedFile: false,
    diff,
    omitted: false,
  });
  const GUARDED =
    '@@ -10,3 +10,4 @@ export const deletePost = () => {\n const user = current();\n+if (!authorized) return;\n remove(post);';

  it('keeps the digest when only the hunk’s line numbers move (a clean rebase)', () => {
    const shifted =
      '@@ -42,3 +45,4 @@ export const deletePost = () => {\n const user = current();\n+if (!authorized) return;\n remove(post);';
    expect(changeDigestWithContext([file(GUARDED)], false)).toBe(
      changeDigestWithContext([file(shifted)], false),
    );
    expect(changeDigestWithContext([file(GUARDED)], false)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the same added line sits under different context — amendment A’s digest does not', () => {
    const moved =
      '@@ -80,3 +80,4 @@ export const readPost = () => {\n const post = load();\n+if (!authorized) return;\n render(post);';
    expect(changeDigestWithContext([file(moved)], false)).not.toBe(
      changeDigestWithContext([file(GUARDED)], false),
    );
    // The reason the stricter identity exists: the +/- lines alone are equal.
    expect(changeDigest([file(moved)], false)).toBe(changeDigest([file(GUARDED)], false));
  });

  it('gives no digest wherever amendment A’s gives none', () => {
    expect(changeDigestWithContext([], false)).toBeNull();
    expect(changeDigestWithContext([file(GUARDED)], true)).toBeNull();
    expect(changeDigestWithContext([{ ...file(GUARDED), omitted: true }], false)).toBeNull();
  });
});
