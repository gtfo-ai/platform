/**
 * Failed background jobs (*Failed jobs* until S-25.6) — the jobs pg-boss gave up on after their
 * last retry (WP-108, PROGRESS backlog 325).
 *
 * The dead letters above are the **event** queue's; these are the **job** queue's: a stage run, a
 * provider call, a timer or a schedule whose handler threw on every attempt its queue allows. Until
 * WP-108 they had no list, no count and no audit row. Each card says which queue, how often it was
 * tried, why it failed, and — from the platform's census of its queues — what such a failure drops
 * and what, if anything, recovers it. Since WP-124 that last sentence is read off the queue's
 * declared **shape** (a recovery row, bound-and-escalate, or listed only) rather than off whether a
 * recovery is named.
 *
 * It is a **read**: there is no re-queue, because not every queue's handler has been shown to
 * re-validate on fire. What a failed job left is the recovery pass's (where the card names a row of
 * it) or a person's.
 *
 * Everything shown is text: the error is a handler's message, redacted and bounded by the server and
 * rendered through `UntrustedText` (BD-022). The queue is said in words (S-25.20,
 * `ui/words/job-queues.ts`); a queue this build no longer declares is exactly what may be listed, so
 * its name is kept, as text. A job whose payload names a task that exists links it (S-25.20). Admin only on the server; a non-admin
 * sees the refusal named rather than an empty list that would read as "nothing failed" (and only a
 * 403 is named so). Newest first, a page at a time; *Show older* follows the server's keyset
 * `next_cursor` to the oldest (WP-114, PROGRESS backlog 324).
 */
import type { FailedJob } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { readErrorDetail } from '../api/read-error.js';
import { useFailedJobs } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  formatInteger,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { jobQueueLabel } from '../ui/words/job-queues.js';

/**
 * What recovers a failed job, from its queue's declared shape (TD-004's M7 amendment, WP-124):
 * a recovery row finds what it left, its last try escalated its task, or it is listed only because
 * the next transition (or tick) re-derives the effect. `pipeline.outbound`'s duties differ, and
 * this list never reads a payload, so its card names every duty's answer.
 */
const recoveryLine = (job: FailedJob): string => {
  if (job.exhaustion === null) {
    return 'This build does not declare that queue, so what its failure costs is not known here.';
  }
  const { shape, recovered_by: recoveredBy } = job.exhaustion;
  switch (shape) {
    case 'recovery_row':
      return `The platform’s recovery pass finds what it left and tries once more, then makes it visible: ${recoveredBy ?? 'its row'}.`;
    case 'bound_and_escalate':
      return job.task === null
        ? 'Its last try escalated the task it carried, with a brief on the task page — or, for a task already finished, an escalation message to its people. Act on the task.'
        : 'Its last try escalated the task it carried, with a brief on the task page — or, for a task already finished, an escalation message to its people. Act on the task, linked below.';
    case 'per_duty':
      return `What recovers it depends on the duty it carried, which this list does not read: ${recoveredBy ?? 'see the census'}.`;
    case 'notification_shaped':
      return recoveredBy === 'next_tick'
        ? 'Its schedule runs again on its next tick, which redoes the work.'
        : 'Listed only: the next transition re-derives what it was for, or what it dropped was a notification. Nothing re-runs it.';
  }
};

/** The queue in words (S-25.20); a queue this build does not name keeps its name, as text. */
const QueueName = ({ queue }: { readonly queue: string }): ReactElement => {
  const label = jobQueueLabel(queue);
  return label === null ? (
    <span data-failed-job-queue="unnamed">
      {'A job this build doesn’t name ('}
      <UntrustedText value={queue} />)
    </span>
  ) : (
    <span className="font-medium" data-failed-job-queue={queue}>
      {label}
    </span>
  );
};

const FailedJobCard = ({ job }: { readonly job: FailedJob }): ReactElement => (
  <Card className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge tone="danger">failed</Badge>
      <QueueName queue={job.queue} />
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
    {/* S-25.20: the task the job carried, when it names one that exists — the one to act on. */}
    {job.task === null ? null : (
      <p className="text-xs" data-failed-job-task={job.task.id}>
        {'Its task: '}
        <Link
          to="/projects/$key/tasks/$taskId"
          params={{ key: job.task.project_key, taskId: job.task.id }}
          className="text-accent underline"
        >
          <UntrustedText value={job.task.ticket_key} />
        </Link>
      </p>
    )}
  </Card>
);

export const FailedJobs = (): ReactElement => {
  const jobs = useFailedJobs();
  const pages = jobs.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const total = pages.at(-1)?.total ?? 0;
  return (
    <section>
      <SectionHeading>Failed background jobs</SectionHeading>
      <p className="pb-2 text-xs text-fg-muted">
        Jobs whose handler failed on every attempt its queue allows. This list is a read — there is
        no re-queue here — and the job queue keeps a failed job only for its retention window, days
        rather than for ever.
      </p>
      {jobs.isPending ? <Loading label="Loading failed jobs…" /> : null}
      {/* A failed *Show older* also sets `isError` (TanStack Query v5): the page above it did load. */}
      {jobs.isError && !jobs.isFetchNextPageError ? (
        <ErrorNotice
          title="The failed jobs could not be loaded."
          // Only a 403 is the role (backlog 327, `readErrorDetail`).
          error={jobs.error}
          detail={readErrorDetail(jobs.error, 'Reading them needs the admin role.')}
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
          {items.length >= total && !jobs.hasNextPage
            ? `${formatInteger(total)} failed job${total === 1 ? '' : 's'}.`
            : `The newest ${formatInteger(items.length)} of ${formatInteger(total)} failed jobs.`}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {items.map((job) => (
          <div key={job.id} data-failed-job={job.id}>
            <FailedJobCard job={job} />
          </div>
        ))}
      </div>
      {/* WP-114, backlog 324: the server pages with a keyset cursor, so the list reaches its oldest. */}
      {jobs.hasNextPage ? (
        <div className="pt-2">
          <Button
            disabled={jobs.isFetchingNextPage}
            onClick={() => {
              void jobs.fetchNextPage();
            }}
          >
            {jobs.isFetchingNextPage ? 'Loading older…' : 'Show older'}
          </Button>
        </div>
      ) : null}
      {jobs.isFetchNextPageError ? (
        <ErrorNotice
          title="The older failed jobs could not be loaded."
          error={jobs.error}
          detail={readErrorDetail(jobs.error, 'Reading them needs the admin role.')}
        />
      ) : null}
    </section>
  );
};
