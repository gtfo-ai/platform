/**
 * The inbox (`/inbox`) — GitHub's notifications, for what needs a person (product/10 § "Questions
 * inbox"; research/19 § 5.2 "Inbox", TD-033 § 1).
 *
 * Everything pending for the signed-in user across every project: the open questions and the
 * pending approvals. A left NavList filters them — all, questions, approvals, or one project — with
 * a count on each; the list box has one row per item, the needs-you icon first, then the question's
 * first line (or the approval's kind), where it is (`PROJ · KEY · Stage`), how old it is and when it
 * is due. A question row **expands in place** to the whole question and its answer box; an approval
 * row links to the task, which is where it is decided. product/10 is explicit that "all channels are
 * equivalent; first answer wins", so the rows link to the task rather than pretending to be the only
 * way in.
 *
 * **Where an item is comes from its task.** The inbox read carries a task id and the stage, not the
 * project or the ticket, so each distinct task is read once (`useTasks`, the keys the task page
 * uses, so opening a row reads nothing twice) — the same answer Home gives. Until a task answers,
 * its row shows only the stage, and it is counted under *All* and its kind but under no project.
 *
 * Every string an agent or a provider wrote — the question, the ticket key, a project's name —
 * renders through `ui/untrusted.tsx`.
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
import { APPROVAL_KIND_LABEL, stageLabel } from '../ui/humanize.js';
import { ErrorNotice, formatDateTime, formatInteger } from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { NavList } from '../ui/nav-list.js';
import { PageHeader } from '../ui/page-header.js';
import { formatAgo } from '../ui/relative-time.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';

type Inbox = NonNullable<ReturnType<typeof useInbox>['data']>;
type Question = Inbox['questions'][number];
type Approval = Inbox['approvals'][number];

/** The filter the NavList holds: a kind, or one project by id. */
type Filter =
  | { readonly kind: 'all' }
  | { readonly kind: 'questions' }
  | { readonly kind: 'approvals' }
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

/** "asked 5 m ago · due 30 Sep 2026, 15:00" — an item with no deadline says none. */
const timeLine = (verb: string, at: string, deadline: string | null | undefined, nowMs: number) => {
  const ago = formatAgo(at, nowMs);
  const asked = ago === null ? `${verb} ${formatDateTime(at)}` : `${verb} ${ago}`;
  // Questions and approvals both expire since WP-56 (Q95), so each row says when (backlog 166).
  return deadline === null || deadline === undefined
    ? asked
    : `${asked} · due ${formatDateTime(deadline)}`;
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
  const [refused, setRefused] = useState(false);
  const panelId = useId();
  const inputId = useId();

  const answer = (): void => {
    if (text.trim() === '') {
      return;
    }
    setBusy(true);
    setRefused(false);
    void endpoints
      .answerQuestion(question.task_id, question.id, { answer: text })
      .then(onAnswered)
      .catch(() => {
        setRefused(true);
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
            className={cx(
              'inline-flex max-w-full items-start gap-1 rounded-sm text-left hover:text-link',
              FOCUS_RING,
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
                'rounded-md border border-line-input bg-canvas px-3 py-2 text-sm text-fg',
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
          {refused ? <ErrorNotice title="That answer was refused." /> : null}
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
    title={
      <Link
        to="/tasks/$taskId"
        params={{ taskId: approval.task_id }}
        className="hover:text-link hover:underline"
      >
        {`${APPROVAL_KIND_LABEL[approval.kind]} is waiting for you`}
      </Link>
    }
    meta={
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <WhereLine where={where} stage={null} />
        {where.project === null && where.ticket === null ? null : <Dot />}
        <span>{timeLine('requested', approval.requested_at, approval.deadline_at, nowMs)}</span>
      </span>
    }
    actions={
      <Link
        to="/tasks/$taskId"
        params={{ taskId: approval.task_id }}
        className={buttonClassName('default', 'sm')}
      >
        Decide on the task
      </Link>
    }
  />
);

/**
 * PROGRESS backlog 163's inbox half, closed by decision at WP-95 rather than built: this list is
 * what a person can still act on **here**, and an expired question or approval can no longer be
 * answered or decided (`listInbox` serves `open` and `pending` only). Listing it would be a row whose
 * only control is refused. Its task is `needs_human`, under **Needs you** on the board, and the task
 * page lists the expired item beside the retry control (WP-56). The screen says so — one line, and
 * the rest behind *Learn more* (research/19 § 3 rule 6).
 */
const ExpiryNote = (): ReactElement => (
  <div className="flex flex-col gap-1 text-xs text-fg-muted" data-inbox-expiry-note="true">
    <p>An item that expires leaves this list.</p>
    <DetailsDisclosure summary="Learn more" className="text-xs">
      <p>
        A question or approval that expires leaves this list: it can no longer be answered or
        decided. Its task waits under Needs you on its project’s board, and the task page is where
        it is retried or cancelled.
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

  const questions = inbox.data?.questions ?? [];
  const approvals = inbox.data?.approvals ?? [];
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

  // A project is listed once one of its items is known to be in it.
  const projectCounts = new Map<string, number>();
  for (const item of [...questions, ...approvals]) {
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

  const total = questions.length + approvals.length;
  const shown = shownQuestions.length + shownApprovals.length;
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
              hint="Questions an agent cannot answer itself, and approvals a maintainer owes, land here — and in the ticket and in chat at the same time. The first answer anywhere wins."
            />
          ) : null}
          {settled && total > 0 ? (
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
            </ListBox>
          ) : null}
        </div>
      </div>
    </div>
  );
};
