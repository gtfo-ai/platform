/**
 * MetricStrip: a row of figures in one bordered box, each cell divided from the next — the summary
 * line of a GitHub Insights page or an Actions run (research/19 § 5.2: Statistics, a shadow batch).
 *
 * Each cell is a `Metric` (label with its definition, the value), passed as children so a cell can
 * carry a line under its value (a sample count, a caveat). The strip wraps on a narrow screen.
 */
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export const MetricStrip = ({
  label,
  children,
  className,
}: {
  /** The strip's accessible name. */
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement => (
  <section
    aria-label={label}
    data-metric-strip=""
    className={cx(
      'flex flex-wrap overflow-hidden rounded-md border border-line bg-canvas [&>*]:min-w-36 [&>*]:flex-1 [&>*]:border-line [&>*]:px-4 [&>*]:py-3 [&>*:not(:last-child)]:border-r',
      className,
    )}
  >
    {children}
  </section>
);
