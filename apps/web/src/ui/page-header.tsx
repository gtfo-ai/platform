/**
 * PageHeader: title, state and the one primary action (TD-033 § 1; research/19 § 3.1).
 *
 * The back link and the actions are slots, so `ui/` never knows the router. The title is the
 * page's `<h1>`. The state (a `StateLabel`) and the meta line sit under the title, as on a GitHub
 * issue or workflow run.
 *
 * `data-page-header` marks it as chrome for the Settings card census (S-25.10b,
 * `test/web-e2e/settings-cards.spec.ts`): its meta line is the page's, not a content block.
 */
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export const PageHeader = ({
  back,
  title,
  state,
  meta,
  actions,
  titleAs = 'h1',
  divider = true,
  className,
}: {
  readonly back?: ReactNode;
  readonly title: ReactNode;
  readonly state?: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  /**
   * `p` when the page below has its own `<h1>` — the project header above a task, which is the
   * task's page and not the project's — so a page never carries two.
   */
  readonly titleAs?: 'h1' | 'p';
  /** `false` when an UnderlineNav follows and draws the line itself (GitHub's repository header). */
  readonly divider?: boolean;
  readonly className?: string;
}): ReactElement => {
  const Title = titleAs;
  return (
    <div
      data-page-header=""
      className={cx(
        'flex flex-col gap-2',
        divider ? 'border-b border-line pb-4' : 'pb-1',
        className,
      )}
    >
      {back === undefined ? null : <div className="text-sm text-fg-muted">{back}</div>}
      <div className="flex flex-wrap items-start gap-3">
        {/* `basis-64`: the title keeps 16 rem before the actions wrap onto a line of their own,
            rather than being squeezed to a word per line on a phone (S-23.13a). */}
        <Title className="min-w-0 flex-1 basis-64 text-xl font-semibold break-words text-fg">
          {title}
        </Title>
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
};
