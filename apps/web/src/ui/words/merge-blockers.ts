/**
 * **Why the provider will not merge a merge request yet, in plain words** (S-28.13, M28 ruling R3b
 * (3)). The task read's `merge_request_blocked` row carries the port's reason (`reason_code`) and
 * the provider's own word (`observed`, GitLab's `detailed_merge_status`); neither reaches the
 * screen raw. A reason the port names has its own sentence and next step; for `other`, the
 * provider's word is looked up here, and one this map does not know is named in plain words
 * (underscores read as spaces), never as an enum.
 */

/** The why, mid-sentence after *"<Provider> will not merge this yet: "*. */
const REASON_WHY: Readonly<Record<string, (threads: number | null) => string>> = {
  unresolved_threads: (threads) =>
    threads === null || threads === 0
      ? 'some of its threads are unresolved'
      : threads === 1
        ? '1 thread is unresolved'
        : `${threads} threads are unresolved`,
  conflict: () => 'its branch conflicts with the target branch',
  pipeline: () => 'its pipeline has not passed yet',
  approvals: () => 'it still needs approval from a reviewer',
  draft: () => 'it is marked as a draft',
  rebase: () => 'its branch must be rebased onto the target branch first',
};

/** What the person does next, for each reason. */
const REASON_NEXT: Readonly<Record<string, string>> = {
  unresolved_threads:
    'Resolve them on the merge request — or write in one to send the task back to the agent with that change.',
  conflict:
    'Resolve the conflict on the merge request, or hand the task back so the agent resolves it.',
  pipeline: 'Open the merge request to see the pipeline; the platform checks again once it passes.',
  approvals: 'Ask a reviewer to approve it on the merge request.',
  draft: 'Mark it ready on the merge request.',
  rebase: 'Rebase it on the merge request (its Rebase button), or hand the task back.',
};

/** GitLab's other blocking words (`detailed_merge_status`), as a reason mid-sentence. */
const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  not_open: 'it is not open',
  merge_request_blocked: 'another merge request it depends on is not merged yet',
  jira_association_missing: 'its title or description must name a Jira issue',
  locked_paths: 'it changes paths another person has locked',
  locked_lfs_files: 'it changes large files another person has locked',
  merge_time: 'it may only be merged after a set time',
  security_policy_violations: 'a security policy blocks it',
  title_regex: 'its title does not match the project’s rule for titles',
  commits_status: 'its source branch is missing or has no commits',
};

/** The why for a row: the port's reason, or the provider's word through {@link PROVIDER_WORDS}. */
export const mergeBlockedWhy = (
  reason: string | null,
  providerStatus: string | null,
  threads: number | null,
): string => {
  const known = reason === null ? undefined : REASON_WHY[reason];
  if (known !== undefined) return known(threads);
  if (providerStatus !== null && Object.hasOwn(PROVIDER_WORDS, providerStatus)) {
    return PROVIDER_WORDS[providerStatus] as string;
  }
  return providerStatus === null
    ? 'for a reason it did not name'
    : `for a reason the platform has no words for (it says “${providerStatus.replaceAll('_', ' ')}”)`;
};

/** The next step for a row; a generic one for a reason without its own. */
export const mergeBlockedNext = (reason: string | null): string =>
  (reason === null ? undefined : REASON_NEXT[reason]) ??
  'Open the merge request to see what it is waiting for; the platform checks again and this clears itself once it can be merged.';
