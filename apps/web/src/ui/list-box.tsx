/**
 * ListBox, ListBoxHeader and ListRow: GitHub's issue and workflow-run lists (TD-033 § 1).
 *
 * A box with a quiet border; a subtle header row with the counts and filters; rows of 48 px with the
 * status icon first, the title, a meta line under it, right-aligned facts and an overflow slot.
 */
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export const ListBox = ({
  label,
  header,
  children,
  className,
}: {
  /** The list's accessible name. */
  readonly label: string;
  readonly header?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement => (
  <div className={cx('overflow-hidden rounded-md border border-line bg-default', className)}>
    {header}
    <ul aria-label={label} className="divide-y divide-line">
      {children}
    </ul>
  </div>
);

export const ListBoxHeader = ({
  children,
  actions,
}: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}): ReactElement => (
  <div className="flex min-h-12 flex-wrap items-center gap-3 border-b border-line bg-subtle px-4 py-2 text-sm">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4">{children}</div>
    {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

export const ListRow = ({
  leading,
  title,
  meta,
  trailing,
  actions,
  className,
}: {
  /** The status icon. */
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  /** Right-aligned facts (a cost, an avatar, a time). */
  readonly trailing?: ReactNode;
  /** The row's overflow menu. */
  readonly actions?: ReactNode;
  readonly className?: string;
}): ReactElement => (
  <li className={cx('flex min-h-12 items-start gap-3 px-4 py-2.5 hover:bg-subtle', className)}>
    {leading === undefined ? null : <div className="flex h-5 shrink-0 items-center">{leading}</div>}
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="min-w-0 text-sm font-semibold break-words text-fg">{title}</div>
      {meta === undefined ? null : <div className="text-xs text-fg-muted">{meta}</div>}
    </div>
    {trailing === undefined ? null : (
      <div className="flex shrink-0 items-center gap-3 text-xs text-fg-muted">{trailing}</div>
    )}
    {actions === undefined ? null : <div className="flex shrink-0 items-center">{actions}</div>}
  </li>
);
