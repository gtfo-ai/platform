/**
 * The audit log (product/10 § "Audit log"): a filterable stream of configuration changes.
 *
 * `GET /api/org/audit` is one of the three endpoints `apps/server` actually serves today, and its
 * cursor is the ISO timestamp the previous page returned. The `diff` column is opaque JSON in
 * which a secret appears as the literal string `"changed"` — the server's job, not this screen's —
 * and it is rendered as text like everything else.
 */
import { type ReactElement, useState } from 'react';
import { useAudit } from '../app/queries.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { JsonView, UntrustedText } from '../ui/untrusted.js';

export const AuditScreen = (): ReactElement => {
  const [entityType, setEntityType] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const filters = {
    ...(entityType.trim() === '' ? {} : { entity_type: entityType.trim() }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  const audit = useAudit(filters);
  const nextCursor = audit.data?.next_cursor ?? null;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading
        actions={
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setCursor(undefined);
            }}
          >
            <input
              aria-label="Filter by entity type"
              value={entityType}
              onChange={(event) => {
                setEntityType(event.target.value);
              }}
              placeholder="entity type"
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            />
            <Button type="submit">Filter</Button>
          </form>
        }
      >
        Audit log
      </SectionHeading>

      {audit.isPending ? <Loading label="Loading audit entries…" /> : null}
      {audit.isError ? (
        <ErrorNotice title="The audit log could not be loaded." detail={String(audit.error)} />
      ) : null}
      {audit.isSuccess && audit.data.items.length === 0 ? (
        <EmptyState
          title="No audit entries"
          hint="Every configuration change and every human action is recorded here. An empty log means nothing has been changed on this instance yet."
        />
      ) : null}

      <ul className="flex flex-col gap-2">
        {(audit.data?.items ?? []).map((entry) => (
          <li key={entry.id}>
            <Card className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono font-semibold">
                  <UntrustedText value={entry.entity_type} />
                </span>
                {entry.entity_id === null ? null : (
                  <span className="font-mono text-fg-muted">
                    <UntrustedText value={entry.entity_id} />
                  </span>
                )}
                <span className="ml-auto text-fg-muted">{formatDateTime(entry.created_at)}</span>
              </div>
              <JsonView value={entry.diff} />
            </Card>
          </li>
        ))}
      </ul>

      {nextCursor === null ? null : (
        <Button
          onClick={() => {
            setCursor(nextCursor);
          }}
        >
          Load older entries
        </Button>
      )}
    </div>
  );
};
