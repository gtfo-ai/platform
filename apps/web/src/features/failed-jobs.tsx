/**
 * Failed jobs — the jobs pg-boss gave up on after their last retry (WP-108, PROGRESS backlog 325).
 *
 * The dead letters above are the **event** queue's; these are the **job** queue's: a stage run, a
 * provider call, a timer or a schedule whose handler threw on every attempt its queue allows. Until
 * WP-108 they had no list, no count and no audit row. Each card says which queue, how often it was
 * tried, why it failed, and — from the platform's census of its queues — what such a failure drops
 * and what, if anything, recovers it.
 *
 * It is a **read**: there is no re-queue, because not every queue's handler has been shown to
 * re-validate on fire. What a failed job left is the recovery pass's (where the card names a row of
 * it) or a person's.
 *
 * Everything shown is text: the error is a handler's message, redacted and bounded by the server and
 * rendered through `UntrustedText` (BD-022); the queue name is rendered the same way, because a queue
 * this build no longer declares is exactly what may be listed. Admin only on the server; a non-admin
 * sees the refusal named rather than an empty list that would read as "nothing failed".
 */
import type { FailedJob } from '@platform/contracts';
import type { ReactElement } from 'react';
import { ApiError } from '../api/http.js';
import { useFailedJobs } from '../app/queries.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  formatInteger,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

const recoveryLine = (job: FailedJob): string => {
  if (job.exhaustion === null) {
    return 'This build does not declare that queue, so what its failure costs is not known here.';
  }
  const { recovered_by: recoveredBy } = job.exhaustion;
  if (recoveredBy === null) {
    return 'Nothing recovers it automatically: look at what it was for, and act on it by hand.';
  }
  if (recoveredBy === 'next_tick') {
    return 'Its schedule runs again on its next tick, which redoes the work.';
  }
  return `Recovered by the platform’s recovery pass: ${recoveredBy}.`;
};

const FailedJobCard = ({ job }: { readonly job: FailedJob }): ReactElement => (
  <Card className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge tone="danger">failed</Badge>
      <span className="font-mono">
        <UntrustedText value={job.queue} />
      </span>
      <span className="text-fg-muted">
        tried {formatInteger(job.attempts)} time{job.attempts === 1 ? '' : 's'} (retry limit{' '}
        {formatInteger(job.retry_limit)})
      </span>
      <span className="ml-auto text-fg-muted">failed {formatDateTime(job.failed_at)}</span>
    </div>
    {job.error === null ? (
      <p className="text-xs text-fg-muted">The failure recorded no message.</p>
    ) : (
      <p className="text-xs">
        <UntrustedText value={job.error} />
        {job.error_truncated ? (
          <span className="text-fg-muted"> (cut at the bound; the log has the rest)</span>
        ) : null}
      </p>
    )}
    {job.exhaustion === null ? null : (
      <p className="text-xs">
        {job.exhaustion.kind === 'bounds_itself'
          ? 'This queue ends its own failures; this one got past that bound. '
          : 'This queue relies on its retries, and they are spent. '}
        What it drops: <UntrustedText value={job.exhaustion.loss} />
      </p>
    )}
    <p className="text-xs text-fg-muted" data-failed-job-recovery="true">
      {recoveryLine(job)}
    </p>
  </Card>
);

export const FailedJobs = (): ReactElement => {
  const jobs = useFailedJobs();
  const items = jobs.data?.items ?? [];
  return (
    <section>
      <SectionHeading>Failed jobs</SectionHeading>
      <p className="pb-2 text-xs text-fg-muted">
        Jobs whose handler failed on every attempt its queue allows. This list is a read — there is
        no re-queue here — and the job queue keeps a failed job only for its retention window, days
        rather than for ever.
      </p>
      {jobs.isPending ? <Loading label="Loading failed jobs…" /> : null}
      {jobs.isError ? (
        <ErrorNotice
          title="The failed jobs could not be loaded."
          detail={
            // Only a 403 is the role (the dead-letter section's sentence is backlog 327's defect).
            jobs.error instanceof ApiError && jobs.error.status === 403
              ? 'Reading them needs the admin role.'
              : String(jobs.error)
          }
        />
      ) : null}
      {jobs.isSuccess && items.length === 0 ? (
        <EmptyState
          title="No failed jobs"
          hint="Every job either succeeded or is still within its retries."
        />
      ) : null}
      {jobs.isSuccess && items.length > 0 ? (
        <p className="pb-2 text-xs" data-failed-job-count="true">
          {items.length === jobs.data.total
            ? `${formatInteger(jobs.data.total)} failed job${jobs.data.total === 1 ? '' : 's'}.`
            : `The newest ${formatInteger(items.length)} of ${formatInteger(jobs.data.total)} failed jobs.`}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {items.map((job) => (
          <div key={job.id} data-failed-job={job.id}>
            <FailedJobCard job={job} />
          </div>
        ))}
      </div>
    </section>
  );
};
