/**
 * The Trial screen — product/10:20's *"Shadow — shadow-mode runs: comparison with the human MR,
 * predicted cost, similarity"* (WP-34), shown as **Trial** since S-25.7 (product/10's 2026-11-06 IA
 * amendment, Q-UX-3: *"a trial run on tickets you already shipped"*). The URL stays
 * `/projects/$key/shadow` and the contract's words (`shadow_mode`, shadow batches) are unchanged;
 * only what a person reads moved.
 *
 * Two pages, in the order a founder reads them: **start a trial** above **the trials** (a list box,
 * one row per batch), and — at `?batch=<id>` since S-23.11b — **one trial's page**: its figures as a
 * metric strip, then product/19 §13's cost-by-size, similarity distribution and launch candidates,
 * then its tickets.
 *
 * ## One state at a time (research/21 F7)
 *
 * The list page used to draw *"A batch cannot be started"*, a red *could not be loaded* and the
 * empty state together. It now draws exactly one: while the read is pending, a loading line; when it
 * failed, the error and nothing else; when a trial may not start, why — the server's
 * `blocked_reason` as a sentence — and no form; otherwise the form, whose hint is what the empty
 * state used to say. The trials already run are listed under whichever of the last two holds.
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
 *
 * Since WP-45 a report also carries the two judgements about the **human's** work — see
 * {@link HumanSideOfReport} for why its label always precedes its count.
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
import { cx } from '../ui/cx.js';
import { Flash } from '../ui/flash.js';
import { TASK_STATE_LABEL } from '../ui/humanize.js';
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
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { MetricStrip } from '../ui/metric-strip.js';
import { ROW_LINK_HOST, ROW_LINK_LIFT, rowLink } from '../ui/row-link.js';
import { StateLabel, StatusIcon } from '../ui/status.js';
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

type ShadowReport = NonNullable<ShadowBatchTicket['report']>;

/**
 * product/19 §13's two judgements about the human's work (WP-45): what a reviewer would have said
 * about the human merge request, and which acceptance criteria each side met.
 *
 * **The label comes before the count, always** (criterion 7). The criteria are the agent's own
 * RefinedSpec list — the only structured one the platform holds, written by the run being
 * measured — so the screen says so on the line the numbers are on, and it never prints *"the human
 * missed N"* on its own. The two sides were judged by two different runs, and that is said too.
 * When the report withheld the comparison (one side missing), nothing is drawn here and the
 * report's notes say why (standing rule 16).
 */
