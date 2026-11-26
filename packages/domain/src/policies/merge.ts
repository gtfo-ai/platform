/**
 * **Who merges a task's merge request at Ready, and whether the platform may merge it now**
 * (S-28.15, BD-007's 2026-11-10 amendment, TD-038 decisions 2–3 as amended by the M28 ruling of
 * 2026-11-10: *"the merge decision once approved or does not need the approval because platform
 * decided it is safe then platform merge"*).
 *
 * Two pure pieces, in the order the `platform_merge` duty asks them:
 *
 *  1. {@link mergeByPersonReasons} — why a **person** merges this task, every reason in a fixed
 *     order (the shape of `planApprovalReasons`). Empty means the platform merges. The plan
 *     approval is the human checkpoint: probation and risk classes are decided **there** (the plan
 *     gate asks a person for both), so neither holds the merge again — a plan a person approved, or
 *     one the platform's low-risk rule let through, or one that needed no approval, is the decision
 *     the merge rests on ({@link MergePlanDecision}).
 *  2. {@link platformMergeWait} — the fresh check (TD-038 decision 3): what, read at the moment
 *     of merging, still stops the platform, or `null` when every item holds. A failing item is a
 *     reason on the page, never an attempt.
 *
 * Neither reads anything: the duty reads the task, the verdict, the merge request and the ticket
 * outside every transaction and hands the facts here.
 */
import {
  lifecycleStatusKey,
  type MergeBy,
  type TicketLifecycle,
  type TicketStatusCategory,
} from '@platform/contracts';
import {
  type TicketStatusPolicy,
  ticketStatusDisposition,
} from '../lifecycle/status-disposition.js';
import { sha256Hex } from '../prompt/sha256.js';

/** Why a person merges this task — TD-038 decision 2 (no probation, no risk class). */
export type MergeByPersonReason =
  /** `policies.merge.by` is `person` (the default). */
  | 'setting_person'
  /** The git provider cannot merge through the platform (capability `merge: false`). */
  | 'provider_cannot_merge'
  /** A shadow task, or a project in shadow mode: nothing is written to the provider. */
  | 'shadow_mode';

/** The fixed order of {@link MergeByPersonReason}. */
export const MERGE_BY_PERSON_REASONS = [
  'setting_person',
  'provider_cannot_merge',
  'shadow_mode',
] as const satisfies readonly MergeByPersonReason[];

/**
 * The plan decision a merge rests on (TD-038 decision 2), read from the task's latest plan
 * approval: approved by a person, approved by the platform as low-risk (TD-037's
 * `auto_decided`), or no approval was required (none was asked, or the template has no plan
 * stage). A plan still waiting or rejected never reaches Ready.
 */
export type MergePlanDecision = 'approved_by_person' | 'approved_by_platform' | 'not_required';

export interface MergeByInput {
  /** The project's effective `policies.merge.by`; absent is `person`. */
  readonly setting: MergeBy | undefined;
  /** The git binding's capability `merge`. */
  readonly providerCanMerge: boolean;
  /** The task is a shadow task, or the project's dial is in shadow mode. */
  readonly shadow: boolean;
}

/**
 * Why a person merges this task, every reason in {@link MERGE_BY_PERSON_REASONS} order. Probation
 * and risk classes add none: they force a person's **plan** approval, which is the human
 * checkpoint the merge rests on (the owner's ruling in TD-038 decision 2).
 */
export const mergeByPersonReasons = (input: MergeByInput): readonly MergeByPersonReason[] => {
  const reasons: MergeByPersonReason[] = [];
  if ((input.setting ?? 'person') !== 'platform') {
    reasons.push('setting_person');
  }
  if (!input.providerCanMerge) {
    reasons.push('provider_cannot_merge');
  }
  if (input.shadow) {
    reasons.push('shadow_mode');
  }
  return reasons;
};

