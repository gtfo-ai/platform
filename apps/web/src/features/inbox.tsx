/**
 * The inbox (`/inbox`) — GitHub's notifications, for what needs a person (product/10 § "Questions
 * inbox"; research/19 § 5.2 "Inbox", TD-033 § 1).
 *
 * Everything pending for the signed-in user across every project: the open questions and the
 * pending approvals. A left NavList filters them — all, questions, approvals, or one project — with
 * a count on each; the list box has one row per item, the needs-you icon first, then the question's
 * first line (or what the approval approves — "Plan v2 · size L · 6 files", S-25.1), where it is
 * (`PROJ · KEY · Stage`), how old it is and — for a question — when it is due; an approval never
 * expires (BD-006's 2026-11-07 amendment), so its row says it *waits for a maintainer* instead. A
 * question row **expands in place** to
 * the whole question and its answer box; an approval row's verb is *Review plan* and it links to the
 * task, which is where it is decided with the plan on screen — no row approves in one click. product/10 is explicit that "all channels are
 * equivalent; first answer wins", so the rows link to the task rather than pretending to be the only
 * way in.
 *
 * **Where an item is comes from its task.** The inbox read carries a task id and the stage, not the
 * project or the ticket, so each distinct task is read once (`useTasks`, the keys the task page
 * uses, so opening a row reads nothing twice) — the same answer Home gives. Until a task answers,
 * its row shows only the stage, and it is counted under *All* and its kind but under no project.
 *
 * **A CI check held at a manual job** (S-26.8b part 2, BACKLOG 1300, the read's `ci_held`) is a
 * row too: only a person can start the job, so it needs somebody now, exactly as the task page's
 * *Needs you* says. Its row names the job, where it is (the read carries the project and the
 * ticket), how long it has waited, and opens the task, whose primary action starts the job.
 *
 * **A task stopped for a person** (S-25.15 part B, backlog 1360, the read's `escalated`) is a row
 * of its own section, *Stopped, waiting for a person*, below the rest: why it waits in short form
 * (`./escalation-short.ts`: "Waiting for: Vojtěch Kaizr’s Jira ticket", a reason key's words, or
 * "Needs a person"), where it is and when it stopped, and the whole row opens the task — nothing is
 * decided from this list (M25: decide on the task page, with the evidence on screen). A stopped task
 * that also has a question or an approval is listed once, as that row (`ui/task-status.ts`'
 * `inboxRows`, which the frame's badge counts too).
 *
 * Every string an agent or a provider wrote — the question, the ticket key, a project's name, a
 * job's name, a tracker assignee's name — renders through `ui/untrusted.tsx`.
 */
import { BellIcon } from '@primer/octicons-react/BellIcon';
import { ChevronRightIcon } from '@primer/octicons-react/ChevronRightIcon';
import { Link } from '@tanstack/react-router';
import { Fragment, type ReactElement, type ReactNode, useId, useState } from 'react';
import { useInbox, useProjects, useTasks } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { Blankslate } from '../ui/blankslate.js';
import { Button, buttonClassName } from '../ui/button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { DetailsDisclosure } from '../ui/details.js';
import { stageLabel } from '../ui/humanize.js';
import { ErrorNotice, formatDateTime, formatInteger } from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { NavList } from '../ui/nav-list.js';
import { PageHeader } from '../ui/page-header.js';
import { formatAgo } from '../ui/relative-time.js';
import { rowLink } from '../ui/row-link.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { inboxRows } from '../ui/task-status.js';
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { APPROVAL_WAIT_WORDS } from '../ui/words/approvals.js';
import { ApprovalSummary } from './approval-summary.js';
import { reviewVerb, waitingLine } from './approval-text.js';
import { escalationShort } from './escalation-short.js';
import { ciHeldSentence } from './gate-wait-words.js';
import { WaitingWords } from './waiting-words.js';

type Inbox = NonNullable<ReturnType<typeof useInbox>['data']>;
type Question = Inbox['questions'][number];
type Approval = Inbox['approvals'][number];
type CiHeld = Inbox['ci_held'][number];
type StoppedTask = Inbox['escalated'][number];

/** The filter the NavList holds: a kind, or one project by id. */
type Filter =
  | { readonly kind: 'all' }
  | { readonly kind: 'questions' }
  | { readonly kind: 'approvals' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'project'; readonly projectId: string };

