/**
 * DetailsDisclosure: raw ids, JSON and long explanations, collapsed (research/19 § 3.6). A native
 * `<details>`/`<summary>` — the browser already gives it the keyboard behaviour and the expanded
 * state — styled as GitHub's "Details".
 */
import { ChevronRightIcon } from '@primer/octicons-react/ChevronRightIcon';
import type { ReactElement, ReactNode } from 'react';
import { cx, FOCUS_RING } from './cx.js';

export const DetailsDisclosure = ({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
}): ReactElement => (
  <details open={defaultOpen} className={cx('group text-sm', className)}>
    <summary
      className={cx(
        'inline-flex list-none items-center gap-1 rounded-md py-1 pr-2 font-medium text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden',
        FOCUS_RING,
      )}
    >
      <span aria-hidden="true" className="inline-flex transition-transform group-open:rotate-90">
        <ChevronRightIcon size={16} />
      </span>
      {summary}
    </summary>
    <div className="mt-2 rounded-md border border-line bg-inset p-3">{children}</div>
  </details>
);
