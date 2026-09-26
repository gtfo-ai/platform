/**
 * The epic split's acceptance panel — product/04:117's *"a proposed ticket breakdown with acceptance
 * criteria for the PM to accept"* (WP-44, PROGRESS backlog 108 (a); Q85's surface half).
 *
 * WP-40 built the whole server feature — the queue (`ticket_breakdown_items`), the decision, the
 * `createTicket` duty — and touched no screen, so the only way a PM could accept a breakdown was an
 * HTTP client. This is Q85's recommended surface: **the queue as it comes back**, one row per
 * proposed child with its acceptance criteria, its state and a rejected row's reason; **a checkbox
 * per child**; and **one button** per decision, so accepting five of seven is one request.
 *
 * ## Who sees the control
 *
 * The decision is `task.approve_plan` (maintainer), and the read says whether **this caller** holds
 * it (`can_decide`, the server's own `can()` over the effective role). A member and a viewer see the
 * queue and **no** control — never a button that answers 403. The server checks again either way.
 *
 * ## Accepting files tickets in somebody else's tracker
 *
 * The button says so, because it is the largest external write this platform makes (Q85). The
 * request carries the SPA's **per-intent** `Idempotency-Key` (`app/idempotency.ts`): the route
 * requires one, and a repeat under a used key answers from the first attempt rather than filing a
 * second set of tickets. A different selection is a different intent and a different key.
 *
 * Everything on a row is untrusted (BD-022): the title, description, rationale and criteria are
 * model output over an untrusted epic, the reason is a person's words, and the ticket URL is what a
 * provider answered. Text goes through `UntrustedText`/`UntrustedProse`; the URL through
 * `ExternalLink`.
 */
import type { TicketBreakdownItem } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import { useBreakdownDecision, useTaskBreakdown } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedProse, UntrustedText } from '../ui/untrusted.js';

const STATUS_TONE = {
  queued: 'neutral',
  accepted: 'success',
  rejected: 'danger',
} as const;

const ChildRow = ({
  item,
  selectable,
  checked,
  onToggle,
}: {
  readonly item: TicketBreakdownItem;
  readonly selectable: boolean;
  readonly checked: boolean;
  readonly onToggle: (checked: boolean) => void;
}): ReactElement => (
  <Card className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      {selectable ? (
        <input
          type="checkbox"
          aria-label={`Select child ${item.position + 1}`}
          checked={checked}
          onChange={(event) => {
            onToggle(event.target.checked);
          }}
        />
      ) : null}
      <span className="text-sm font-medium">
        <UntrustedText value={item.title} />
      </span>
      <Badge>{item.size}</Badge>
      <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>
      {item.ticket_url === null ? null : (
        <ExternalLink
          url={item.ticket_url}
          label={item.ticket_key ?? 'Ticket'}
          className="ml-auto text-xs text-accent underline"
        />
      )}
      {item.status === 'accepted' && item.ticket_key === null ? (
        <span className="ml-auto text-xs text-fg-muted">
          accepted — the ticket is not filed yet
        </span>
      ) : null}
    </div>
    <UntrustedProse value={item.description} />
    {item.acceptance_criteria.length === 0 ? null : (
      <ul className="list-disc pl-5 text-xs">
        {item.acceptance_criteria.map((criterion) => (
          <li key={criterion.id}>
            <UntrustedText
              value={`Given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`}
            />
          </li>
        ))}
      </ul>
    )}
    <p className="text-xs text-fg-muted">
      <UntrustedText value={item.rationale} />
    </p>
    {item.reason === null ? null : (
      <p className="text-xs">
        {item.status === 'rejected' ? 'Rejected: ' : 'Decided: '}
        <UntrustedText value={item.reason} />
      </p>
    )}
  </Card>
);

/**
 * The panel, rendered only on an epic-split task. `enabled` keeps a feature or bug task from
 * asking for a queue it cannot have.
 */
export const BreakdownPanel = ({
  taskId,
  enabled,
}: {
  readonly taskId: string;
  readonly enabled: boolean;
}): ReactElement | null => {
  const breakdown = useTaskBreakdown(taskId, enabled);
  const decide = useBreakdownDecision(taskId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState('');

  if (!enabled) {
    return null;
  }
  if (breakdown.isPending) {
    return <Loading label="Loading the proposed breakdown…" />;
  }
  if (breakdown.isError) {
    return (
      <ErrorNotice
        title="The proposed breakdown could not be loaded."
        detail={String(breakdown.error)}
      />
    );
  }
  const { items, can_decide: canDecide } = breakdown.data;
  const queued = items.filter((item) => item.status === 'queued');
  const chosen = queued.filter((item) => selected.has(item.id)).map((item) => item.id);

  const submit = (decision: 'accept' | 'reject'): void => {
    decide.mutate(
      { decision, itemIds: chosen, reason: reason.trim() },
      {
        onSuccess: () => {
          setSelected(new Set());
          setReason('');
        },
      },
    );
  };

  return (
    <div>
      <SectionHeading>Proposed breakdown</SectionHeading>
      {items.length === 0 ? (
        <EmptyState
          title="No breakdown yet"
          hint="The epic split proposes its child tickets when its run finishes; they appear here for a maintainer to accept or reject, one by one."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <ChildRow
              key={item.id}
              item={item}
              selectable={canDecide && item.status === 'queued'}
              checked={selected.has(item.id)}
              onToggle={(checked) => {
                const next = new Set(selected);
                if (checked) {
                  next.add(item.id);
                } else {
                  next.delete(item.id);
                }
                setSelected(next);
              }}
            />
          ))}
          {canDecide && queued.length > 0 ? (
            <Card className="flex flex-col gap-2">
              <input
                aria-label="Why (optional)"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                placeholder="Why (optional, kept on the rows you decide)"
                className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  tone="primary"
                  disabled={decide.isPending || chosen.length === 0}
                  onClick={() => {
                    submit('accept');
                  }}
                >
                  {`Accept ${chosen.length} — creates ${chosen.length === 1 ? 'a ticket' : 'tickets'} in your tracker`}
                </Button>
                <Button
                  tone="danger"
                  disabled={decide.isPending || chosen.length === 0}
                  onClick={() => {
                    submit('reject');
                  }}
                >
                  {`Reject ${chosen.length}`}
                </Button>
                <span className="text-xs text-fg-muted">{`${queued.length} waiting`}</span>
              </div>
              {decide.isError ? (
                <ErrorNotice title="That decision was refused." detail={String(decide.error)} />
              ) : null}
            </Card>
          ) : null}
          {!canDecide && queued.length > 0 ? (
            <p className="text-xs text-fg-muted">
              Accepting or rejecting a proposed child needs the maintainer role in this project.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
};
