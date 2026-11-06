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
 *  - a metric with `absent` is drawn under *"Not measured, and why"* — one collapsed disclosure
 *    since S-23.11b — with the owner;
 *  - a metric whose `value` is `null` and which is **not** absent prints a muted dash with *"No
 *    data in this range"* under it, which is a different statement from `0` — the first is nothing
 *    to divide, the second is a measurement (standing rule 18);
 *  - every number carries its definition in a tooltip (product/10:63) and its **caveats** in one
 *    *"How these are measured"* disclosure at the foot of the page, because reviewer minutes
 *    over-count on bots and under-count on approvals and the two do not cancel (PROGRESS backlog
 *    88, 89, 90). They were yellow paragraphs under each value until S-23.19.
 *
 * ## The layout (S-23.19, the owner's "definitely not good UX")
 *
 * Eight cramped columns in one strip became **sections with headings** — Throughput, Quality,
 * Cost, Time, then the rest of the catalogue (`STAT_SECTIONS`) — each a grid of compact cards, four
 * per row at 1280 px and up, two on a tablet, one on a phone. A card is the value large, its label
 * (the tooltip trigger), its reading — *"Lower is better"* (S-25.7, research/21 F15) — one muted
 * *"From 12 delivered tasks"* line saying what the figure counts and, when the buckets carry at
 * least two values, a sparkline with the same facts as text for a screen reader. The range is
 * written as every other screen writes a date (*"Sep 10, 2026"*).
 *
 * ## Everything here is platform text, and it is still rendered as text
 *
 * The only string on this screen that did not come from this repository is a **stage id**, which a
 * project's own pipeline file names (BD-022). It goes through `UntrustedText` like every other
 * outside string; nothing on this screen becomes markup, and the CSV link is an `ExternalLink`
 * because that component is the only place in this application allowed to write a URL attribute.
 */
import type { StatBucketSize, StatMetric } from '@platform/contracts';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { useOrgStats } from '../app/queries.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { DetailsDisclosure } from '../ui/details.js';
import { stageLabel } from '../ui/humanize.js';
import { ErrorNotice, formatInteger, Metric } from '../ui/kit.js';
import { ListBox, ListRow } from '../ui/list-box.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { Sparkline } from '../ui/sparkline.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import {
  formatCivilDate,
  formatSamples,
  formatStatValue,
  groupIntoSections,
  SPARK_HEIGHT,
  SPARK_WIDTH,
  sparklineSegments,
  statReadingWords,
  trendSummary,
} from './statistics-format.js';

const RANGES = ['7d', '30d', '90d', '365d'] as const;
const BUCKETS = ['day', 'week', 'month'] as const;

const RANGE_LABEL: Readonly<Record<(typeof RANGES)[number], string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '365d': 'Last 365 days',
};

const BUCKET_LABEL: Readonly<Record<(typeof BUCKETS)[number], string>> = {
  day: 'By day',
  week: 'By week',
  month: 'By month',
};

const SELECT_CLASS = 'rounded-md border border-line-input bg-inset px-2 py-1 text-sm';

/**
 * One metric card: the value large, the label with its definition, one muted line, a sparkline.
 *
 * A `null` value is a muted dash and the sentence under it — never a number, and never the
 * sentence in the value's own size, which read as a headline (S-23.19).
 */
const MetricCard = ({
  metric,
  bucket,
}: {
  readonly metric: StatMetric;
  readonly bucket: StatBucketSize;
}): ReactElement => {
  const formatted = formatStatValue(metric.value, metric.unit);
  const segments = sparklineSegments(metric.buckets);
  const summary = trendSummary(metric.buckets, metric.unit, bucket);
  return (
    <li
      data-metric-card={metric.id}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-default p-4"
    >
      <Metric
        label={metric.label}
        size="lg"
        value={
          formatted === null ? (
            // The sentence under the value says what the dash means, so the dash is not read out.
            <span className="text-fg-muted" aria-hidden="true">
              —
            </span>
          ) : (
            formatted
          )
        }
        definition={metric.definition}
      />
      {/* Which way is good (research/21 F15), then what the figure is from. */}
      <span className="text-xs text-fg-muted" data-metric-reading="">
        {statReadingWords(metric.id)}
      </span>
      <span className="text-xs text-fg-muted">
        {formatted === null ? 'No data in this range' : formatSamples(metric.id, metric.samples)}
      </span>
      {segments === null || summary === null ? null : (
        <Sparkline
          segments={segments}
          summary={summary}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          className="mt-auto pt-1"
        />
      )}
    </li>
  );
};

const MetricSection = ({
  title,
  metrics,
  bucket,
}: {
  readonly title: string;
  readonly metrics: readonly StatMetric[];
  readonly bucket: StatBucketSize;
}): ReactElement => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {title}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <MetricCard key={metric.id} metric={metric} bucket={bucket} />
        ))}
      </ul>
    </section>
  );
};

