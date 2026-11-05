/**
 * The **"Live activity"** list (TD-033 decision 8 (a)): time · status dot · what the agent did, one
 * row per `activityRows` row (`activity-rows.ts`). The stage dialog shows the whole list beside its
 * log; the run page (S-23.10) shows its newest rows under the *Now:* line — one component, so the
 * two never say the same run's activity two ways.
 *
 * A row's label is the vocabulary's words; a tool name it quotes is filtered and bounded there
 * (`toolWords`) and rendered as React text.
 */
import { DotFillIcon } from '@primer/octicons-react/DotFillIcon';
import type { ReactElement } from 'react';
import { ACTIVITY_META } from '../../ui/activity.js';
import { cx } from '../../ui/cx.js';
import { type Status, StatusIcon } from '../../ui/status.js';
import { type ActivityRow, clockTime } from './activity-rows.js';

const ROW_STATUS: Readonly<Record<ActivityRow['state'], Status | null>> = {
  current: 'running',
  error: 'failure',
  needs_you: 'needs_you',
  done: null,
};

export const ActivityList = ({
  rows,
  className,
}: {
  readonly rows: readonly ActivityRow[];
  readonly className?: string;
}): ReactElement =>
  rows.length === 0 ? (
    <p className="text-xs text-fg-muted">Nothing yet. Rows appear as the agent works.</p>
  ) : (
    <ol aria-label="Live activity" className={cx('flex flex-col gap-1 text-xs', className)}>
      {rows.map((row) => {
        const status = ROW_STATUS[row.state];
        return (
          <li key={row.key} data-activity-row={row.state} className="flex items-center gap-2">
            <span className="w-16 shrink-0 tabular-nums text-fg-muted">{clockTime(row.at)}</span>
            {status === null ? (
              <span aria-hidden="true" className="inline-flex text-fg-subtle">
                <DotFillIcon size={12} />
              </span>
            ) : (
              <StatusIcon status={status} size={12} label={ACTIVITY_META[row.activity].label} />
            )}
            <span className={cx('truncate', row.state === 'current' ? 'font-medium' : null)}>
              {row.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
