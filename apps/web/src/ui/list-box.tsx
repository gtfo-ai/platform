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
    {/* `data-list-box`: the lists `j`/`k` move in (`app/shortcuts.ts`). */}
    <ul aria-label={label} data-list-box="" className="divide-y divide-line">
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
  // Below `sm` the trailing facts take a line of their own under the meta, and the meta breaks
  // anywhere rather than being clipped by the box (S-23.13a: a hostile ticket's long token was cut
  // off at 390 px).
  <li
    className={cx(
      'flex min-h-12 flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-subtle sm:flex-nowrap',
      className,
    )}
  >
    {leading === undefined ? null : <div className="flex h-5 shrink-0 items-center">{leading}</div>}
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="min-w-0 text-sm font-semibold break-words text-fg">{title}</div>
      {meta === undefined ? null : (
        <div data-row-meta="" className="min-w-0 text-xs wrap-anywhere text-fg-muted">
          {meta}
        </div>
      )}
    </div>
    {trailing === undefined ? null : (
      <div
        data-row-trailing=""
        className="flex shrink-0 flex-wrap items-center gap-3 text-xs text-fg-muted max-sm:order-last max-sm:basis-full"
      >
        {trailing}
      </div>
    )}
    {actions === undefined ? null : <div className="flex shrink-0 items-center">{actions}</div>}
  </li>
);
