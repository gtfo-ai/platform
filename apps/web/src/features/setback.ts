/**
 * **A task that went back says why, and what happens next** (S-25.11, product/10's Task detail
 * amendment of 2026-11-07) — the words, pure, for the task header's *Now* line, the callout's slot,
 * the board card and the stage timeline. Every sentence is built from the task read's `returns` /
 * `latest_return` and `stop` (`taskReturnSchema`, `taskStopSchema`), which are the `task_stages`
 * rows the pipeline wrote; a fact a row does not hold is said to be *not recorded*, never guessed.
 *
 * Three states, and only three:
 *
 * - **fixing** — the newest return's target stage is the task's current stage, its attempt was
 *   entered after the return and is still open, and the task is active: the agent is on it, so there
 *   is no action. The round is `iteration_counters[loop]` of `loop_limits[loop]`, and only for a
 *   return whose row proves which loop it spent (`loop` is not `null`); a CI failure names its jobs.
 * - **stopped** — the task is waiting for a person and `stop` says why: the rounds are used up, the
 *   same failure came back (three times in a row for CI, product/04 S4), or the check got no answer
 *   (nothing failed: the recorded sentence follows, as untrusted text). The next step follows it.
 * - **not recorded** — a return whose row holds no reason, or no target, says so.
 *
 * The words are the platform's plain ones (product/10's *Plain words* rule, the vocabulary census):
 * a *round*, never a loop; *CI*, never a gate; no signature. "Round" is the board's word for the
 * same counter (`loopRoundLabel`'s *CI fix round 2 of 3*) — the census retires "try N" for
 * *Attempt N*, so the amendment's "try 2 of 3" is said "round 2 of 3".
 */
import type { TaskReturn, TaskStageState, TaskState, TaskStop } from '@platform/contracts';
import { CI_FAILURE_LABEL, ROLE_LABEL, stageLabel } from '../ui/humanize.js';

/** The task's columns the sentences read. */
export interface SetbackTask {
  readonly state: TaskState;
  readonly current_stage?: string | null;
  readonly iteration_counters: Readonly<Record<string, number>>;
}

/** A stage row as both reads carry it (the board's has no exit). */
export interface SetbackStageRow {
  readonly stage: string;
  readonly attempt: number;
  readonly state: TaskStageState;
  readonly entered_at: string;
}

type Limits = Readonly<Record<string, number>> | null;

/** The jobs as the row joined them — "job unit" or "jobs unit,lint", or none named. */
export const jobsPhrase = (jobs: string): string =>
  jobs.length === 0 ? 'no failing job was named' : `${jobs.includes(',') ? 'jobs' : 'job'} ${jobs}`;

/** "(round 2 of 3)", "(round 2)" when the ceiling is unknown, or nothing when no round is proven. */
const roundOf = (
  ret: Pick<TaskReturn, 'loop'>,
  task: SetbackTask,
  limits: Limits,
): { readonly long: string; readonly short: string } | null => {
  if (ret.loop === null) {
    return null;
  }
  const count = task.iteration_counters[ret.loop] ?? 0;
  if (count < 1) {
    return null;
  }
  const limit = limits?.[ret.loop];
  return limit === undefined
    ? { long: `round ${count}`, short: `round ${count}` }
    : { long: `round ${count} of ${limit}`, short: `round ${count}/${limit}` };
};

/**
 * The newest return whose target stage the agent is working on now, or `null`: the task is active
 * at the return's target, and that stage's latest attempt is open and was entered at or after the
 * return.
 */
export const openReturn = (
  task: SetbackTask,
  stages: readonly SetbackStageRow[],
  latest: TaskReturn | null,
): TaskReturn | null => {
  if (latest === null || latest.to_stage === null || task.state !== 'active') {
    return null;
  }
  if ((task.current_stage ?? null) !== latest.to_stage) {
    return null;
  }
  const row = stages
    .filter((entry) => entry.stage === latest.to_stage)
    .reduce<SetbackStageRow | null>(
      (newest, entry) => (newest === null || entry.attempt > newest.attempt ? entry : newest),
      null,
    );
  if (row === null || (row.state !== 'running' && row.state !== 'pending')) {
    return null;
  }
  return Date.parse(row.entered_at) >= Date.parse(latest.at) ? latest : null;
};

/** Who acts at the return's target — "the Developer" — or the stage's name when no role is known. */
const whoOf = (ret: TaskReturn): string =>
  ret.to_role === null
    ? `the agent at ${stageLabel(ret.to_stage ?? ret.from_stage)}`
    : `the ${ROLE_LABEL[ret.to_role]}`;

/** Why it went back, as the sentence opens; `null` when the row recorded no reason. */
const causeOf = (ret: TaskReturn): string | null => {
  if (ret.ci_failure !== null) {
    return `${CI_FAILURE_LABEL[ret.ci_failure.status]} on the merge request (${jobsPhrase(ret.ci_failure.jobs)})`;
  }
  if (ret.outcome === 'protected_paths_changed') {
    return 'The change touches protected files the plan did not declare';
  }
  if (!ret.reason_recorded) {
    return null;
  }
  return `${stageLabel(ret.from_stage)} sent it back`;
};

/** The short cause for the board card and the *Now* line. */
const shortCauseOf = (ret: TaskReturn): string =>
  ret.ci_failure !== null
    ? CI_FAILURE_LABEL[ret.ci_failure.status]
    : ret.outcome === 'protected_paths_changed'
      ? 'Protected files changed'
      : `Sent back by ${stageLabel(ret.from_stage)}`;

