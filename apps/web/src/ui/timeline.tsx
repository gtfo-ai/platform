/**
 * Timeline: a vertical list of events with icon badges on a connecting line (Primer's Timeline) —
 * a task's stages, a run's activity.
 *
 * An ordered list, because the order is the information. The badge is decorative (an item's text
 * says what happened); the line is drawn by CSS and never read.
 */
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export const Timeline = ({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement => (
  <ol aria-label={label} data-timeline="" className={cx('flex flex-col', className)}>
    {children}
  </ol>
);

export const TimelineItem = ({
  badge,
  time,
  children,
  ...data
}: {
  /** A StatusIcon (decorative) or an Octicon. */
  readonly badge?: ReactNode;
  /** When it happened, already formatted. */
  readonly time?: ReactNode;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}): ReactElement => (
  <li
    {...data}
    className="relative flex gap-3 pb-4 last:pb-0 before:absolute before:top-8 before:bottom-0 before:left-[15px] before:w-0.5 before:bg-line last:before:hidden"
  >
    <span
      aria-hidden="true"
      className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-fg-muted"
    >
      {badge}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1.5 text-sm">
      <div className="min-w-0 break-words">{children}</div>
      {time === undefined ? null : <div className="text-xs text-fg-muted">{time}</div>}
    </div>
  </li>
);
