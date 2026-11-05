/**
 * Skeleton: what a loading region shows instead of "Loading …" text (research/19 § 3.5: never
 * "No records" while loading). Announced once as a polite status with its label; the bars are
 * decorative. The shimmer stops under `prefers-reduced-motion` (`styles.css`).
 */
import type { ReactElement } from 'react';
import { cx } from './cx.js';

const WIDTHS = ['w-full', 'w-11/12', 'w-4/6', 'w-5/6', 'w-3/6'] as const;

export const Skeleton = ({
  label,
  lines = 3,
  className,
}: {
  /** What is loading ("Loading runs…"), for assistive tech. */
  readonly label: string;
  readonly lines?: number;
  readonly className?: string;
}): ReactElement => (
  <div role="status" aria-live="polite" className={cx('flex flex-col gap-2 py-2', className)}>
    <span className="sr-only">{label}</span>
    {Array.from({ length: Math.max(1, lines) }, (_, index) => (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: the bars are identical and never reorder.
        key={index}
        aria-hidden="true"
        data-skeleton-bar=""
        className={cx(
          'skeleton-shimmer block h-3 rounded-sm bg-muted',
          WIDTHS[index % WIDTHS.length],
        )}
      />
    ))}
  </div>
);