export interface ReturnWords {
  /** The callout's one sentence. */
  readonly sentence: string;
  /** The card's and the *Now* line's short form — "CI failed · fixing, round 2/3". */
  readonly short: string;
  /** Whether the row recorded why — `false` is the *not recorded* state. */
  readonly recorded: boolean;
}

/** The fixing state's words, for a return {@link openReturn} answered. */
export const returnWords = (ret: TaskReturn, task: SetbackTask, limits: Limits): ReturnWords => {
  const cause = causeOf(ret);
  const round = roundOf(ret, task, limits);
  if (cause === null) {
    return {
      sentence: `It went back from ${stageLabel(ret.from_stage)}; the reason was not recorded. ${capitalise(whoOf(ret))} is working on it${round === null ? '' : ` (${round.long})`}.`,
      short: `Went back from ${stageLabel(ret.from_stage)} · reason not recorded`,
      recorded: false,
    };
  }
  const fixing = ret.ci_failure !== null || ret.outcome === 'protected_paths_changed';
  const doing = fixing ? 'fixing it' : 'working on it';
  return {
    sentence: `${cause}: ${whoOf(ret)} is ${doing}${round === null ? '' : ` (${round.long})`}.`,
    short: `${shortCauseOf(ret)} · ${fixing ? 'fixing' : 'working on it'}${round === null ? '' : `, ${round.short}`}`,
    recorded: true,
  };
};

/** The stage timeline's line under a returned attempt: where it went and why. */
export const timelineReturnLine = (ret: TaskReturn): string => {
  if (ret.to_stage === null) {
    return 'Sent back; where to was not recorded.';
  }
  const cause = causeOf(ret);
  return cause === null
    ? `Sent back to ${stageLabel(ret.to_stage)}; the reason was not recorded.`
    : ret.ci_failure !== null || ret.outcome === 'protected_paths_changed'
      ? `Sent back to ${stageLabel(ret.to_stage)}: ${lowerFirst(cause)}.`
      : `Sent back to ${stageLabel(ret.to_stage)}.`;
};

export interface StopWords {
  /** Why it stopped. */
  readonly sentence: string;
  /** The one next step. */
  readonly next: string;
  /** The card's short form — "CI failed the same way 3 times". */
  readonly short: string;
  /**
   * For a check that got no answer, the lead-in before the recorded sentence ("What the platform
   * saw last:"), which the caller renders as untrusted text after it; `null` otherwise.
   */
  readonly recordedLead: string | null;
}

const isCi = (stop: TaskStop): boolean => stop.stage === 'ci_gate';

/** The stopped state's words. */
export const stopWords = (stop: TaskStop, limits: Limits): StopWords => {
  const stage = stageLabel(stop.stage);
  const jobs = stop.ci_failure === null ? null : jobsPhrase(stop.ci_failure.jobs);
  switch (stop.cause) {
    case 'tries_spent': {
      const limit = stop.loop === null ? undefined : limits?.[stop.loop];
      const allowed =
        limit === undefined
          ? 'the rounds it is allowed are used up'
          : `all ${limit} rounds it is allowed are used`;
      return {
        sentence:
          stop.ci_failure !== null
            ? `${CI_FAILURE_LABEL[stop.ci_failure.status]} again (${jobs}), and ${allowed}, so the agent stopped.`
            : `${stage} sent it back again, and ${allowed}, so the agent stopped.`,
        next: isCi(stop)
          ? 'Look at the failing job on the merge request, then retry the stage or work on it yourself.'
          : 'Read what the stage found, then retry the stage or work on it yourself.',
        short:
          stop.ci_failure !== null
            ? `${CI_FAILURE_LABEL[stop.ci_failure.status]} · out of rounds`
            : `${stage} · out of rounds`,
        recordedLead: null,
      };
    }
    case 'same_failure':
      return {
        sentence: isCi(stop)
          ? `CI failed the same way three times in a row${jobs === null ? '' : ` (${jobs})`}, so the agent stopped.`
          : `${stage} found the same problems as the round before, so the agent stopped.`,
        next: isCi(stop)
          ? 'Look at the failing job on the merge request, then retry the stage or work on it yourself.'
          : 'Read what the stage found, then retry the stage or work on it yourself.',
        short: isCi(stop) ? 'CI failed the same way 3 times' : `${stage} · same problems again`,
        recordedLead: null,
      };
    case 'no_answer':
      return {
        sentence: isCi(stop)
          ? 'CI did not finish in the time the platform waits for it. Nothing failed.'
          : `${stage} got no answer in the time the platform waits for it. Nothing failed.`,
        next: isCi(stop)
          ? 'Look at the pipeline on the merge request: a job waiting to be started by hand never finishes on its own. Start or finish it there, then retry the stage.'
          : 'Look at the merge request yourself, then retry the stage.',
        short: isCi(stop) ? 'CI did not finish' : `${stage} · no answer`,
        recordedLead:
          stop.recorded === null
            ? 'What the platform saw last was not recorded.'
            : 'What the platform saw last:',
      };
  }
};

/**
 * The short form for the board card and the header's *Now* line: the fixing state's, else the
 * stopped state's, else `null` (say what the page said before).
 */
export const setbackShort = (
  task: SetbackTask,
  stages: readonly SetbackStageRow[],
  latest: TaskReturn | null,
  stop: TaskStop | null,
  limits: Limits,
): string | null => {
  const open = openReturn(task, stages, latest);
  if (open !== null) {
    return returnWords(open, task, limits).short;
  }
  return stop === null || task.state !== 'needs_human' ? null : stopWords(stop, limits).short;
};

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string): string =>
  text.startsWith('CI') ? text : text.charAt(0).toLowerCase() + text.slice(1);
