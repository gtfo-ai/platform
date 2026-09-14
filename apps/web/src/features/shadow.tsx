/**
 * The Shadow screen — product/10:20's *"Shadow — shadow-mode runs: comparison with the human MR,
 * predicted cost, similarity"* (WP-34).
 *
 * Three panels, and the order is the order a founder reads them in: **start a batch**, **the
 * batches**, and **one batch's tickets with its aggregate** (product/19 §13's cost-by-size,
 * similarity distribution and launch candidates).
 *
 * ## Everything on this screen is untrusted, and none of it becomes markup
 *
 * A ticket key, a merge request's URL, the platform's notes and the refusal sentences all arrive
 * from outside (BD-022). Every one of them is rendered as a React text node through
 * `ui/untrusted.tsx`, and the merge request's URL goes through `ExternalLink`, which is the only
 * place in this application allowed to write a URL attribute (`no-html.test.ts` enforces both).
 * The merge request's **title** is not among them and this docblock used to say it was: the DTO is
 * a `MergeRequestRef` (provider, project path, iid, url, branch, head sha) and carries none, so the
 * link is labelled with its iid (WP-34 review round 2).
 *
 * ## Four nulls, four sentences
 *
 * The hardest thing on this screen is saying *why* a number is missing, and there are four
 * different reasons a ticket has no similarity:
 *
 *  1. it was **refused** before it became a task (Q82 (a): no comparison base);
 *  2. its task is **still running**, so no report exists yet;
 *  3. it has **no human merge request**, so there is nothing to compare against;
 *  4. the shadow run produced **no merge request of its own**, so the platform has no diff to
 *     measure.
 *
 * Each gets its own sentence rather than an em dash, because "we have not measured this yet" and
 * "there is nothing to measure" are different facts about a project (standing rule 18). The report
 * carries `notes`, which is the platform's own prose about the third and fourth.
 */
import type { ShadowBatchTicket } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  useProjectByKey,
  useShadowBatch,
  useShadowBatches,
  useShadowCommands,
} from '../app/queries.js';
import { useTopics } from '../realtime/provider.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  formatDateTime,
  formatInteger,
  formatMinutes,
  formatUsd,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedProse, UntrustedText } from '../ui/untrusted.js';

/** `0.42` → `42 %`, the one place this screen turns a unit interval into a percentage. */
const percent = (value: number): string => `${Math.round(value * 100)} %`;

/**
 * Why this ticket has no similarity figure — the four cases above, in the order they can occur.
 *
 * Returns `null` when there *is* a figure, so the caller's branch is the same shape as the data.
 */
export const missingSimilarityReason = (ticket: ShadowBatchTicket): string | null => {
  if (ticket.similarity !== null) {
    return null;
  }
  if (ticket.refused_reason !== null) {
    return 'not run';
  }
  if (ticket.report === null) {
    return 'still running';
  }
  if (ticket.human_mr === null) {
    return 'no human merge request to compare with';
  }
  return 'this run produced no merge request, so there is no diff to compare';
};

