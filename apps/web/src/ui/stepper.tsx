/**
 * Stepper: the vertical step list of a wizard (TD-033 § 9; NN/g's wizard guidance) — done ✓,
 * current ●, upcoming ○, and an optional tag.
 *
 * An ordered list whose current step carries `aria-current="step"`. Each step's state is also a
 * word for assistive tech ("Completed", "Current step", "Not started"), because a check mark and a
 * dot are not words.
 */
import { CheckIcon } from '@primer/octicons-react/CheckIcon';
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export type StepState = 'done' | 'current' | 'upcoming';

export interface Step {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  readonly optional?: boolean;
  readonly hint?: string;
  /** The step's link, when steps are addressable; the label is plain text otherwise. */
  readonly render?: (props: {
    readonly className: string;
    readonly children: ReactNode;
  }) => ReactElement;
}

const STATE_WORD: Record<StepState, string> = {
  done: 'Completed',
  current: 'Current step',
  upcoming: 'Not started',
};

const Badge = ({
  state,
  index,
}: {
  readonly state: StepState;
  readonly index: number;
}): ReactElement => {
  if (state === 'done') {
    return (
      <span className="flex size-6 items-center justify-center rounded-full bg-success-bg text-success ring-1 ring-success/50">
        <CheckIcon size={16} />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-fg">
        {index + 1}
      </span>
    );
  }
  return (
    <span className="flex size-6 items-center justify-center rounded-full border border-line-input text-xs text-fg-muted">
      {index + 1}
    </span>
  );
};

export const Stepper = ({
  label,
  steps,
  className,
}: {
  readonly label: string;
  readonly steps: readonly Step[];
  readonly className?: string;
}): ReactElement => (
  <ol aria-label={label} className={cx('flex flex-col', className)}>
    {steps.map((step, index) => {
      const labelClass = cx(
        'text-sm',
        step.state === 'current' ? 'font-semibold text-fg' : null,
        step.state === 'done' ? 'text-fg' : null,
        step.state === 'upcoming' ? 'text-fg-muted' : null,
      );
      return (
        <li
          key={step.id}
          data-step-state={step.state}
          {...(step.state === 'current' ? { 'aria-current': 'step' as const } : {})}
          className="relative flex gap-3 pb-5 last:pb-0 before:absolute before:top-7 before:bottom-1 before:left-[11px] before:w-0.5 before:bg-line last:before:hidden"
        >
          <span aria-hidden="true" className="relative z-10 shrink-0">
            <Badge state={step.state} index={index} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
            <div className="flex flex-wrap items-center gap-2">
              {step.render === undefined ? (
                <span className={labelClass}>{step.label}</span>
              ) : (
                step.render({ className: cx(labelClass, 'hover:underline'), children: step.label })
              )}
              <span className="sr-only">{`, ${STATE_WORD[step.state]}`}</span>
              {step.optional === true ? (
                <span className="rounded-full border border-line px-1.5 text-xs text-fg-muted">
                  Optional
                </span>
              ) : null}
            </div>
            {step.hint === undefined ? null : <p className="text-xs text-fg-muted">{step.hint}</p>}
          </div>
        </li>
      );
    })}
  </ol>
);
