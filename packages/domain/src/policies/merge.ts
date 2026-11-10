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
import type { MergeBy } from '@platform/contracts';
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
 *  - `merge_request_not_open` — merged, closed or locked; `provider_blocked` — draft, a provider
 *    blocker, or `mergeable` not `true` (S-28.13's read: pipeline, conflicts, threads, approvals);
 *  - `merge_settings_unknown` — the provider did not say whether a merge squashes or removes the
 *    branch, so the platform cannot pass the repository's own settings back (TD-038 decision 4);
 *  - `head_moved` — the merge request's head is not `tasks.ready_head_sha`, or (on a pipeline with a
 *    CI gate) that is not `tasks.ci_head_sha`, or no head was recorded;
 *  - `needs_rebase` — every item above holds and the provider's only obstacle is a rebase
 *    (TD-038 amendment A): the duty may ask the provider to rebase.
 */
export type PlatformMergeWait =
  | 'not_at_ready'
  | 'person_words'
  | 'review_not_approved'
  | 'plan_not_decided'
  | 'ticket_closed'
  | 'ticket_hands_off'
  | 'ticket_unread'
  | 'merge_request_not_open'
  | 'provider_blocked'
  | 'merge_settings_unknown'
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
  if (
    facts.readyHeadSha === null ||
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
    const lines = (patch ?? '')
      .split('\n')
      // GitLab's `diff` carries hunks only (no `---`/`+++` file header lines), so every line that
      // opens with `+` or `-` is an added or a removed line; `@@` headers and context are dropped.
      .filter((line) => line.startsWith('+') || line.startsWith('-'));
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
        lines,
      ]),
    );
  }
  return sha256Hex(parts.join('\n'));
};
