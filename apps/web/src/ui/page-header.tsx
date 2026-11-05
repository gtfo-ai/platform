/**
 * PageHeader: title, state and the one primary action (TD-033 § 1; research/19 § 3.1).
 *
 * The back link and the actions are slots, so `ui/` never knows the router. The title is the
 * page's `<h1>`. The state (a `StateLabel`) and the meta line sit under the title, as on a GitHub
 * issue or workflow run.
 */
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export const PageHeader = ({
  back,
  title,
  state,
  meta,
  actions,
  className,
}: {
  readonly back?: ReactNode;
  readonly title: ReactNode;
  readonly state?: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}): ReactElement => (
  <div className={cx('flex flex-col gap-2 border-b border-line pb-4', className)}>
    {back === undefined ? null : <div className="text-sm text-fg-muted">{back}</div>}
    <div className="flex flex-wrap items-start gap-3">
      <h1 className="min-w-0 flex-1 text-xl font-semibold break-words text-fg">{title}</h1>
      {actions === undefined ? null : (
        <div data-page-actions="" className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
    {state === undefined && meta === undefined ? null : (
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        {state}
        {meta}
      </div>
    )}
  </div>
);