interface Where {
  readonly projectId: string | null;
  readonly project: string | null;
  readonly ticket: string | null;
}

/** The question's first non-empty line: the row's title; the whole text is in the expanded row. */
export const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? text;

const Dot = (): ReactElement => <span aria-hidden="true">·</span>;

/** `PROJ · KEY · Stage`, leaving out what is not known yet. */
const WhereLine = ({
  where,
  stage,
}: {
  readonly where: Where;
  readonly stage: string | null;
}): ReactElement => {
  const parts: { readonly key: string; readonly node: ReactNode }[] = [];
  if (where.project !== null) {
    parts.push({
      key: 'project',
      node: <UntrustedText value={where.project} className="font-mono" />,
    });
  }
  if (where.ticket !== null) {
    parts.push({
      key: 'ticket',
      node: <UntrustedText value={where.ticket} className="font-mono text-fg" />,
    });
  }
  if (stage !== null) {
    parts.push({ key: 'stage', node: <span>{stageLabel(stage)}</span> });
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-inbox-where="">
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index === 0 ? null : <Dot />}
          {part.node}
        </Fragment>
      ))}
    </span>
  );
};

/**
 * "asked 5 m ago · due 30 Sep 2026, 15:00" for a question, "requested 3 h ago · waits for a
 * maintainer" for an approval. A question expires (BD-006), so its row says when (backlog 166); an
 * approval never does since S-27.1 (BD-006's 2026-11-07 amendment), so it is passed no deadline and
 * says who it waits for — no *due*, *expires* or *until* clause. A question with no deadline (a row
 * an older build wrote) says neither.
 */
export const timeLine = (
  verb: string,
  at: string,
  deadline: string | null | undefined,
  nowMs: number,
  waits?: string,
): string => {
  const ago = formatAgo(at, nowMs);
  const asked = ago === null ? `${verb} ${formatDateTime(at)}` : `${verb} ${ago}`;
  if (deadline !== null && deadline !== undefined) {
    return `${asked} · due ${formatDateTime(deadline)}`;
  }
  return waits === undefined ? asked : `${asked} · ${waits}`;
};

const QuestionRow = ({
  question,
  where,
  nowMs,
  onAnswered,
}: {
  readonly question: Question;
  readonly where: Where;
  readonly nowMs: number;
  readonly onAnswered: () => Promise<unknown>;
}): ReactElement => {
  const { endpoints } = useServices();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<unknown>(null);
  const panelId = useId();
  const inputId = useId();

  const answer = (): void => {
    if (text.trim() === '') {
      return;
    }
    setBusy(true);
    setRefused(null);
    void endpoints
      .answerQuestion(question.task_id, question.id, { answer: text })
      .then(onAnswered)
      .catch((error: unknown) => {
        setRefused(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <ListRow
        leading={
          <StatusIcon
            status="needs_you"
            label={question.blocking ? 'Blocking question' : 'Question'}
          />
        }
        title={
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen(!open)}
            // The row's one stretched control (S-23.26): a click anywhere on the row opens the
            // answer form — on this page, not a command; *Open task* keeps its own click.
            {...rowLink(
              'inline-flex max-w-full items-start gap-1 rounded-sm text-left hover:text-link',
            )}
            data-inbox-question={question.id}
          >
            <span
              aria-hidden="true"
              className={cx(
                'mt-0.5 inline-flex text-fg-muted transition-transform',
                open ? 'rotate-90' : null,
              )}
            >
              <ChevronRightIcon size={16} />
            </span>
            <UntrustedText value={firstLine(question.text)} className="line-clamp-2" />
          </button>
        }
        meta={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <WhereLine where={where} stage={question.stage} />
            <Dot />
            <span>{question.blocking ? 'Blocking' : 'Question'}</span>
            <Dot />
            <span>{timeLine('asked', question.asked_at, question.deadline_at, nowMs)}</span>
          </span>
        }
        actions={
          <Link
            to="/tasks/$taskId"
            params={{ taskId: question.task_id }}
            className={buttonClassName('invisible', 'sm')}
          >
            Open task
          </Link>
        }
      />
      {open ? (
        <li id={panelId} className="flex flex-col gap-3 bg-subtle px-4 py-3 pl-11">
          <UntrustedProse value={question.text} />
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              answer();
            }}
          >
            <label htmlFor={inputId} className="text-sm font-medium">
              Your answer
            </label>
            <textarea
              id={inputId}
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className={cx(
                'rounded-md border border-line-input bg-inset px-3 py-2 text-sm text-fg',
                FOCUS_RING,
              )}
            />
            <p className="text-xs text-fg-muted">
              The first answer anywhere wins: here, on the task, in the ticket or in chat.
            </p>
            <div className="flex gap-2">
              {/* A per-row inline form: its primary is the row's own (research/19 § 3 rule 1). */}
              <Button type="submit" tone="primary" disabled={busy || text.trim() === ''}>
                Answer
              </Button>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
          {refused === null ? null : (
            <ErrorNotice title="That answer was refused." error={refused} />
          )}
        </li>
      ) : null}
    </>
  );
};