/**
 * What still stops the platform at the moment of merging (TD-038 decision 3), the first failing
 * item in this order:
 *
 *  - `not_at_ready` — the task is not at `ready_for_merge`, or is paused;
 *  - `person_words` — a human-return window is open, or a person wrote on the merge request or the
 *    ticket more recently than the window (TD-029 amendment A): the platform waits for the window;
 *  - `review_not_approved` — the task's latest review verdict does not approve (or there is none);
 *  - `plan_not_decided` — the latest plan approval is neither approved nor absent (fail closed: a
 *    plan still waiting or rejected never reaches Ready, so this is a defect said, not a merge);
 *  - `ticket_closed` / `ticket_hands_off` — the ticket's fresh status (TD-029 B/E); `ticket_unread`
 *    when a bound ticket could not be read (fail closed);
 *  - `ticket_not_qa_passed` — between the two (TD-029 amendment G, TD-038 amendment D, S-28.24): a
 *    task with a `qa` stage whose binding sets `qa_pass`, and whose ticket's fresh status is neither
 *    in that list nor the `ready_for_merge` slot's ({@link freshTicketAtMerge}). It precedes
 *    `ticket_hands_off` because a testing status is usually In Progress, and *QA has not passed*
 *    is the truer sentence there;
 *  - `merge_request_not_open` — merged, closed or locked; `provider_blocked` — draft, a provider
 *    blocker, or `mergeable` not `true` (S-28.13's read: pipeline, conflicts, threads, approvals);
 *  - `merge_settings_unknown` — the provider did not say whether a merge squashes or removes the
 *    branch, so the platform cannot pass the repository's own settings back (TD-038 decision 4);
 *  - `head_not_recorded` — no reviewed head was recorded at the task's Ready entry
 *    (`tasks.ready_head_sha` is `null`), so there is nothing to compare the merge request's head
 *    with. Its own code since S-28.18 (BACKLOG 1616): until then it read `head_moved`, and the page
 *    said "the branch moved" for tasks nobody had pushed to — every task that passed QA. QA's pass
 *    now records the head the gates judged and the `ready_merge_check` duty records it once for a
 *    task that passed QA before, so on a shipped template this is defensive; a custom template
 *    with no CI gate still reaches it, and a person merges;
 *  - `head_moved` — the merge request's head is not `tasks.ready_head_sha`, or (on a pipeline with a
 *    CI gate) that is not `tasks.ci_head_sha`;
 *  - `needs_rebase` — every item above holds and the provider's only obstacle is a rebase
 *    (TD-038 amendment A): the duty may ask the provider to rebase.
 */
export type PlatformMergeWait =
  | 'not_at_ready'
  | 'person_words'
  | 'review_not_approved'
  | 'plan_not_decided'
  | 'ticket_closed'
  | 'ticket_not_qa_passed'
  | 'ticket_hands_off'
  | 'ticket_unread'
  | 'merge_request_not_open'
  | 'provider_blocked'
  | 'merge_settings_unknown'
  | 'head_not_recorded'
  | 'head_moved'
  | 'needs_rebase';

export interface PlatformMergeFacts {
  readonly atReady: boolean;
  readonly paused: boolean;
  readonly personWordsPending: boolean;
  /** The latest `ReviewVerdict`'s `verdict`, or `null` when the task has none that parses. */
  readonly latestVerdict: string | null;
  /** The plan decision, or `null` when the latest plan approval is neither approved nor absent. */
  readonly plan: MergePlanDecision | null;
  /** The ticket's fresh disposition: `null` when the project judges no ticket status. */
  readonly ticket: 'open' | 'closed' | 'hands_off' | 'unread' | null;
  /**
   * Whether the ticket's fresh status passes QA (TD-029 amendment G): `null` when the item does not
   * apply — no `qa` stage, no `qa_pass`, or no status read. Absent is `null`.
   */
  readonly qaPassed?: boolean | null;
  readonly mergeRequest: {
    readonly state: 'opened' | 'merged' | 'closed' | 'locked';
    readonly draft: boolean;
    readonly mergeable: boolean | null | undefined;
    readonly blocked: boolean;
    readonly headSha: string;
    /** The provider said whether a merge squashes and removes the branch. */
    readonly optionsKnown: boolean;
    /** The provider's only blocker is that the merge request must be rebased (amendment A). */
    readonly rebaseOnly?: boolean;
  };
  readonly readyHeadSha: string | null;
  /** `null` on a pipeline without a CI gate; otherwise `tasks.ci_head_sha` (possibly `null`). */
  readonly ciHeadSha: string | null | undefined;
  readonly hasCiGate: boolean;
}

