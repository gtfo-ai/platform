/**
 * "Which phase is this job in" — one component, everywhere (TD-033 decision 7).
 *
 * A compact strip of the task's pipeline stages — done, current, upcoming, sent back, failed or
 * skipped, each with its **own glyph** so the strip never relies on colour alone (WCAG 1.4.1) — and
 * beneath it the current stage's human name with the activity's sub-label: "Code review · Now:
 * Reading files". For assistive tech it is an ordered list whose current item carries
 * `aria-current="step"`, preceded by a visually-hidden summary ("Stage 4 of 9: Code review,
 * working: Reading files").
 *
 * No dependency beyond the per-icon Octicons `ui/` already uses, so the worker's local page can
 * import it inside its 120 kB budget. `phaseStagesFor` builds the strip from what the task page has
 * today — the task's entered stage rows — and from the compiled pipeline graph's `nodes[]` once a
 * screen has one.
 */

import type { TaskStageState } from '@platform/contracts';
import { CheckCircleFillIcon } from '@primer/octicons-react/CheckCircleFillIcon';
import { CircleIcon } from '@primer/octicons-react/CircleIcon';
import { DotFillIcon } from '@primer/octicons-react/DotFillIcon';
import { SkipIcon } from '@primer/octicons-react/SkipIcon';
import type { Icon } from '@primer/octicons-react/types';
import { UndoIcon } from '@primer/octicons-react/UndoIcon';
import { XCircleFillIcon } from '@primer/octicons-react/XCircleFillIcon';
import type { ReactElement } from 'react';
import { ACTIVITY_META, type Activity } from './activity.js';
import { cx } from './cx.js';
import { stageLabel } from './humanize.js';

export const PHASE_STATES = [
  'done',
  'current',
  'upcoming',
  'returned',
  'failed',
  'skipped',
] as const;

export type PhaseState = (typeof PHASE_STATES)[number];

export interface PhaseStage {
  readonly id: string;
  /** The human name; `stageLabel(id)` by default. */
  readonly label?: string;
  readonly state: PhaseState;
}

interface PhaseLook {
  readonly icon: Icon;
  readonly fg: string;
  readonly word: string;
}

export const PHASE_LOOK: Readonly<Record<PhaseState, PhaseLook>> = {
  done: { icon: CheckCircleFillIcon, fg: 'text-success', word: 'done' },
  current: { icon: DotFillIcon, fg: 'text-running', word: 'current' },
  upcoming: { icon: CircleIcon, fg: 'text-fg-subtle', word: 'upcoming' },
  returned: { icon: UndoIcon, fg: 'text-attention', word: 'sent back' },
  failed: { icon: XCircleFillIcon, fg: 'text-danger', word: 'failed' },
  skipped: { icon: SkipIcon, fg: 'text-fg-muted', word: 'skipped' },
};

const nameOf = (stage: PhaseStage): string => stage.label ?? stageLabel(stage.id);

/** The sentence a screen reader hears first: "Stage 4 of 9: Code review, working: Reading files". */
export const phaseSummary = (
  stages: readonly PhaseStage[],
  activity?: Activity | null,
  detail?: string | null,
): string => {
  if (stages.length === 0) {
    return 'No stages yet';
  }
  const index = stages.findIndex((stage) => stage.state === 'current');
  if (index === -1) {
    return stages.every((stage) => stage.state === 'upcoming')
      ? 'Not started'
      : 'No stage in progress';
  }
  const stage = stages[index] as PhaseStage;
  const how = detail === null || detail === undefined ? '' : `: ${detail}`;
  const doing =
    activity === null || activity === undefined
      ? ''
      : `, ${ACTIVITY_META[activity].label.toLowerCase()}${how}`;
  return `Stage ${index + 1} of ${stages.length}: ${nameOf(stage)}${doing}`;
};

