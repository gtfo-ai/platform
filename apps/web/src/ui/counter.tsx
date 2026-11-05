/**
 * A count in a pill (Primer's CounterLabel): beside a nav item, in a list header, on a button.
 *
 * The number is text, so a link reads "Inbox 3" to a screen reader. `label` replaces that reading
 * where the bare number would be ambiguous ("3 open questions").
 */
import type { ReactElement } from 'react';
import { cx } from './cx.js';

export type CounterTone = 'default' | 'primary';

const TONES: Record<CounterTone, string> = {
  default: 'bg-muted text-fg',
  primary: 'bg-primary text-primary-fg',
};

export const Counter = ({
  count,
  tone = 'default',
  label,
  className,
}: {
  readonly count: number;
  readonly tone?: CounterTone;
  /** The accessible reading, when the bare number is not enough. */
  readonly label?: string;
  readonly className?: string;
}): ReactElement => (
  <span
    data-counter=""
    className={cx(
      'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs leading-[1.125rem] font-medium tabular-nums',
      TONES[tone],
      className,
    )}
    {...(label === undefined ? {} : { 'aria-label': label })}
  >
    {new Intl.NumberFormat('en').format(count)}
  </span>
);
