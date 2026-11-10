/**
 * **Who merges, and the platform's merge, in plain words** (S-28.15, TD-038 decision 7 and
 * amendment A). The task read's `merge` block carries platform codes only — who merges, what the
 * platform waits for, the last attempt's outcome and the port's status word — and none of them
 * reaches the screen raw. Each sentence says what happened, why, and what the person does next.
 */

/** Why a person merges, after *"A person merges: "*. */
const PERSON_WHY: Readonly<Record<string, string>> = {
  setting_person:
    'this project’s setting. Merge it on the git provider when it is ready; the project settings’ Who merges lets the platform do it.',
  provider_cannot_merge:
    'the git provider cannot merge through the platform. Merge it on the provider when it is ready.',
  shadow_mode:
    'this is a shadow run, so the platform writes nothing to the git provider. Merge it there yourself if you want it.',
  target_not_default:
    'the merge request targets a branch that is not this project’s default branch, and the platform merges only into the default branch.',
};

/** What the platform's merge waits for, after *"— now: "*. */
const WAITING_NOW: Readonly<Record<string, string>> = {
  person_words:
    'people wrote on the merge request or the ticket a moment ago, and their words are read first',
  review_not_approved: 'the latest review did not approve the change',
  plan_not_decided: 'the plan approval is not decided',
  ticket_closed: 'the ticket was closed, so the merge is left to a person',
  ticket_hands_off: 'a person moved the ticket, so the merge is left to them',
  ticket_unread: 'the ticket could not be read, and the platform does not merge blind',
  merge_request_not_open: 'the merge request is not open',
  provider_blocked: 'the provider does not report it mergeable yet',
  merge_settings_unknown:
    'the provider did not say whether a merge squashes it, so the platform cannot use the repository’s own settings',
  head_moved:
    'the branch moved since the reviewed commit; a person merges it, or Send back to review the new commits',
  needs_rebase: 'the provider wants a rebase first, and the platform is asking for one',
  rebase_in_progress: 'the provider is rebasing it onto the target branch',
  rebase_pipeline: 'the pipeline on the rebased commit is running',
  rebase_bound:
    'the provider wants a rebase again; the platform has rebased 3 times since this task reached Ready because the default branch keeps moving — rebase and merge it yourself',
  rebase_no_digest:
    'the provider wants a rebase, and the change is too large to prove the rebased change identical — rebase and merge it yourself',
  rebase_unsupported:
    'the provider wants a rebase the platform cannot ask for — rebase and merge it yourself',
  rebase_refused: 'the provider refused to rebase it — rebase and merge it yourself, or Send back',
  rebase_no_change:
    'the provider wants a rebase again although its last rebase changed nothing — rebase and merge it yourself',
  rebase_changed:
    'after the provider’s rebase the change is not the one reviewed — merge it yourself, or Send back',
};

/** The sentence for who merges and what the platform waits for. */
export const mergeWaitSentence = (
  by: 'person' | 'platform',
  waitingFor: string | null,
  provider: string,
  blockedNow: string | null,
): string => {
  if (by === 'person') {
    return `A person merges: ${
      waitingFor === null
        ? 'this project’s setting.'
        : (PERSON_WHY[waitingFor] ?? `${waitingFor.replaceAll('_', ' ')}.`)
    }`;
  }
  const now =
    blockedNow ??
    (waitingFor === null
      ? 'it is mergeable, and the platform is merging it'
      : (WAITING_NOW[waitingFor] ?? waitingFor.replaceAll('_', ' ')));
  return `Merging automatically when ${provider} reports it mergeable — now: ${now}.`;
};

/** A refusal's port word, with the provider's status, mid-sentence after *"said "*. */
const REFUSED_WHY: Readonly<Record<string, string>> = {
  head_moved: 'the branch moved (409)',
  not_allowed: 'the merge request cannot be merged (405)',
  not_mergeable: 'the branch cannot be merged (422)',
  unauthorised:
    'the platform’s account may not merge here (401) — give it Allowed to merge on the target branch',
};

/** Why a rebase did not lead to a merge, mid-sentence. */
const REBASE_WHY: Readonly<Record<string, string>> = {
  digest_changed: 'its added and removed lines differ from the reviewed change',
  commits_changed: 'its number of commits changed',
  pipeline_failed: 'the pipeline on the rebased commit did not pass',
  cannot_push: 'the platform may not push to the source branch',
  not_enqueued: 'the provider could not queue the rebase',
  rebase_unknown:
    'the provider still showed an earlier rebase’s failure, so whether this rebase went through cannot be told',
  rebase_failed:
    'it conflicts with the target branch, so the task went back to the up-to-date check',
};

const why = (status: string | null): string =>
  status === null
    ? 'the rebase did not go through'
    : (REBASE_WHY[status] ?? status.replaceAll('_', ' '));

/** The plan decision the merge rested on, after *" — "*. */
export const planDecisionWords = (decision: string, approvedBy: string | null): string =>
  decision === 'approved_by_person'
    ? `plan approved by ${approvedBy ?? 'a person'}`
    : decision === 'approved_by_platform'
      ? 'plan approved by the platform as low-risk'
      : 'no plan approval required';

/** The sentence for the platform's last attempt. */
export const mergeAttemptSentence = (
  attempt: {
    readonly outcome: string;
    readonly provider_status: string | null;
    readonly merge_commit_sha: string | null;
    readonly plan_decision: string;
    readonly plan_approved_by: string | null;
    readonly attempted_at: string;
  },
  provider: string,
  at: string,
): string => {
  const plan = planDecisionWords(attempt.plan_decision, attempt.plan_approved_by);
  const status = attempt.provider_status;
  switch (attempt.outcome) {
    case 'merged':
      return `Merged by the platform at ${at}${
        attempt.merge_commit_sha === null ? '' : `, commit ${attempt.merge_commit_sha.slice(0, 7)}`
      } — ${plan}. The task moves on when ${provider} reports the merge.`;
    case 'refused':
      return `The platform’s merge was refused: ${provider} said ${
        status === null ? 'no' : (REFUSED_WHY[status] ?? status.replaceAll('_', ' '))
      } — merge it yourself or Send back.`;
    case 'failed':
      return status === 'not_merged'
        ? `${provider} answered the platform’s merge but the merge request did not read back merged — check it there, and merge it yourself or Send back.`
        : `The platform could not reach ${provider} to merge it after 3 tries — merge it yourself or Send back.`;
    case 'rebased':
      return `The platform asked ${provider} to rebase the merge request at ${at}; it merges the rebased commit once its pipeline passes and the change is the one reviewed.`;
    case 'rebase_refused':
      return `${provider} did not rebase it: ${why(status)} — rebase and merge it yourself, or Send back.`;
    case 'rebase_conflict':
      return `${provider} could not rebase it: ${why(status)}.`;
    default:
      return `${provider} rebased it, and the platform did not merge: ${why(status)} — merge it yourself or Send back.`;
  }
};
