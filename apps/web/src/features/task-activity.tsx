/**
 * The task page's **Activity** tab: who did what to this task — `GET /api/tasks/:task_id/audit`
 * (WP-31, PROGRESS backlog 52), newest first as the read returns it.
 *
 * WP-30 put the *project's* settings audit on the settings page and a task command's row never
 * appeared on it: `human_actions` has no `project_id` column, so the predicate that page uses
 * (`params->>'project_id'`) matches none of WP-15i's eleven commands or WP-27's three. This is the
 * other half, and it is the read an ask's own answer is built from — one projection, two readers.
 *
 * `org.audit.read` is **maintainer** (Q36), so a member sees a sentence rather than an error: a
 * 403 here is *"you may not read this"*, which is a different fact from a failure (standing rule
 * 18) and is the one thing an `ErrorNotice` would state wrongly. **Only** a 403 (WP-122, backlog
 * 385): a 503 or a 500 was rendered as the same role sentence, so an outage read as a missing role.
 *
 * Each entry's `params` is client-supplied JSON carrying the caller's own `Idempotency-Key`, so it
 * is untrusted like everything else this screen renders (BD-022), and it is raw — collapsed behind
 * *Details* (research/19 § 3 item 6).
 */
import { PersonIcon } from '@primer/octicons-react/PersonIcon';
import type { ReactElement } from 'react';
import { isForbiddenError, readErrorDetail } from '../api/read-error.js';
import { useTaskAudit } from '../app/queries.js';
import { DetailsDisclosure } from '../ui/details.js';
import { EmptyState, ErrorNotice, formatDateTime, Loading, SectionHeading } from '../ui/kit.js';
import { Timeline, TimelineItem } from '../ui/timeline.js';
import { UntrustedText } from '../ui/untrusted.js';

export const TaskActivity = ({ taskId }: { readonly taskId: string }): ReactElement => {
  const audit = useTaskAudit(taskId);
  const items = audit.data?.items ?? [];
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading>Who did what</SectionHeading>
      {audit.isPending ? <Loading label="Loading this task's activity…" /> : null}
      {audit.error === null || audit.error === undefined ? null : isForbiddenError(audit.error) ? (
        <EmptyState
          title="Not shown"
          hint={readErrorDetail(
            audit.error,
            'Every human action on this task is recorded; reading the record needs the maintainer role.',
          )}
        />
      ) : (
        // WP-122 (backlog 385): an outage is not a role. Only a 403 is "not shown"; anything else is
        // a failure, stated as the server stated it.
        <ErrorNotice
          title="This task's activity could not be loaded."
          error={audit.error}
          detail={readErrorDetail(audit.error, 'Reading the record needs the maintainer role.')}
        />
      )}
      {audit.data === undefined || items.length > 0 ? null : (
        <EmptyState
          title="Nothing yet"
          hint="Pausing, answering, approving, retrying and taking over are all recorded here."
        />
      )}
      {items.length === 0 ? null : (
        <Timeline label="Who did what, newest first">
          {items.map((entry) => (
            <TimelineItem
              key={entry.id}
              badge={<PersonIcon size={16} />}
              time={formatDateTime(entry.created_at)}
            >
              <p>
                <span className="font-medium">{entry.action}</span>
                <span className="text-fg-muted">{` by ${entry.user_id ?? 'unknown user'}`}</span>
              </p>
              <DetailsDisclosure summary="Details">
                <UntrustedText className="text-xs break-all" value={JSON.stringify(entry.params)} />
              </DetailsDisclosure>
            </TimelineItem>
          ))}
        </Timeline>
      )}
    </div>
  );
};