const TicketRow = ({ ticket }: { readonly ticket: ShadowBatchTicket }): ReactElement => {
  const missing = missingSimilarityReason(ticket);
  return (
    <li className="flex flex-col gap-1 border-line border-b py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ticket.refused_reason === null ? 'neutral' : 'warning'}>
          <UntrustedText value={ticket.ticket_key} />
        </Badge>
        {ticket.task_id === null ? null : (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: ticket.task_id }}
            className="text-xs underline"
          >
            open the task
          </Link>
        )}
        {ticket.task_state === null ? null : (
          <span className="text-fg-muted text-xs">
            <UntrustedText value={ticket.task_state} />
          </span>
        )}
        {ticket.size === null ? null : <Badge>{ticket.size}</Badge>}
      </div>

      {ticket.refused_reason === null ? null : (
        <p className="text-fg-muted text-xs">
          Not run: <UntrustedText value={ticket.refused_reason} />
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span>
          similarity:{' '}
          {missing === null ? (
            <strong>{percent(ticket.similarity as number)}</strong>
          ) : (
            <span className="text-fg-muted">{missing}</span>
          )}
        </span>
        <span>cost: {formatUsd(ticket.cost_usd)}</span>
        <span>
          estimate:{' '}
          {ticket.predicted_cost_usd === null
            ? 'not estimated'
            : formatUsd(ticket.predicted_cost_usd)}
        </span>
        {ticket.human_mr === null ? (
          <span className="text-fg-muted">no human merge request</span>
        ) : (
          <ExternalLink
            url={ticket.human_mr.url}
            label={`human MR !${ticket.human_mr.iid}`}
            className="underline"
          />
        )}
        {ticket.human_mr_source === null ? null : (
          <span className="text-fg-muted">
            found by{' '}
            {ticket.human_mr_source === 'ticket_link' ? 'a link on the ticket' : 'a title scan'}
          </span>
        )}
      </div>

      {ticket.report === null ? null : (
        <div className="flex flex-wrap items-center gap-3 text-fg-muted text-xs">
          {ticket.report.overlap == null ? null : (
            <>
              <span>
                size ratio:{' '}
                {ticket.report.overlap.size_ratio == null ? (
                  // `null`, not `0.00`: the human side has no counted line to divide by — a merge
                  // request whose patches the provider did not render, or one that changed none.
                  // The report's notes below say which (standing rule 16).
                  <span className="text-fg-muted">no countable human lines</span>
                ) : (
                  ticket.report.overlap.size_ratio.toFixed(2)
                )}
              </span>
              <span>
                tests: {formatInteger(ticket.report.overlap.agent_test_files)} vs{' '}
                {formatInteger(ticket.report.overlap.human_test_files)}
              </span>
            </>
          )}
          {ticket.report.reviewer_minutes_estimate == null ? null : (
            <span>
              reviewer minutes (estimate): {formatMinutes(ticket.report.reviewer_minutes_estimate)}
            </span>
          )}
        </div>
      )}
      {ticket.report === null || ticket.report.notes === '' ? null : (
        <UntrustedProse className="text-fg-muted text-xs" value={ticket.report.notes} />
      )}
    </li>
  );
};

