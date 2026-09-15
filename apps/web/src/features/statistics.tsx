/**
 * Statistics — product/10:22's organisation screen, on the numbers WP-41 made real.
 *
 * **It used to be a stub, and the stub's argument is what this screen keeps.** It said: *"a screen
 * full of zeroes reads as 'we delivered nothing' rather than 'nothing is measured yet'"*, and named
 * six numbers with the work packages that would produce them (Q45). The DTO exists now — every
 * metric arrives with its own definition, its samples, and, when this build cannot compute it, an
 * `absent` block naming the reason and the owner — so the honest screen is no longer an empty state
 * but a screen that **renders the absences as prose beside the numbers** rather than as zeroes.
 *
 * Three things follow from that and are visible here:
 *
 *  - a metric with `absent` is drawn in its own section, *"Not measured, and why"*, with the owner;
 *  - a metric whose `value` is `null` and which is **not** absent prints *"no data in this range"*,
 *    which is a different sentence from `0` — the first is nothing to divide, the second is a
 *    measurement (standing rule 18);
 *  - every number carries its definition in a tooltip (product/10:63) and its **caveats** on the
 *    screen, because reviewer minutes over-count on bots and under-count on approvals and the two
 *    do not cancel (PROGRESS backlog 88, 89, 90).
 *
 * ## Everything here is platform text, and it is still rendered as text
 *
 * The only string on this screen that did not come from this repository is a **stage id**, which a
 * project's own pipeline file names (BD-022). It goes through `UntrustedText` like every other
 * outside string; nothing on this screen becomes markup, and the CSV link is an `ExternalLink`
 * because that component is the only place in this application allowed to write a URL attribute.
 */
import type { StatMetric, StatUnit } from '@platform/contracts';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useOrgStats } from '../app/queries.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  formatInteger,
  formatMinutes,
  formatUsd,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';

const RANGES = ['7d', '30d', '90d', '365d'] as const;
const BUCKETS = ['day', 'week', 'month'] as const;

/**
 * One metric's value, in its own unit.
 *
 * `null` is **never** printed as a number: a ratio with nothing to divide and a count of zero are
 * different facts, and the sentence says which (standing rule 16).
 */
const formatValue = (value: number | null, unit: StatUnit): string => {
  if (value === null) {
    return 'no data in this range';
  }
  switch (unit) {
    case 'count':
      return formatInteger(value);
    case 'usd':
      return formatUsd(value);
    case 'minutes':
      return formatMinutes(value);
    case 'hours':
      return `${value.toFixed(1)} h`;
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
  }
};

const MetricCard = ({ metric }: { readonly metric: StatMetric }): ReactElement => (
  <div className="flex flex-col gap-1">
    <Metric
      label={metric.label}
      value={formatValue(metric.value, metric.unit)}
      definition={metric.definition}
    />
    <span className="text-[11px] text-fg-muted">
      {metric.samples === 0
        ? 'no observations in this range'
        : `${formatInteger(metric.samples)} observations`}
    </span>
    {metric.caveats.map((caveat) => (
      <span key={caveat} className="text-[11px] text-warning">
        {caveat}
      </span>
    ))}
  </div>
);

export const StatisticsScreen = (): ReactElement => {
  const [range, setRange] = useState<(typeof RANGES)[number]>('30d');
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]>('day');
  const stats = useOrgStats({ range, bucket });

  if (stats.isPending) {
    return <Loading label="Loading statistics" />;
  }
  if (stats.isError || stats.data === undefined) {
    return (
      <ErrorNotice
        title="Statistics could not be loaded"
        detail={stats.error instanceof Error ? stats.error.message : 'unknown error'}
      />
    );
  }

  const measured = stats.data.metrics.filter((metric) => metric.absent === null);
  const absent = stats.data.metrics.filter((metric) => metric.absent !== null);
  // The path is a literal so that `routes/client-census.test.ts` finds it on disk: a URL built out
  // of pieces is a call the census cannot see, and this endpoint would then be served by nobody's
  // assertion. The origin is prepended because `safeHref` — the only renderer of a URL in this
  // app — takes an absolute http(s) URL.
  const csvPath = `/api/org/stats.csv?range=${range}&bucket=${bucket}`;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Statistics</SectionHeading>

      <Card className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-xs text-fg-muted">Range</span>
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            value={range}
            onChange={(event) => setRange(event.target.value as (typeof RANGES)[number])}
            aria-label="Range"
          >
            {RANGES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-xs text-fg-muted">Bucket</span>
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
            value={bucket}
            onChange={(event) => setBucket(event.target.value as (typeof BUCKETS)[number])}
            aria-label="Bucket"
          >
            {BUCKETS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-fg-muted">
          {stats.data.range.from} to {stats.data.range.to} · {stats.data.range.timezone}
          {stats.data.range.timezone_substituted
            ? ' (the organisation’s timezone setting is not a zone this server can use; days are cut in UTC)'
            : ''}
        </span>
        <ExternalLink
          url={`${window.location.origin}${csvPath}`}
          label="Download CSV"
          className="ml-auto text-accent underline"
        />
      </Card>

      <Card>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {measured.map((metric) => (
            <MetricCard key={metric.id} metric={metric} />
          ))}
        </div>
      </Card>

      <SectionHeading>Returns by stage</SectionHeading>
      {stats.data.returns_by_stage.length === 0 ? (
        <EmptyState
          title="No stage was entered in this range"
          hint="Return rate per stage is returns into a stage divided by entries into it (product/19 §10). With no entries there is nothing to divide, which is not the same as a rate of zero."
        />
      ) : (
        <Card>
          <ul className="flex flex-col gap-2 text-sm">
            {stats.data.returns_by_stage.map((stage) => (
              <li key={stage.stage} className="flex flex-wrap items-center gap-2">
                {/* A stage id comes from the project's own pipeline file (BD-022). */}
                <UntrustedText value={stage.stage} className="font-mono text-xs" />
                <span className="text-fg-muted">
                  {formatInteger(stage.returns)} returns in {formatInteger(stage.entries)} entries
                </span>
                <span className="ml-auto tabular-nums">
                  {stage.rate === null ? 'no entries' : `${(stage.rate * 100).toFixed(1)}%`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SectionHeading>Not measured, and why</SectionHeading>
      <Card>
        <ul className="flex flex-col gap-3 text-sm">
          {absent.map((metric) => (
            <li key={metric.id} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{metric.label}</span>
                <Badge tone="neutral">not measured</Badge>
              </span>
              <span className="text-fg-muted">{metric.absent?.reason}</span>
              <span className="font-mono text-[11px] text-fg-muted">{metric.absent?.owner}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
};