/** Every {@link PlatformMergeWait}, in the order {@link platformMergeWait} asks them. */
export const PLATFORM_MERGE_WAITS = [
  'not_at_ready',
  'person_words',
  'review_not_approved',
  'plan_not_decided',
  'ticket_closed',
  'ticket_not_qa_passed',
  'ticket_hands_off',
  'ticket_unread',
  'merge_request_not_open',
  'provider_blocked',
  'merge_settings_unknown',
  'head_not_recorded',
  'head_moved',
  'needs_rebase',
] as const satisfies readonly PlatformMergeWait[];

// The list is the whole union: a wait added to the type and not here fails the typecheck.
export type UnlistedPlatformMergeWait = Exclude<
  PlatformMergeWait,
  (typeof PLATFORM_MERGE_WAITS)[number]
>;
const everyWaitListed: [UnlistedPlatformMergeWait] extends [never] ? true : never = true;
void everyWaitListed;

/**
 * **The ticket's fresh status, as the merge reads it** (TD-038 decision 3, TD-029 amendment G
 * decision 4). The disposition is today's — the platform holds the ticket, so its own statuses read
 * `open`, a closed status `closed`, a person's In Progress status `hands_off` — with one change for
 * a task whose frozen `qa_stage` is true and whose binding (read live) sets `qa_pass`: a status in
 * the list reads `open` even when it is no slot, and `qaPassed` says whether the status is in the
 * list or is the `ready_for_merge` slot's — the platform writes that one itself after QA's pass, so
 * a binding mapping both would otherwise wait for ever on its own write. Otherwise `qaPassed` is
 * `null` and nothing about the merge changes.
 */
export const freshTicketAtMerge = (input: {
  readonly status: string;
  readonly category: TicketStatusCategory | null;
  readonly policy: TicketStatusPolicy;
  readonly lifecycle: TicketLifecycle | null | undefined;
  readonly qaStage: boolean;
}): { readonly ticket: 'open' | 'closed' | 'hands_off'; readonly qaPassed: boolean | null } => {
  const key = lifecycleStatusKey(input.status);
  const list = input.qaStage ? input.lifecycle?.qa_pass : undefined;
  const listed = list?.some((name) => lifecycleStatusKey(name) === key) === true;
  const ready = input.lifecycle?.ready_for_merge;
  const qaPassed =
    list === undefined
      ? null
      : listed || (ready !== undefined && lifecycleStatusKey(ready) === key);
  if (listed) {
    return { ticket: 'open', qaPassed };
  }
  const disposition = ticketStatusDisposition(input.status, input.category, input.policy, true);
  return {
    ticket: disposition === 'closed' || disposition === 'hands_off' ? disposition : 'open',
    qaPassed,
  };
};

/** The first item that stops the platform's merge now, or `null` when every item holds. */
export const platformMergeWait = (facts: PlatformMergeFacts): PlatformMergeWait | null => {
  if (!facts.atReady || facts.paused) {
    return 'not_at_ready';
  }
  if (facts.personWordsPending) {
    return 'person_words';
  }
  if (facts.latestVerdict !== 'approve') {
    return 'review_not_approved';
  }
  if (facts.plan === null) {
    return 'plan_not_decided';
  }
  if (facts.ticket === 'closed') {
    return 'ticket_closed';
  }
  if (facts.qaPassed === false) {
    return 'ticket_not_qa_passed';
  }
  if (facts.ticket === 'hands_off') {
    return 'ticket_hands_off';
  }
  if (facts.ticket === 'unread') {
    return 'ticket_unread';
  }
  const mr = facts.mergeRequest;
  if (mr.state !== 'opened') {
    return 'merge_request_not_open';
  }
  // TD-038 amendment A: a merge request whose only obstacle is a rebase is not "blocked" — every
  // other item is checked first, and the answer is `needs_rebase` only when all of them hold.
  const rebaseOnly = mr.rebaseOnly === true && !mr.draft;
  if (!rebaseOnly && (mr.draft || mr.blocked || mr.mergeable !== true)) {
    return 'provider_blocked';
  }
  if (!mr.optionsKnown) {
    return 'merge_settings_unknown';
  }
  if (facts.readyHeadSha === null) {
    return 'head_not_recorded';
  }
  if (
    mr.headSha !== facts.readyHeadSha ||
    (facts.hasCiGate && facts.ciHeadSha !== facts.readyHeadSha)
  ) {
    return 'head_moved';
  }
  if (rebaseOnly) {
    return 'needs_rebase';
  }
  return null;
};