export const StatisticsScreen = (): ReactElement => {
  const [range, setRange] = useState<(typeof RANGES)[number]>('30d');
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]>('day');
  const stats = useOrgStats({ range, bucket });

  if (stats.isPending) {
    return <Skeleton label="Loading statistics" lines={4} />;
  }
  if (stats.isError || stats.data === undefined) {
    return (
      <ErrorNotice
        title="Statistics could not be loaded"
        error={stats.error}
        detail={stats.error instanceof Error ? stats.error.message : 'unknown error'}
      />
    );
  }

  const measured = stats.data.metrics.filter((metric) => metric.absent === null);
  const absent = stats.data.metrics.filter((metric) => metric.absent !== null);
  const caveated = measured.filter((metric) => metric.caveats.length > 0);
  const sections = groupIntoSections(measured);
  // The path is a literal so that `routes/client-census.test.ts` finds it on disk: a URL built out
  // of pieces is a call the census cannot see, and this endpoint would then be served by nobody's
  // assertion. The origin is prepended because `safeHref` — the only renderer of a URL in this
  // app — takes an absolute http(s) URL.
  const csvPath = `/api/org/stats.csv?range=${range}&bucket=${bucket}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Statistics"
        meta={
          <span>
            {formatCivilDate(stats.data.range.from)} to {formatCivilDate(stats.data.range.to)} ·{' '}
            {stats.data.range.timezone}
            {stats.data.range.timezone_substituted
              ? ' (the organisation’s timezone setting is not a zone this server can use; days are cut in UTC)'
              : ''}
          </span>
        }
        actions={
          <>
            <select
              className={SELECT_CLASS}
              value={range}
              onChange={(event) => setRange(event.target.value as (typeof RANGES)[number])}
              aria-label="Range"
            >
              {RANGES.map((option) => (
                <option key={option} value={option}>
                  {RANGE_LABEL[option]}
                </option>
              ))}
            </select>
            <select
              className={SELECT_CLASS}
              value={bucket}
              onChange={(event) => setBucket(event.target.value as (typeof BUCKETS)[number])}
              aria-label="Granularity"
            >
              {BUCKETS.map((option) => (
                <option key={option} value={option}>
                  {BUCKET_LABEL[option]}
                </option>
              ))}
            </select>
            <ExternalLink
              url={`${window.location.origin}${csvPath}`}
              label="Download CSV"
              className={buttonClassName('default', 'sm')}
            />
          </>
        }
      />

      {sections.map((section) => (
        <MetricSection
          key={section.title}
          title={section.title}
          metrics={section.metrics}
          bucket={stats.data.range.bucket}
        />
      ))}

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Returns by stage</h2>
        {stats.data.returns_by_stage.length === 0 ? (
          <Blankslate
            informational
            title="No stage was entered in this range"
            hint="Return rate per stage is returns into a stage divided by entries into it. With no entries there is nothing to divide, which is not the same as a rate of zero."
          />
        ) : (
          <ListBox label="Returns by stage">
            {stats.data.returns_by_stage.map((stage) => (
              <ListRow
                key={stage.stage}
                // A stage id comes from the project's own pipeline file (BD-022): its word is the
                // shipped stage's, or the slug title-cased, rendered as text.
                title={<UntrustedText value={stageLabel(stage.stage)} />}
                meta={`${formatInteger(stage.returns)} ${stage.returns === 1 ? 'return' : 'returns'} in ${formatInteger(stage.entries)} ${stage.entries === 1 ? 'entry' : 'entries'}`}
                trailing={
                  <span className="text-sm text-fg tabular-nums">
                    {stage.rate === null ? 'no entries' : formatStatValue(stage.rate, 'ratio')}
                  </span>
                }
              />
            ))}
          </ListBox>
        )}
      </section>

      <div className="flex flex-col gap-1">
        {caveated.length === 0 ? null : (
          <DetailsDisclosure summary="How these are measured" className="flex flex-col">
            <ul className="flex flex-col gap-3 text-sm">
              {caveated.map((metric) => (
                <li key={metric.id} className="flex flex-col gap-1">
                  <span className="font-medium text-fg">{metric.label}</span>
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-fg-muted">
                    {metric.caveats.map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </DetailsDisclosure>
        )}
        {absent.length === 0 ? null : (
          <DetailsDisclosure
            summary={`Not measured, and why (${formatInteger(absent.length)})`}
            className="flex flex-col"
          >
            <ul className="flex flex-col gap-3 text-sm">
              {absent.map((metric) => (
                <li key={metric.id} className="flex flex-col gap-1">
                  <span className="font-medium text-fg">{metric.label}</span>
                  <span className="text-fg-muted">{metric.absent?.reason}</span>
                  <span className="text-xs text-fg-muted">{metric.absent?.owner}</span>
                </li>
              ))}
            </ul>
          </DetailsDisclosure>
        )}
      </div>
    </div>
  );
};
