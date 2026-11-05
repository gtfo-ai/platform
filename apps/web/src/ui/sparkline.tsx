/**
 * Sparkline: a metric's buckets as one thin line, pure SVG (S-23.19). No chart library, no `style=`
 * (the production CSP has no `'unsafe-inline'` for styles): geometry is SVG attributes and colour
 * is `currentColor` from a Tailwind class.
 *
 * The SVG is decorative to assistive tech (`aria-hidden`) and the same facts are carried as text —
 * `summary`, rendered `sr-only` — because a line a screen reader cannot read is not information.
 * The caller computes both from the same buckets (`features/statistics-format.ts`).
 */
import type { ReactElement } from 'react';
import { cx } from './cx.js';

export const Sparkline = ({
  segments,
  summary,
  width,
  height,
  className,
}: {
  /** One SVG `points` list per run of buckets that have a value; a gap is a missing bucket. */
  readonly segments: readonly string[];
  readonly summary: string;
  readonly width: number;
  readonly height: number;
  readonly className?: string;
}): ReactElement => (
  <span className={cx('block', className)} data-sparkline="">
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block h-6 w-full overflow-visible text-link"
    >
      {segments.map((points) =>
        points.includes(' ') ? (
          <polyline
            key={points}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          // A run of one bucket between two gaps: a dot, or it would not be drawn at all.
          <circle
            key={points}
            cx={points.split(',')[0]}
            cy={points.split(',')[1]}
            r={1.25}
            fill="currentColor"
          />
        ),
      )}
    </svg>
    <span className="sr-only">{summary}</span>
  </span>
);