/**
 * **A head at Ready that is not the reviewed one, classified** (TD-038 Amendment C, the owner's
 * ruling of 2026-11-20: *"just rebasing should not block / reject, and should not restart the whole
 * chain"*). The `platform_merge` duty answers `head_moved` only when it knows nothing more; once it
 * has read the reviewed change back from the provider (the merge request version whose head is
 * `tasks.ready_head_sha`) and the live one, the moved head is one of these:
 *
 *  - `head_rebased_ci_pending` — the change digests are identical: a rebase. The task stays at
 *    Ready and the platform waits for the CI gate's own verdict on the new head;
 *  - `head_rebased_ci_failed` — a rebase, and CI failed on the rebased commit;
 *  - `head_rebase_bound` — a rebase, and the task has already been rebased three times since it
 *    reached Ready (the platform's rebases and a person's count together);
 *  - `head_changed` — the digests differ: new changes nobody reviewed;
 *  - `head_version_missing` — the provider holds no version whose head is the reviewed commit, so
 *    the reviewed change cannot be read back to compare;
 *  - `head_change_unknown` — either side gives no digest (a list the provider cut, a file it
 *    would not render, a binary or mode-only change — `changeDigest`'s `null`).
 *
 * Only the first two are a rebase; the last three never merge and a person decides.
 */
export type MovedHeadWait =
  | 'head_rebased_ci_pending'
  | 'head_rebased_ci_failed'
  | 'head_rebase_bound'
  | 'head_changed'
  | 'head_version_missing'
  | 'head_change_unknown';

/** Every {@link MovedHeadWait}, in the order of the type's docblock. */
export const MOVED_HEAD_WAITS = [
  'head_rebased_ci_pending',
  'head_rebased_ci_failed',
  'head_rebase_bound',
  'head_changed',
  'head_version_missing',
  'head_change_unknown',
] as const satisfies readonly MovedHeadWait[];

/** The waits of a moved head the platform has shown to be a rebase: nothing to review. */
export const REBASE_ONLY_WAITS: ReadonlySet<string> = new Set<MovedHeadWait>([
  'head_rebased_ci_pending',
  'head_rebased_ci_failed',
  'head_rebase_bound',
]);

export interface MovedHeadFacts {
  /** The provider holds a version whose head is the reviewed commit (`tasks.ready_head_sha`). */
  readonly reviewedVersionFound: boolean;
  /** `changeDigest` of that version's diff; `null` when it gives none. */
  readonly reviewedDigest: string | null;
  /** `changeDigest` of the merge request's live diff; `null` when it gives none. */
  readonly liveDigest: string | null;
}

/**
 * Is the moved head a rebase of the reviewed change (`'rebase'`), or which wait says why not
 * (TD-038 Amendment C, decisions 1–3)? The digest is the identity: a person's rebase may squash, so
 * the commit count is not asked (unlike the platform's own rebase, amendment A).
 */
export const classifyMovedHead = (
  facts: MovedHeadFacts,
): 'rebase' | 'head_changed' | 'head_version_missing' | 'head_change_unknown' => {
  if (!facts.reviewedVersionFound) {
    return 'head_version_missing';
  }
  if (facts.reviewedDigest === null || facts.liveDigest === null) {
    return 'head_change_unknown';
  }
  return facts.reviewedDigest === facts.liveDigest ? 'rebase' : 'head_changed';
};

/** One file of a merge request's diff, as the change digest reads it (TD-038 amendment A). */
export interface ChangeDigestFile {
  readonly oldPath: string;
  readonly newPath: string;
  readonly newFile: boolean;
  readonly deletedFile: boolean;
  readonly renamedFile: boolean;
  /** The provider's unified patch text; `null` when it would not give one. */
  readonly diff: string | null | undefined;
  /** The provider has a patch and did not send it (too large, collapsed). */
  readonly omitted: boolean;
  /** The file's mode before and after, when the provider says; part of the digest. */
  readonly oldMode?: string | null;
  readonly newMode?: string | null;
}