const ApprovalRow = ({
  approval,
  where,
  nowMs,
}: {
  readonly approval: Approval;
  readonly where: Where;
  readonly nowMs: number;
}): ReactElement => (
  <ListRow
    leading={<StatusIcon status="needs_you" label="Approval" />}
    // What it approves (S-25.1): "Plan v2 · size L · 6 files", as text — the row's one link is its
    // *Review plan*, so a keyboard meets it once, and it is the row's stretched link (S-23.26): a
    // click anywhere opens the task, where the plan is shown open. No row approves in one click.
    title={<ApprovalSummary approval={approval} />}
    meta={
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <WhereLine where={where} stage={null} />
        {where.project === null && where.ticket === null ? null : <Dot />}
        {/* No deadline, whatever the read carries: an approval never expires (S-27.1). */}
        <span>
          {timeLine('requested', approval.requested_at, null, nowMs, APPROVAL_WAIT_WORDS)}
        </span>
        {/* S-28.8: why it waits, every recorded reason in one line (a class name is project text). */}
        <span className="basis-full" data-approval-waiting="">
          <UntrustedText value={waitingLine(approval.reasons)} />
        </span>
      </span>
    }
    actions={
      <Link
        to="/tasks/$taskId"
        params={{ taskId: approval.task_id }}
        {...rowLink(buttonClassName('default', 'sm'))}
      >
        {reviewVerb(approval.kind)}
      </Link>
    }
  />
);

/** A task whose CI check waits on a manual job somebody must start (BACKLOG 1300). */
const CiHeldRow = ({
  held,
  where,
  nowMs,
}: {
  readonly held: CiHeld;
  readonly where: Where;
  readonly nowMs: number;
}): ReactElement => (
  <ListRow
    leading={<StatusIcon status="needs_you" label="CI held" />}
    title={
      <span data-inbox-ci-held={held.task_id}>
        {/* The job's name is provider text. */}
        <UntrustedText value={ciHeldSentence(held.gate_wait.held_job)} />
      </span>
    }
    meta={
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <WhereLine where={where} stage="ci_gate" />
        <Dot />
        <span>{timeLine('waiting since', held.gate_wait.waiting_since, null, nowMs)}</span>
      </span>
    }
    actions={
      <Link
        to="/tasks/$taskId"
        params={{ taskId: held.task_id }}
        {...rowLink(buttonClassName('default', 'sm'))}
      >
        Open
        <span className="sr-only">{` ${sanitiseUntrusted(held.ticket.key)}`}</span>
      </Link>
    }
  />
);

/**
 * A task stopped for a person (S-25.15 part B): why it waits, where it is, when it stopped — and the
 * whole row opens the task, where it is decided. No command here (M25).
 */
const EscalatedRow = ({
  row,
  where,
  nowMs,
}: {
  readonly row: StoppedTask;
  readonly where: Where;
  readonly nowMs: number;
}): ReactElement => {
  // The meta line names the stage, so the generic form does not say it twice.
  const stop = escalationShort(row, { stage: false });
  return (
    <ListRow
      leading={<StatusIcon status="needs_you" label="Stopped" />}
      title={
        <span data-inbox-escalated={row.task_id} data-inbox-stop={stop.kind}>
          <WaitingWords parts={stop.parts} />
        </span>
      }
      meta={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <WhereLine where={where} stage={row.current_stage} />
          <Dot />
          <span>{timeLine('stopped', row.at, null, nowMs)}</span>
        </span>
      }
      actions={
        <Link
          to="/tasks/$taskId"
          params={{ taskId: row.task_id }}
          {...rowLink(buttonClassName('default', 'sm'))}
        >
          Open
          <span className="sr-only">{` ${sanitiseUntrusted(row.ticket.key)}`}</span>
        </Link>
      }
    />
  );
};