const Aggregate = ({
  batchId,
  projectId,
}: {
  readonly batchId: string;
  readonly projectId: string;
}) => {
  const batch = useShadowBatch(projectId, batchId);
  if (batch.isPending) {
    return <Loading label="Loading the batch" />;
  }
  if (batch.error !== null) {
    return <ErrorNotice title="This batch could not be loaded." detail={String(batch.error)} />;
  }
  const data = batch.data;
  if (data === undefined) {
    return <EmptyState title="No batch" hint="This batch is not readable by this build." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap gap-6">
        <Metric
          label="Tickets"
          value={formatInteger(data.batch.tickets)}
          definition="Ticket keys this batch was started with, including the ones the platform refused to run."
        />
        <Metric
          label="Refused"
          value={formatInteger(data.batch.refused)}
          definition="Tickets that never became a task: no merge base for the human merge request, an unknown key, or a shadow task that already existed."
        />
        <Metric
          label="Reported"
          value={formatInteger(data.aggregate.reported)}
          definition="Tasks of this batch that have finished and produced a shadow report."
        />
        <Metric
          label="Compared"
          value={formatInteger(data.aggregate.compared)}
          definition="Reported tasks whose report carries an overlap — both the agent's diff and the human merge request's were read."
        />
        <Metric
          label="Spent"
          value={formatUsd(data.batch.spent_usd)}
          definition="Recorded cost of this batch's tasks, summed from each task's running total."
        />
        <Metric
          label="Budget"
          value={data.batch.budget_usd === null ? 'not set' : formatUsd(data.batch.budget_usd)}
          definition="features.shadow_mode.budget_usd as it stood when this batch was created; a new run stops when the month's shadow spend reaches it."
        />
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionHeading>Cost per ticket by size</SectionHeading>
        {data.aggregate.cost_by_size.length === 0 ? (
          <EmptyState
            title="No sized ticket has finished yet"
            hint="A size comes from the plan a shadow run produced, so this table fills in as the batch works through its tickets."
          />
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {data.aggregate.cost_by_size.map((row) => (
              <li key={row.size} className="flex flex-wrap gap-3">
                <Badge>{row.size}</Badge>
                <span>{formatInteger(row.tickets)} ticket(s)</span>
                <span>median cost {formatUsd(row.median_cost_usd)}</span>
                <span>
                  median estimate{' '}
                  {row.median_predicted_cost_usd === null
                    ? 'not estimated'
                    : formatUsd(row.median_predicted_cost_usd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionHeading>Similarity distribution</SectionHeading>
        <ul className="flex flex-col gap-1 text-xs">
          {data.aggregate.similarity_distribution.map((bucket) => (
            <li key={bucket.from} className="flex items-center gap-3">
              <span className="w-24">
                {percent(bucket.from)}–{percent(bucket.to)}
              </span>
              <span>{formatInteger(bucket.tickets)}</span>
            </li>
          ))}
        </ul>
        <p className="text-fg-muted text-xs">
          File-overlap Jaccard between the agent’s diff and the human merge request’s, over the same
          merge base. Only tickets with both diffs are counted.
        </p>
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionHeading>Launch candidates</SectionHeading>
        {data.aggregate.launch_candidates.length === 0 ? (
          <EmptyState
            title="No launch candidate yet"
            hint="A candidate is a ticket the agent matched closely (60 % overlap or more) for no more than this batch’s median cost."
          />
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {data.aggregate.launch_candidates.map((candidate) => (
              <li key={candidate.ticket_key} className="flex flex-wrap items-center gap-3">
                <Badge tone="success">
                  <UntrustedText value={candidate.ticket_key} />
                </Badge>
                <span>{percent(candidate.similarity)} overlap</span>
                <span>{formatUsd(candidate.cost_usd)}</span>
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: candidate.task_id }}
                  className="underline"
                >
                  open the task
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-1">
        <SectionHeading>Tickets</SectionHeading>
        <ul className="flex flex-col">
          {data.tickets.map((ticket) => (
            <TicketRow key={ticket.ticket_key} ticket={ticket} />
          ))}
        </ul>
      </Card>
    </div>
  );
};

export const ShadowScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const { project } = useProjectByKey(projectKey);
  const projectId = project?.id ?? null;
  useTopics(projectId === null ? [] : [`project:${projectId}`]);
  const batches = useShadowBatches(projectId);
  const commands = useShadowCommands();
  const [keys, setKeys] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const items = batches.data?.items ?? [];
  const canStart = batches.data?.can_start ?? false;
  const blocked = batches.data?.blocked_reason ?? null;
  const current = selected ?? items[0]?.id ?? null;

  const start = () => {
    const ticketKeys = keys
      .split(/[\s,]+/)
      .map((key) => key.trim())
      .filter((key) => key !== '');
    if (projectId === null || ticketKeys.length === 0) {
      return;
    }
    commands.startBatch.mutate({ projectId, ticket_keys: ticketKeys });
    setKeys('');
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2">
        <SectionHeading>Shadow mode</SectionHeading>
        <p className="text-fg-muted text-sm">
          Runs the pipeline on closed tickets and compares what it would have built with what a
          human merged. Nothing is written outside the platform: every merge request, comment and
          status change a shadow task would make is refused and recorded as <code>would_have</code>.
        </p>
        {canStart ? null : (
          <p className="text-fg-muted text-xs">
            {blocked === null ? (
              'A batch cannot be started for this project.'
            ) : (
              <UntrustedText value={blocked} />
            )}
          </p>
        )}
        <Field
          label="Ticket keys"
          hint="Closed tickets, separated by spaces or commas. At most 25 per batch."
          value={keys}
          disabled={!canStart}
          onChange={(event) => {
            setKeys(event.target.value);
          }}
        />
        <div>
          <Button
            tone="primary"
            disabled={!canStart || keys.trim() === '' || commands.startBatch.isPending}
            onClick={start}
          >
            Start a shadow batch
          </Button>
        </div>
        {commands.startBatch.error === null ? null : (
          <ErrorNotice
            title="The batch was not started."
            detail={String(commands.startBatch.error)}
          />
        )}
      </Card>

      {batches.isPending ? <Loading label="Loading shadow batches" /> : null}
      {batches.error === null ? null : (
        <ErrorNotice title="Shadow batches could not be loaded." detail={String(batches.error)} />
      )}

      {items.length === 0 ? (
        <EmptyState
          title="No shadow batch yet"
          hint="Pick ten closed tickets your team delivered recently. The platform runs the whole pipeline on each of them and reports how close it got, and at what cost."
        />
      ) : (
        <Card className="flex flex-col gap-2">
          <SectionHeading>Batches</SectionHeading>
          <ul className="flex flex-col gap-1 text-xs">
            {items.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center gap-3">
                <Button
                  tone={batch.id === current ? 'primary' : 'default'}
                  onClick={() => {
                    setSelected(batch.id);
                  }}
                >
                  {formatDateTime(batch.created_at)}
                </Button>
                <span>{formatInteger(batch.tickets)} ticket(s)</span>
                <span>{formatUsd(batch.spent_usd)}</span>
                <span className="text-fg-muted">
                  {batch.completed_at === null ? 'running' : 'complete'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {current === null || projectId === null ? null : (
        <Aggregate batchId={current} projectId={projectId} />
      )}
    </div>
  );
};