/**
 * **The change digest** (TD-038 amendment A, decision 3): SHA-256 over every file sorted by path —
 * old path, new path, the new/deleted/renamed flags, and the ordered added and removed lines, with
 * hunk headers and context lines dropped (the idea of `git patch-id`, which ignores line numbers).
 * Two diffs with the same digest add and remove the same lines in the same files, wherever the
 * hunks sit; a rebase that changed a single added or removed line changes it.
 *
 * `null` — no digest, and a person decides — when the list was cut (`truncated`), a file's patch
 * was omitted or absent (other than a rename or a deletion with no patch), the list is empty, or a
 * file that is neither renamed nor deleted has **no** added or removed line (a binary edit, a mode
 * change, an empty new file: a change the lines cannot show). The paths, the flags and the modes
 * are part of every file's entry, so a rename or a mode change moves the digest. The residual, stated: context lines are ignored, so a rebase over code that changed
 * around the change keeps the digest; the pipeline on the new head judges that.
 */
export const changeDigest = (
  files: readonly ChangeDigestFile[],
  truncated: boolean,
): string | null => digestFiles(files, truncated, false);

/**
 * **The stricter change identity for a person's rebase** (TD-038 Amendment C, review of #177):
 * {@link changeDigest} with the **context lines kept, in order**, and only the hunk headers' line
 * numbers dropped — `git patch-id`'s semantics. A rebase the provider made fails on a conflict, so
 * amendment A's digest may ignore where the lines sit; a person's local rebase can move an added line
 * (`+ if (!authorized) return;`) into another function with the same `+`/`-` lines, which this
 * digest refuses: any changed context is a different change (`head_changed`), failing closed. A
 * rebase over a base that changed code within the hunk's context therefore also reads as changed
 * and a person decides. A hunk header keeps its section text (the enclosing function GitLab names).
 */
export const changeDigestWithContext = (
  files: readonly ChangeDigestFile[],
  truncated: boolean,
): string | null => digestFiles(files, truncated, true);

/** `@@ -12,3 +14,4 @@ fn()` → `@@ fn()`: the hunk's position dropped, its section text kept. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?/;

const digestFiles = (
  files: readonly ChangeDigestFile[],
  truncated: boolean,
  withContext: boolean,
): string | null => {
  if (truncated || files.length === 0) {
    return null;
  }
  const parts: string[] = [];
  const sorted = [...files].sort(
    (a, b) =>
      (a.newPath < b.newPath ? -1 : a.newPath > b.newPath ? 1 : 0) ||
      (a.oldPath < b.oldPath ? -1 : a.oldPath > b.oldPath ? 1 : 0),
  );
  for (const file of sorted) {
    if (file.omitted) {
      return null;
    }
    const patch = file.diff ?? null;
    if (patch !== null && /^Binary files /m.test(patch)) {
      // A binary change has no lines to compare.
      return null;
    }
    if (patch === null && !(file.renamedFile || file.deletedFile)) {
      return null;
    }
    const all = (patch ?? '').split('\n');
    // GitLab's `diff` carries hunks only (no `---`/`+++` file header lines), so every line that
    // opens with `+` or `-` is an added or a removed line; `@@` headers and context are dropped.
    const lines = all.filter((line) => line.startsWith('+') || line.startsWith('-'));
    // The stricter identity keeps every hunk line in order — context (` `), the no-newline marker
    // (`\`) and each hunk header without its line numbers; only a trailing empty line is dropped.
    const kept = withContext
      ? all
          .filter((line) => line !== '')
          .map((line) => (line.startsWith('@@') ? line.replace(HUNK_HEADER, '@@ ') : line))
      : lines;
    // No added or removed line: only a deletion, or a **pure** rename (the patch empty), is a change
    // the paths show; anything else — a binary edit, a mode change, a rename with a hidden edit — is
    // not shown by the lines, so there is no digest.
    const pureRename = file.renamedFile && (patch === null || patch.trim() === '');
    if (lines.length === 0 && !(file.deletedFile || pureRename)) {
      return null;
    }
    parts.push(
      JSON.stringify([
        file.oldPath,
        file.newPath,
        file.newFile,
        file.deletedFile,
        file.renamedFile,
        file.oldMode ?? null,
        file.newMode ?? null,
        kept,
      ]),
    );
  }
  return sha256Hex(parts.join('\n'));
};