/**
 * PROGRESS backlog 163's inbox half, closed by decision at WP-95 rather than built: this list is
 * what a person can still act on **here**, and an expired question can no longer be answered
 * (`listInbox` serves `open` and `pending` only). Listing it would be a row whose only control is
 * refused. Its task is `needs_human`, under **Needs you** on the board, and the task page lists the
 * expired item beside the retry control (WP-56). **An approval never expires** (S-27.1, BD-006's
 * 2026-11-07 amendment): it stays in this list until a maintainer decides it. The screen says so —
 * one line, and the rest behind *Learn more* (research/19 § 3 rule 6).
 */
const ExpiryNote = (): ReactElement => (
  <div className="flex flex-col gap-1 text-xs text-fg-muted" data-inbox-expiry-note="true">
    <p>Questions, approvals and stopped tasks waiting for a person, across all projects.</p>
    <DetailsDisclosure summary="Learn more" className="text-xs">
      <p>
        A question that expires leaves this list: it can no longer be answered. Its task waits under
        Needs you on its project’s board, and the task page is where it is retried or cancelled. An
        approval does not expire: it stays here, and its task under Needs you, until a maintainer
        approves or rejects it.
      </p>
    </DetailsDisclosure>
  </div>
);

export const InboxScreen = (): ReactElement => {
  useTopics(['org']);
  const inbox = useInbox();
  const projects = useProjects();
  const { now } = useServices();
  const nowMs = now();
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });

  // The one reading of what the Inbox lists, the frame's badge's too (`ui/task-status.ts`).
  const rows = inbox.data === undefined ? null : inboxRows(inbox.data);
  const questions = rows?.questions ?? [];
  const approvals = rows?.approvals ?? [];
  const ciHeld = rows?.ci_held ?? [];
  const escalated = rows?.escalated ?? [];
  const taskIds = [...new Set([...questions, ...approvals].map((item) => item.task_id))];
  const reads = useTasks(taskIds);
  const whereOf = new Map<string, Where>();
  taskIds.forEach((taskId, index) => {
    const task = reads[index]?.data?.task;
    if (task !== undefined) {
      const project = projects.data?.items.find((entry) => entry.id === task.project_id);
      whereOf.set(taskId, {
        projectId: task.project_id,
        project: project?.key ?? null,
        ticket: task.ticket.key,
      });
    }
  });
  // A held CI job's row and a stopped task's carry their project and ticket themselves.
  for (const held of [...ciHeld, ...escalated]) {
    whereOf.set(held.task_id, {
      projectId: held.project_id,
      project: projects.data?.items.find((entry) => entry.id === held.project_id)?.key ?? null,
      ticket: held.ticket.key,
    });
  }
  const where = (taskId: string): Where =>
    whereOf.get(taskId) ?? { projectId: null, project: null, ticket: null };

  const inProject = (taskId: string, projectId: string): boolean =>
    where(taskId).projectId === projectId;
  const shownQuestions = questions.filter((question) =>
    filter.kind === 'all' || filter.kind === 'questions'
      ? true
      : filter.kind === 'project'
        ? inProject(question.task_id, filter.projectId)
        : false,
  );
  const shownApprovals = approvals.filter((approval) =>
    filter.kind === 'all' || filter.kind === 'approvals'
      ? true
      : filter.kind === 'project'
        ? inProject(approval.task_id, filter.projectId)
        : false,
  );

  const shownCiHeld = ciHeld.filter((held) =>
    filter.kind === 'all'
      ? true
      : filter.kind === 'project'
        ? held.project_id === filter.projectId
        : false,
  );
  const shownEscalated = escalated.filter((row) =>
    filter.kind === 'all' || filter.kind === 'stopped'
      ? true
      : filter.kind === 'project'
        ? row.project_id === filter.projectId
        : false,
  );

  // A project is listed once one of its items is known to be in it.
  const projectCounts = new Map<string, number>();
  for (const item of [...questions, ...approvals, ...ciHeld, ...escalated]) {
    const projectId = where(item.task_id).projectId;
    if (projectId !== null) {
      projectCounts.set(projectId, (projectCounts.get(projectId) ?? 0) + 1);
    }
  }
  const projectItems = [...projectCounts.entries()].map(([projectId, count]) => {
    const project = projects.data?.items.find((entry) => entry.id === projectId);
    return {
      id: `project:${projectId}`,
      // A plain string in the nav, sanitised (bidi and control characters): the project's own text.
      label: sanitiseUntrusted(project?.key ?? 'Unknown project'),
      counter: count,
      current: filter.kind === 'project' && filter.projectId === projectId,
      onSelect: () => setFilter({ kind: 'project', projectId }),
    };
  });

  const total = rows?.total ?? 0;
  // What waits on an answer, a decision or a job, above; the stopped tasks are their own section.
  const shown = shownQuestions.length + shownApprovals.length + shownCiHeld.length;
  const settled = inbox.isSuccess;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Inbox" divider={false} meta={<ExpiryNote />} />
      {inbox.isError ? (
        <ErrorNotice title="Inbox could not be loaded." error={inbox.error} />
      ) : null}
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <NavList
          label="Inbox filters"
          groups={[
            {
              items: [
                {
                  id: 'all',
                  label: 'All',
                  ...(settled ? { counter: total } : {}),
                  current: filter.kind === 'all',
                  onSelect: () => setFilter({ kind: 'all' }),
                },
                {
                  id: 'questions',
                  label: 'Questions',
                  ...(settled ? { counter: questions.length } : {}),
                  current: filter.kind === 'questions',
                  onSelect: () => setFilter({ kind: 'questions' }),
                },
                {
                  id: 'approvals',
                  label: 'Approvals',
                  ...(settled ? { counter: approvals.length } : {}),
                  current: filter.kind === 'approvals',
                  onSelect: () => setFilter({ kind: 'approvals' }),
                },
                {
                  id: 'stopped',
                  label: 'Stopped',
                  ...(settled ? { counter: escalated.length } : {}),
                  current: filter.kind === 'stopped',
                  onSelect: () => setFilter({ kind: 'stopped' }),
                },
              ],
            },
            ...(projectItems.length === 0 ? [] : [{ label: 'Projects', items: projectItems }]),
          ]}
        />
        <div className="flex min-w-0 flex-col gap-3">
          {inbox.isPending ? <Skeleton label="Loading inbox…" lines={3} /> : null}
          {settled && total === 0 ? (
            <Blankslate
              informational
              size="spacious"
              icon={<BellIcon size={24} />}
              title="Nothing needs you"
              hint="Questions an agent cannot answer itself, approvals a maintainer owes, CI jobs only a person can start and tasks stopped for a person land here. Questions and approvals reach the ticket and chat at the same time, and the first answer anywhere wins."
            />
          ) : null}
          {settled && total > 0 && (shown > 0 || shownEscalated.length === 0) ? (
            <ListBox
              label="Waiting for you"
              header={
                <ListBoxHeader>
                  <span className="font-semibold text-fg">
                    {`${formatInteger(shown)} waiting for you`}
                  </span>
                </ListBoxHeader>
              }
            >
              {shown === 0 ? (
                <li className="px-4 py-3 text-sm text-fg-muted">Nothing under this filter.</li>
              ) : null}
              {shownQuestions.map((question) => (
                <QuestionRow
                  key={question.id}
                  question={question}
                  where={where(question.task_id)}
                  nowMs={nowMs}
                  onAnswered={() => inbox.refetch()}
                />
              ))}
              {shownApprovals.map((approval) => (
                <ApprovalRow
                  key={approval.id}
                  approval={approval}
                  where={where(approval.task_id)}
                  nowMs={nowMs}
                />
              ))}
              {shownCiHeld.map((held) => (
                <CiHeldRow
                  key={held.task_id}
                  held={held}
                  where={where(held.task_id)}
                  nowMs={nowMs}
                />
              ))}
            </ListBox>
          ) : null}
          {settled && shownEscalated.length > 0 ? (
            <ListBox
              label="Stopped, waiting for a person"
              header={
                <ListBoxHeader>
                  <span className="font-semibold text-fg" data-inbox-section="stopped">
                    {`${formatInteger(shownEscalated.length)} stopped, waiting for a person`}
                  </span>
                </ListBoxHeader>
              }
            >
              {shownEscalated.map((row) => (
                <EscalatedRow
                  key={row.task_id}
                  row={row}
                  where={where(row.task_id)}
                  nowMs={nowMs}
                />
              ))}
            </ListBox>
          ) : null}
        </div>
      </div>
    </div>
  );
};
