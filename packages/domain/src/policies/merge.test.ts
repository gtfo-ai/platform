/**
 * S-28.15 (TD-038 decisions 2–3, amended by the M28 ruling of 2026-11-10): who merges, and what
 * stops the platform's merge at the moment of merging. Every guard here is a dangerous negative —
 * removing one makes the platform merge into a team's default branch when it must not.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type ChangeDigestFile,
  changeDigest,
  MERGE_BY_PERSON_REASONS,
  type MergeByInput,
  mergeByPersonReasons,
  type PlatformMergeFacts,
  platformMergeWait,
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
    ['no reviewed head recorded', { readyHeadSha: null }, 'head_moved'],
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