export const PhaseTrack = ({
  stages,
  activity,
  detail,
  size = 'md',
  className,
}: {
  readonly stages: readonly PhaseStage[];
  readonly activity?: Activity | null;
  /** The activity's sub-label, e.g. "Reading files" (platform text from `activityOf`). */
  readonly detail?: string | null;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}): ReactElement => {
  const current = stages.find((stage) => stage.state === 'current');
  const now =
    detail ?? (activity === null || activity === undefined ? null : ACTIVITY_META[activity].label);
  return (
    <div data-phase-track className={cx('flex min-w-0 flex-col gap-1', className)}>
      <span className="sr-only">{phaseSummary(stages, activity, detail)}</span>
      <ol aria-label="Pipeline stages" className="flex flex-wrap items-center gap-0.5">
        {stages.map((stage) => {
          const look = PHASE_LOOK[stage.state];
          const Glyph = look.icon;
          const name = nameOf(stage);
          return (
            <li
              key={stage.id}
              data-phase={stage.state}
              aria-current={stage.state === 'current' ? 'step' : undefined}
              title={`${name}: ${look.word}`}
              className={cx(
                'inline-flex items-center',
                look.fg,
                stage.state === 'current' ? 'status-running' : null,
              )}
            >
              <span aria-hidden="true" className="inline-flex">
                <Glyph size={size === 'sm' ? 12 : 16} />
              </span>
              <span className="sr-only">{`${name}, ${look.word}`}</span>
            </li>
          );
        })}
      </ol>
      {current === undefined ? null : (
        <p
          aria-hidden="true"
          className={cx('truncate text-fg-muted', size === 'sm' ? 'text-xs' : 'text-sm')}
        >
          <span className="font-medium text-fg">{nameOf(current)}</span>
          {now === null ? null : ` · Now: ${now}`}
        </p>
      )}
    </div>
  );
};

/** The task's entered stage rows, as the task page has them (oldest first). */
export interface StageRowLike {
  readonly stage: string;
  readonly attempt: number;
  readonly state: TaskStageState;
}

const PHASE_OF_ROW: Readonly<Record<TaskStageState, PhaseState>> = {
  pending: 'current',
  running: 'current',
  completed: 'done',
  returned: 'returned',
  skipped: 'skipped',
  failed: 'failed',
};

/**
 * The strip for one task.
 *
 * - With the compiled graph's nodes (`templateStages`, in pipeline order), every stage is shown:
 *   the current one is `current` (or `failed` when its latest attempt failed), one with an attempt
 *   takes its latest attempt's state, one without an attempt before the current stage was stepped
 *   over (`skipped`), and one after it is `upcoming`.
 * - Without them — today, the task page has only the stages the task entered — the strip is those
 *   stages in the order first entered, each with its latest attempt's state, and the current stage
 *   appended if the task has not entered it yet. Nothing upcoming is invented.
 *
 * A live attempt at a stage that is not the task's current one is read as `done`: the task has
 * moved on and the row's close is late, not a second current stage.
 */
export const phaseStagesFor = (
  templateStages: readonly { readonly id: string }[] | null,
  taskStages: readonly StageRowLike[],
  currentStage: string | null,
): readonly PhaseStage[] => {
  const latest = new Map<string, StageRowLike>();
  const firstEntered: string[] = [];
  for (const row of taskStages) {
    if (!latest.has(row.stage)) {
      firstEntered.push(row.stage);
    }
    const previous = latest.get(row.stage);
    if (previous === undefined || row.attempt >= previous.attempt) {
      latest.set(row.stage, row);
    }
  }
  const stateOf = (id: string): PhaseState | null => {
    const row = latest.get(id);
    if (id === currentStage) {
      return row?.state === 'failed' ? 'failed' : 'current';
    }
    if (row === undefined) {
      return null;
    }
    const phase = PHASE_OF_ROW[row.state];
    return phase === 'current' ? 'done' : phase;
  };

  if (templateStages !== null) {
    const ids = templateStages.map((node) => node.id);
    const currentIndex = currentStage === null ? -1 : ids.indexOf(currentStage);
    const lastEntered = ids.reduce((last, id, index) => (latest.has(id) ? index : last), -1);
    const frontier = currentIndex === -1 ? lastEntered : currentIndex;
    return ids.map((id, index) => ({
      id,
      state: stateOf(id) ?? (index < frontier ? 'skipped' : 'upcoming'),
    }));
  }

  const ids =
    currentStage !== null && !latest.has(currentStage)
      ? [...firstEntered, currentStage]
      : firstEntered;
  return ids.map((id) => ({ id, state: stateOf(id) ?? 'upcoming' }));
};