export const HumanSideOfReport = ({
  report,
}: {
  readonly report: ShadowReport;
}): ReactElement | null => {
  const findings = report.agent_review_of_human_mr ?? null;
  const comparison = report.criteria_comparison ?? null;
  if (findings === null && comparison === null) {
    return null;
  }
  const met = (side: 'agent' | 'human'): number =>
    (comparison?.criteria ?? []).filter((entry) => entry[side] === 'met').length;
  const total = comparison?.criteria.length ?? 0;
  return (
    <div className="flex flex-col gap-1 text-xs">
      {findings === null ? null : (
        <span>
          reviewer on the human MR: {formatInteger(findings.length)} finding(s) it would have raised
          — stored here, posted nowhere
        </span>
      )}
      {comparison === null ? null : (
        <div className="flex flex-col gap-0.5">
          <span className="text-fg-muted">
            Acceptance criteria, measured against the agent’s own specification — the only
            structured list the platform holds, written by the run being measured, not the ticket’s
            own words. The agent’s side was judged by its Acceptance Tester, the human’s by a
            reviewer run over the human merge request.
          </span>
          <span>
            agent met {formatInteger(met('agent'))} of {formatInteger(total)} · human MR met{' '}
            {formatInteger(met('human'))} of {formatInteger(total)} (of the agent’s criteria)
          </span>
          <ul className="flex flex-col gap-0.5 text-fg-muted">
            {comparison.criteria.map((entry) => (
              <li key={entry.id}>
                <UntrustedText value={entry.id} />: agent {entry.agent.replace('_', ' ')}, human{' '}
                {entry.human.replace('_', ' ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const TicketRow = ({ ticket }: { readonly ticket: ShadowBatchTicket }): ReactElement => {
  const missing = missingSimilarityReason(ticket);
  return (
    <li
      className={cx(ROW_LINK_HOST, 'flex flex-col gap-1 border-line border-b py-2 last:border-b-0')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ticket.refused_reason === null ? 'neutral' : 'warning'}>
          <UntrustedText value={ticket.ticket_key} />
        </Badge>
        {ticket.task_id === null ? null : (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: ticket.task_id }}
            {...rowLink('text-xs underline')}
          >
            open the task
          </Link>
        )}
        {ticket.task_state === null ? null : (
          <span className="text-fg-muted text-xs">{TASK_STATE_LABEL[ticket.task_state]}</span>
        )}
        {ticket.size === null ? null : <Badge>{`Size ${ticket.size}`}</Badge>}
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
      {ticket.report === null ? null : <HumanSideOfReport report={ticket.report} />}
      {ticket.report === null || ticket.report.notes === '' ? null : (
        // Lifted above the row's link (S-23.26): the notes stay selectable and do not open the task.
        <div className={ROW_LINK_LIFT}>
          <UntrustedProse className="text-fg-muted text-xs" value={ticket.report.notes} />
        </div>
      )}
    </li>
  );
};

/** The aggregate's six figures, as one strip across the trial's page. */
const BatchMetrics = ({
  data,
}: {
  readonly data: NonNullable<ReturnType<typeof useShadowBatch>['data']>;
}): ReactElement => (
  <MetricStrip label="This trial in figures">
    <Metric
      label="Tickets"
      value={formatInteger(data.batch.tickets)}
      definition="Ticket keys this trial was started with, including the ones the platform refused to run."
    />
    <Metric
      label="Refused"
      value={formatInteger(data.batch.refused)}
      definition="Tickets that never became a task: no merge base for the human merge request, an unknown key, or a trial task that already existed."
    />
    <Metric
      label="Reported"
      value={formatInteger(data.aggregate.reported)}
      definition="Tasks of this trial that have finished and produced a trial report."
    />
    <Metric
      label="Compared"
      value={formatInteger(data.aggregate.compared)}
      definition="Reported tasks whose report carries an overlap — both the agent's diff and the human merge request's were read."
    />
    <Metric
      label="Spent"
      value={formatUsd(data.batch.spent_usd)}
      definition="Recorded cost of this trial's tasks, summed from each task's running total."
    />
    <Metric
      label="Budget"
      value={data.batch.budget_usd === null ? 'not set' : formatUsd(data.batch.budget_usd)}
      definition="The trial budget as it stood when this trial was created; a new run stops when the month's trial spend reaches it."
    />
  </MetricStrip>
);

/** One trial's page (`?batch=<id>`): its figures, its tables and its tickets. */
const BatchPage = ({
  batchId,
  projectId,
  projectKey,
}: {
  readonly batchId: string;
  readonly projectId: string;
  readonly projectKey: string;
}) => {
  const batch = useShadowBatch(projectId, batchId);
  const back = (
    <Link to="/projects/$key/shadow" params={{ key: projectKey }} className="text-sm underline">
      ← All trials
    </Link>
  );
  if (batch.isPending) {
    return <Loading label="Loading the trial" />;
  }
  if (batch.error !== null) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <ErrorNotice title="This trial could not be loaded." error={batch.error} />
      </div>
    );
  }
  const data = batch.data;
  if (data === undefined) {
    return <EmptyState title="No trial" hint="This trial is not readable by this build." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{`Trial run · ${formatDateTime(data.batch.created_at)}`}</h2>
        <StateLabel status={data.batch.completed_at === null ? 'running' : 'success'}>
          {data.batch.completed_at === null ? 'Running' : 'Complete'}
        </StateLabel>
      </div>
      <BatchMetrics data={data} />

      <Card className="flex flex-col gap-2">
        <SectionHeading>Cost per ticket by size</SectionHeading>
        {data.aggregate.cost_by_size.length === 0 ? (
          <EmptyState
            title="No sized ticket has finished yet"
            hint="A size comes from the plan the trial’s run produced, so this table fills in as the trial works through its tickets."
          />
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {data.aggregate.cost_by_size.map((row) => (
              <li key={row.size} className="flex flex-wrap gap-3">
                <Badge>{`Size ${row.size}`}</Badge>
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
            hint="A candidate is a ticket the agent matched closely (60 % overlap or more) for no more than this trial’s median cost."
          />
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {data.aggregate.launch_candidates.map((candidate) => (
              <li
                key={candidate.ticket_key}
                className={cx(ROW_LINK_HOST, 'flex flex-wrap items-center gap-3')}
              >
                <Badge tone="success">
                  <UntrustedText value={candidate.ticket_key} />
                </Badge>
                <span>{percent(candidate.similarity)} overlap</span>
                <span>{formatUsd(candidate.cost_usd)}</span>
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: candidate.task_id }}
                  {...rowLink('underline')}
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

/** The server's `blocked_reason` — a clause — as the sentence the notice says. */
export const trialBlockedSentence = (reason: string | null): string => {
  const trimmed = reason?.trim() ?? '';
  if (trimmed === '') {
    return 'A trial cannot be started for this project.';
  }
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

export const ShadowScreen = ({
  projectKey,
  batchId = null,
}: {
  readonly projectKey: string;
  /** `?batch=<id>`: that trial's page; `null`, the trials. */
  readonly batchId?: string | null;
}): ReactElement => {
  const { project } = useProjectByKey(projectKey);
  const projectId = project?.id ?? null;
  useTopics(projectId === null ? [] : [`project:${projectId}`]);
  const batches = useShadowBatches(projectId);
  const commands = useShadowCommands();
  const [keys, setKeys] = useState('');

  const items = batches.data?.items ?? [];
  const backToAll = (
    <Link to="/projects/$key/shadow" params={{ key: projectKey }} className="text-sm underline">
      ← All trials
    </Link>
  );

  // One state at a time (F7): pending, then failed, then the page.
  if (projectId === null || batches.isPending) {
    return <Loading label={batchId === null ? 'Loading trials' : 'Loading the trial'} />;
  }
  if (batches.error !== null) {
    return (
      <div className="flex flex-col gap-3" data-trial-state="error">
        {batchId === null ? null : backToAll}
        <ErrorNotice title="Trials could not be loaded." error={batches.error} />
      </div>
    );
  }

  if (batchId !== null) {
    // The id is compared with the batches **this project's** read returned before anything is
    // asked by it, so another project's batch is never shown under this project's tab.
    if (!items.some((batch) => batch.id === batchId)) {
      return (
        <div className="flex flex-col gap-3" data-shadow-batch="unknown">
          {backToAll}
          <EmptyState
            title="No such trial in this project"
            hint="The link names a trial this project does not have. Pick one from the project’s trials."
          />
        </div>
      );
    }
    return <BatchPage batchId={batchId} projectId={projectId} projectKey={projectKey} />;
  }

  const canStart = batches.data.can_start;

  const start = () => {
    const ticketKeys = keys
      .split(/[\s,]+/)
      .map((key) => key.trim())
      .filter((key) => key !== '');
    if (ticketKeys.length === 0) {
      return;
    }
    commands.startBatch.mutate({ projectId, ticket_keys: ticketKeys });
    setKeys('');
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2">
        <SectionHeading>Trial run</SectionHeading>
        <p className="text-fg-muted text-sm">
          A trial run on tickets you already shipped: the pipeline runs on closed tickets and
          compares what it would have built with what a person merged. Nothing is written outside
          the platform: every merge request, comment and status change a trial would make is refused
          and recorded as what it would have done.
        </p>
        {canStart ? (
          <div className="flex flex-col gap-2" data-trial-state="ready">
            <Field
              label="Ticket keys"
              hint={
                items.length === 0
                  ? 'Pick ten closed tickets your team delivered recently, separated by spaces or commas (at most 25). The platform runs the whole pipeline on each and reports how close it got, and at what cost.'
                  : 'Closed tickets, separated by spaces or commas. At most 25 per trial.'
              }
              value={keys}
              onChange={(event) => {
                setKeys(event.target.value);
              }}
            />
            <div>
              <Button
                tone="primary"
                disabled={keys.trim() === '' || commands.startBatch.isPending}
                onClick={start}
              >
                Start a trial run
              </Button>
            </div>
            {commands.startBatch.error === null ? null : (
              <ErrorNotice title="The trial was not started." error={commands.startBatch.error} />
            )}
          </div>
        ) : (
          <div data-trial-state="blocked">
            <Flash title="A trial cannot start yet">
              <UntrustedText value={trialBlockedSentence(batches.data.blocked_reason)} />
            </Flash>
          </div>
        )}
      </Card>

      {items.length === 0 ? null : (
        <ListBox
          label="Trials"
          header={
            <ListBoxHeader>
              <span className="font-semibold text-fg">
                {items.length === 1 ? '1 trial' : `${formatInteger(items.length)} trials`}
              </span>
            </ListBoxHeader>
          }
        >
          {items.map((batch) => (
            <ListRow
              key={batch.id}
              leading={<StatusIcon status={batch.completed_at === null ? 'running' : 'success'} />}
              title={
                <Link
                  to="/projects/$key/shadow"
                  params={{ key: projectKey }}
                  search={{ batch: batch.id }}
                  {...rowLink('hover:underline')}
                >
                  {`Trial of ${formatDateTime(batch.created_at)}`}
                </Link>
              }
              meta={`${formatInteger(batch.tickets)} ticket(s) · ${batch.completed_at === null ? 'running' : 'complete'}`}
              trailing={<span>{formatUsd(batch.spent_usd)}</span>}
            />
          ))}
        </ListBox>
      )}
    </div>
  );
};
