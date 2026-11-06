/**
 * `task_stages.outcome` as a sentence — the stage timeline's line under each attempt (WP-73,
 * PROGRESS backlog 213), split out of `task-detail.tsx` at S-23.9b.
 */
import type { TaskStageOutcome, TaskStageOutcomeWord } from '@platform/contracts';
import { stageVerdictSchema, taskStageOutcomeWordSchema } from '@platform/contracts';
import { eventPhrase } from '../ui/humanize.js';

/**
 * **The word→sentence table of `task_stages.outcome`** (WP-73, PROGRESS backlog 213). The platform's
 * own words are an exhaustive `switch` — a word added to `taskStageOutcomeWordSchema` without a
 * sentence here fails `tsc` — and the two families the vocabulary includes by reference are said
 * generically: a stage verdict, and the event that moved a human stage.
 */
export const stageOutcomeWordSentence = (word: TaskStageOutcomeWord): string => {
  switch (word) {
    case 'returned':
      return 'Sent the task back to an earlier stage.';
    case 'superseded':
      return 'Ended when the stage was entered again as a new attempt.';
    case 'left':
      return 'Ended when the task entered another stage.';
    case 'cancelled':
      return 'Ended because the task was cancelled.';
    case 'system':
      return 'Completed by the platform on entry.';
    case 'failed':
      return 'The run failed, could not start, or its process stopped renewing it.';
    case 'escalated':
      return 'Handed to a person: it needs you.';
    case 'undecided':
      return 'Needs you: the check could not decide in the tries it is allowed.';
    case 'unsupported':
      return 'Needs you: the project’s connections cannot answer this check.';
    case 'converged':
      return 'Needs you: the same failure repeated, so another round would not help.';
    case 'question.expired':
      return 'Needs you: a question expired unanswered.';
    case 'approval.expired':
      return 'Needs you: an approval expired undecided.';
    case 'budget.rejected':
      return 'Needs you: the budget approval was rejected.';
    case 'plan.rejected':
      return 'Sent back: a maintainer rejected the plan, and the next attempt is given the reason.';
    case 'take_over.expired':
      return 'Needs you: the person working on it showed no activity for five working days.';
    case 'write_conflict':
      return 'Needs you: the platform’s write lost every retry against another writer.';
    case 'dead_lettered':
      return 'Needs you: an event about this task could not be processed.';
    case 'repository_config_invalid':
      return 'Needs you: the repository’s settings file does not parse.';
    case 'ticket_assigned_elsewhere':
      return 'Needs you: the ticket is assigned to somebody else, so no agent run started.';
    case 'ticket_claim_failed':
      return 'Needs you: the platform could not claim the ticket, so no agent run started.';
    case 'settings_config_invalid':
      return 'Needs you: the project’s stored settings do not parse under this release.';
    case 'context_budget_above_ceiling':
      return 'Needs you: the project’s context budget is above this release’s ceiling.';
    case 'protected_paths_changed':
      return 'Sent the task back: the change touches protected files the plan did not declare or the code review did not confirm.';
    case 'protected_paths_awaiting_review':
      return 'Passed; the protected files the plan declared wait for the code review to confirm them, which is checked before Ready.';
    case 'protected_paths_clean':
      return 'No protected file was touched that the change may not touch; the CI pipeline decided the check.';
    case 'protected_paths_confirmed':
      return 'Passed; the code review confirmed every protected file the plan declared.';
    case 'unknown':
      return 'Finished without a verdict.';
    case 'unrecognised':
      return 'Finished with a verdict the platform does not recognise.';
  }
};

/** Any `task_stages.outcome` as a sentence: the table above, a verdict, or an event's name. */
export const stageOutcomeSentence = (outcome: TaskStageOutcome): string => {
  const word = taskStageOutcomeWordSchema.safeParse(outcome);
  if (word.success) {
    return stageOutcomeWordSentence(word.data);
  }
  if (stageVerdictSchema.safeParse(outcome).success) {
    return `Verdict: ${outcome.replaceAll('_', ' ')}.`;
  }
  // The one event name the platform writes as an ending rather than as a move (`closeCurrentStageRow`).
  if (outcome === 'task.completed') {
    return 'Ended because the task completed.';
  }
  return `Moved on because ${eventPhrase(outcome)}.`;
};
