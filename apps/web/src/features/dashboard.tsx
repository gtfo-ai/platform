/**
 * Home (`/`): what needs you, what is moving, where to go (TD-033 § 1, research/19 § 3 rules 1–2 and
 * 5, § 5.2 "Home").
 *
 * The page opens with **Needs you** — every open question and pending approval in the organisation,
 * and every task escalated to a person, saying why it waits in short form ("Waiting for: Vojtěch
 * Kaizr’s Jira ticket", S-25.15 part B, `./escalation-short.ts`) — then **Running now**, then the **Projects**; the rail on
 * the right holds the spend and the instance. For an administrator *Needs you* also carries the
 * **background failures** (S-25.6, product/10's 2026-11-06 amendment, research/21 F14): a row for the
 * stuck events and one for the failed background jobs, each only while its count is above zero —
 * the two reads' own `total`s, which nobody else is asked for (the server refuses them below admin).
 * And when tasks stopped for a person hold a project's queue (S-25.16, the queued page's
 * `queue_wait`), *Needs you* says how many tickets that keeps from starting, in one line linked to
 * the board's *Queued* column ("5 tickets can’t start until these are decided or cancelled").
 * A brand-new instance gets none of that: for an admin with no project, or no integration, Home
 * **is** the setup checklist (`home-setup.ts`), a Stepper whose every ✓ is read from the server and
 * whose one primary button continues at the first step that is not done. Once a project exists the
 * checklist moves into the rail — **until the setup project runs a ticket** (research/21 F10). From
 * then on the checklist is gone, and the rail names only a piece that is still missing, with what
 * its absence costs and where to fix it ("Merge requests can't be opened until a git host is
 * connected").
 *
 * **At most one primary button on the page**: *Continue setup* while the checklist shows, *New
 * project* once it does not — and *New project* only for an admin, the one role `project.create`
 * allows; for anyone else the page has no primary action. It watches the `org` topic, so a question asked, a run started or a run ended
 * refreshes the boxes without a reload. Every string a person or an agent wrote — a question, a
 * progress line, a ticket title, a project name, a model id — renders through `ui/untrusted.tsx`.
 */
import type { ApprovalView, TaskListItem } from '@platform/contracts';
import { RepoIcon } from '@primer/octicons-react/RepoIcon';
import { Link } from '@tanstack/react-router';
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { ApiError } from '../api/http.js';
import {
  useAgents,
  useBindableIntegrations,
  useDeadLetters,
  useFailedJobs,
  useInbox,
  useOrgBudgets,
  useProjectAutonomy,
  useProjectReadiness,
  useProjects,
  useProjectsTasks,
  useProjectTasks,
  useSession,
  useTasks,
  useVersion,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { CONNECTION_DOT, connectionLabel } from '../app/shell.js';
import { displayName, type SessionUser } from '../auth/session.js';
import { useRealtime, useTopics } from '../realtime/provider.js';
import { ACTIVITY_META, activityOf } from '../ui/activity.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { Counter } from '../ui/counter.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { Flash } from '../ui/flash.js';
import {
  APPROVAL_KIND_LABEL,
  leadingClaimBlocker,
  PROJECT_STATUS_LABEL,
  runSubject,
  stageLabel,
} from '../ui/humanize.js';
import {
  Badge,
  ErrorNotice,
  formatElapsed,
  formatInteger,
  formatRunCost,
  formatUsd,
  Metric,
} from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { rowLink } from '../ui/row-link.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { type Step, Stepper } from '../ui/stepper.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { ApprovalSummary } from './approval-summary.js';
import { reviewVerb } from './approval-text.js';
import { type EscalationShort, escalationShort } from './escalation-short.js';
import { ciHeldSentence } from './gate-wait-words.js';
import {
  type BlockedWorker,
  type HomeSetup,
  homeSetup,
  type MissingPiece,
  missingPieces,
  PLATFORM_TICKET_PROVIDER,
  type SetupChecklist,
  type SetupDestination,
  type SetupFact,
  setupChecklist,
  setupProjectOf,
} from './home-setup.js';
import { QUEUED_COLUMN_ANCHOR } from './queue-words.js';
import { ReadinessLabel } from './readiness-label.js';
import { WaitingWords, waitingShort } from './waiting-words.js';
import { useWorkerNeed, useWorkersWhen } from './worker-need.js';
import { isReadyToWork, workerReadinessOf } from './worker-readiness.js';

type ProjectItem = NonNullable<ReturnType<typeof useProjects>['data']>['items'][number];

/** How many rows a box draws before its header link takes over. */
export const HOME_ROWS = 5;

/**
 * **One broken organisation account, named once** (WP-157 (a), PROGRESS backlog 413).
 *
 * A communication account whose credentials will not decrypt withholds the prompt files of every
 * project, so it is said here once for the organisation rather than on each project's settings
 * card. The server decides it (`credentials_readable`, the loader that withholds); this renders one
 * banner however many projects there are, naming every such account, and nothing when none is.
 */
const UnreadableAccountsBanner = (): ReactElement | null => {
  // The live communication accounts — the only rows the server answers `credentials_readable` for —
  // through WP-122's selector, so the unfiltered read stays the Integrations screen's alone
  // (`app/bindable-integrations.test.ts`).
  const broken = useBindableIntegrations('communication').items.filter(
    (integration) => integration.credentials_readable === false,
  );
  const first = broken[0];
  if (first === undefined) {
    return null;
  }
  return (
    <div data-unreadable-accounts>
      <Flash
        tone="danger"
        title={
          <UntrustedText
            value={`An integration’s credentials can no longer be read: ${broken
              .map((integration) => integration.name)
              .join(', ')}.`}
          />
        }
        action={
          <Link
            to="/integrations/$integrationId"
            params={{ integrationId: first.id }}
            className={buttonClassName('default', 'sm')}
          >
            Fix it
          </Link>
        }
      >
        {/* The server's sentence only (rule 3): no consequence text is invented here. */}
        {first.credentials_consequence === null ? undefined : (
          <p>
            <UntrustedText value={first.credentials_consequence} />
          </p>
        )}
      </Flash>
    </div>
  );
};

// ── The greeting ─────────────────────────────────────────────────────────────

/** "Good morning" before noon, "Good afternoon" before six, "Good evening" after — local time. */
export const greetingFor = (hour: number): string =>
  hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

/** The first word of the account's name; nothing when the account has no name (never the email). */
export const firstNameOf = (user: SessionUser | undefined): string | null => {
  if (user === undefined) {
    return null;
  }
  const name = displayName(user);
  if (name === user.email) {
    return null;
  }
  return name.trim().split(/\s+/)[0] ?? null;
};

const Greeting = ({ user }: { readonly user: SessionUser | undefined }) => {
  const { now } = useServices();
  const first = firstNameOf(user);
  const greeting = greetingFor(new Date(now()).getHours());
  return (
    // The brand's black weight, small: one of the three places research/19 § 4.1 allows it.
    <h1 className="text-lg font-black tracking-[-0.02em] text-fg">
      {/* A React text node, sanitised (bidi and control characters): a name is the person's own text. */}
      {first === null ? `${greeting}.` : `${greeting}, ${sanitiseUntrusted(first)}.`}
    </h1>
  );
};

// ── Shared pieces ────────────────────────────────────────────────────────────

const BoxTitle = ({
  title,
  count,
  countLabel,
}: {
  readonly title: string;
  readonly count?: number;
  readonly countLabel?: string;
}): ReactElement => (
  <h2 className="inline-flex items-center gap-2 font-semibold text-fg">
    {title}
    {count === undefined ? null : (
      <Counter count={count} {...(countLabel === undefined ? {} : { label: countLabel })} />
    )}
  </h2>
);

const HEADER_LINK = cx('rounded-sm text-sm text-link hover:underline', FOCUS_RING);

/** A box's one calm line when it has nothing to list (informational: nothing to do about it). */
const QuietLine = ({ children }: { readonly children: string }): ReactElement => (
  <li data-home-quiet="" className="px-4 py-3 text-sm text-fg-muted">
    {children}
  </li>
);

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? text;

/** Ticket key and project key for a task, from its own read; `null` until it answers. */
const useTicketKeys = (taskIds: readonly string[], projects: readonly ProjectItem[]) => {
  const distinct = [...new Set(taskIds)];
  const reads = useTasks(distinct);
  const keys = new Map<string, { readonly ticket: string; readonly project: string | null }>();
  distinct.forEach((taskId, index) => {
    const task = reads[index]?.data?.task;
    if (task !== undefined) {
      keys.set(taskId, {
        ticket: task.ticket.key,
        project: projects.find((project) => project.id === task.project_id)?.key ?? null,
      });
    }
  });
  return keys;
};

const Dot = (): ReactElement => <span aria-hidden="true">·</span>;

/** `PROJ · TICKET-1 · Stage`, leaving out what is not known yet. */
const Where = ({
  project,
  ticket,
  stage,
}: {
  readonly project: string | null;
  readonly ticket: string | null;
  readonly stage: string | null;
}): ReactElement => {
  const parts: { readonly key: string; readonly node: ReactNode }[] = [];
  if (project !== null) {
    parts.push({ key: 'project', node: <UntrustedText value={project} className="font-mono" /> });
  }
  if (ticket !== null) {
    parts.push({
      key: 'ticket',
      node: <UntrustedText value={ticket} className="font-mono text-fg" />,
    });
  }
  if (stage !== null) {
    parts.push({ key: 'stage', node: <span>{stageLabel(stage)}</span> });
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index === 0 ? null : <Dot />}
          {part.node}
        </Fragment>
      ))}
    </span>
  );
};

// ── Needs you ────────────────────────────────────────────────────────────────

/** A project whose queue waits on tasks stopped for a person (S-25.16). */
export interface HeldQueue {
  readonly projectKey: string;
  readonly projectName: string;
  /** Every queued task of the project (`queue_wait.queued`), not only the page's. */
  readonly tickets: number;
}

/**
 * The projects whose queued tasks wait for a pipeline place that tasks stopped for a person hold
 * (S-25.16): the queued page's first `queue_wait` that waits with the **pipeline** full (whichever
 * limit the scheduler names first — both are checked) and a holder at *Needs you*. A wait on the
 * running tasks alone is not one — running tasks hold it, not a decision — and neither is
 * `admitted`, which nothing holds.
 */
export const heldQueuesOf = (
  projects: readonly { readonly id: string; readonly key: string; readonly name: string }[],
  queuedPages: readonly (readonly TaskListItem[])[],
): readonly HeldQueue[] =>
  projects.flatMap((project, index) => {
    const wait = (queuedPages[index] ?? [])
      .filter((task) => task.state === 'queued')
      .map((task) => task.queue_wait)
      .find((entry) => entry !== null && entry !== undefined);
    return wait !== undefined &&
      wait !== null &&
      wait.status === 'waiting' &&
      wait.pipeline.count >= wait.pipeline.limit &&
      wait.holders.needs_human > 0
      ? [{ projectKey: project.key, projectName: project.name, tickets: wait.queued }]
      : [];
  });

/** "5 tickets can’t start until these are decided or cancelled". */
export const heldQueueLine = (tickets: number): string =>
  `${tickets === 1 ? '1 ticket' : `${formatInteger(tickets)} tickets`} can’t start until these are decided or cancelled`;

interface NeedsYouItem {
  readonly id: string;
  /** `ci_held`: a CI check held at a manual job a person must start (BACKLOG 1300). */
  readonly kind: 'question' | 'approval' | 'task' | 'ci_held';
  /** For an approval row: the approval, so the row names its subject and its verb (S-25.1). */
  readonly approval?: ApprovalView;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly ticket: string | null;
  readonly stage: string | null;
  /** Untrusted when it came from an agent or a ticket. */
  readonly text: string;
  readonly at: string;
  /** For a stopped task's row: why it waits, in short form (S-25.15 part B). */
  readonly stop?: EscalationShort;
}

/**
 * The row's verb. An approval's is *Review plan* (S-25.1, BD-006's 2026-11-06 amendment): the row
 * opens the task, where the plan is on screen beside *Approve* — it never approves in one click.
 */
const actionWord = (item: NeedsYouItem): string =>
  item.kind === 'question'
    ? 'Answer'
    : item.kind === 'approval'
      ? reviewVerb(item.approval?.kind ?? 'plan')
      : 'Open';

/** A background failure an administrator sees in *Needs you*: the section it opens, and its count. */
interface BackgroundRow {
  readonly section: 'dead-letters' | 'failed-jobs';
  readonly title: string;
  readonly meta: string;
}

/**
 * The background failures, from the two Operations reads' `total` (admin only; `enabled` false asks
 * nothing). A read that has not answered gives no row yet (`settled` is false meanwhile); a read
 * that **failed** gives no row either, and says so (`unchecked`): an unknown is not a zero, so the
 * box then claims neither *Nothing needs you* nor a count it cannot know (review of #83).
 */
const useBackgroundRows = (
  admin: boolean,
): {
  readonly rows: readonly BackgroundRow[];
  readonly settled: boolean;
  readonly unchecked: boolean;
} => {
  const letters = useDeadLetters(admin);
  const jobs = useFailedJobs(admin);
  if (!admin) {
    return { rows: [], settled: true, unchecked: false };
  }
  // `?? 0` is never a zero invented for an unknown: it is reached only while a read is pending
  // (then `settled` is false and no count or quiet line is drawn) or after it failed (then
  // `unchecked` is true and the box says the failures could not be checked). A read that answered
  // always carries its `total` (`deadLettersResponseSchema`/`failedJobsResponseSchema`), and the
  // first page is the one the reads ask for (no *Show older* on Home).
  const stuck = letters.data?.pages[0]?.total ?? 0;
  const failed = jobs.data?.pages[0]?.total ?? 0;
  const rows: BackgroundRow[] = [];
  if (stuck > 0) {
    rows.push({
      section: 'dead-letters',
      title: stuck === 1 ? '1 event is stuck' : `${formatInteger(stuck)} events are stuck`,
      meta: 'Their handlers failed on every retry, so the platform stopped offering them.',
    });
  }
  if (failed > 0) {
    rows.push({
      section: 'failed-jobs',
      title:
        failed === 1
          ? '1 background job failed'
          : `${formatInteger(failed)} background jobs failed`,
      meta: 'Each failed on every retry its queue allows.',
    });
  }
  return {
    rows,
    settled: !letters.isPending && !jobs.isPending,
    unchecked: letters.isError || jobs.isError,
  };
};

const NeedsYouBox = ({
  projects,
  admin,
}: {
  readonly projects: readonly ProjectItem[];
  /** An administrator also sees the background failures (S-25.6). */
  readonly admin: boolean;
}) => {
  const inbox = useInbox();
  const background = useBackgroundRows(admin);
  const { now } = useServices();
  const escalated = useProjectsTasks(
    projects.map((project) => project.id),
    'needs_human',
  );
  // S-25.16: whether stopped tasks hold a project's queue — its queued page's `queue_wait`.
  const queuedReads = useProjectsTasks(
    projects.map((project) => project.id),
    'queued',
  );
  const heldQueues = heldQueuesOf(
    projects,
    queuedReads.map((read) => read.data?.items ?? []),
  );

  // When each stopped task stopped (the Inbox read's `escalated`, S-25.15 part B): the row's time,
  // as the Inbox's is — the task's last update only for one the read does not list.
  const stoppedAt = new Map(
    (inbox.data?.escalated ?? []).map((row) => [row.task_id, row.at] as const),
  );
  const inboxTasks = new Set([
    ...(inbox.data?.questions ?? []).map((question) => question.task_id),
    ...(inbox.data?.approvals ?? []).map((approval) => approval.task_id),
    ...(inbox.data?.ci_held ?? []).map((held) => held.task_id),
  ]);
  const items: NeedsYouItem[] = [
    ...(inbox.data?.questions ?? []).map(
      (question): NeedsYouItem => ({
        id: `q:${question.id}`,
        kind: 'question',
        taskId: question.task_id,
        projectId: null,
        ticket: null,
        stage: question.stage,
        text: firstLine(question.text),
        at: question.asked_at,
      }),
    ),
    ...(inbox.data?.approvals ?? []).map(
      (approval): NeedsYouItem => ({
        id: `a:${approval.id}`,
        kind: 'approval',
        approval,
        taskId: approval.task_id,
        projectId: null,
        ticket: null,
        stage: null,
        text: `${APPROVAL_KIND_LABEL[approval.kind]} is waiting for you`,
        at: approval.requested_at,
      }),
    ),
    // S-26.8b part 2: a CI check held at a manual job — only a person can start it (BACKLOG 1300).
    ...(inbox.data?.ci_held ?? []).map(
      (held): NeedsYouItem => ({
        id: `c:${held.task_id}`,
        kind: 'ci_held',
        taskId: held.task_id,
        projectId: held.project_id,
        ticket: held.ticket.key,
        stage: 'ci_gate',
        // The job's name is provider text: the row renders it through `UntrustedText`.
        text: ciHeldSentence(held.gate_wait.held_job),
        at: held.gate_wait.waiting_since,
      }),
    ),
    // An escalated task that already has a question or approval above is that row, not a second one.
    ...escalated.flatMap((read) =>
      (read.data?.items ?? [])
        .filter((task) => task.state === 'needs_human' && !inboxTasks.has(task.id))
        .map(
          (task): NeedsYouItem => ({
            id: `t:${task.id}`,
            kind: 'task',
            taskId: task.id,
            projectId: task.project_id,
            ticket: task.ticket.key,
            stage: task.current_stage ?? null,
            text: task.ticket_title ?? 'Waiting for a person to decide what happens next',
            at: stoppedAt.get(task.id) ?? task.updated_at,
            // The meta line names the stage, so the generic form does not say it twice.
            stop: escalationShort({ ...task, reason: task.escalation_reason }, { stage: false }),
          }),
        ),
    ),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // The count (and the empty line) wait for the escalated-task reads too, so N does not jump once
  // they answer; a failed read is settled, its rows simply absent.
  const settled =
    inbox.isSuccess && escalated.every((read) => !read.isPending) && background.settled;
  const count = items.length + background.rows.length;
  const shown = items.slice(0, HOME_ROWS);
  const keys = useTicketKeys(
    shown.filter((item) => item.ticket === null).map((item) => item.taskId),
    projects,
  );

  return (
    <section aria-label="Needs you" data-home-box="needs-you">
      <ListBox
        label="Needs you"
        header={
          <ListBoxHeader
            actions={
              <Link to="/inbox" className={HEADER_LINK}>
                View inbox →
              </Link>
            }
          >
            <BoxTitle
              title="Needs you"
              {...(settled && !background.unchecked
                ? {
                    count,
                    countLabel: `${formatInteger(count)} waiting for you`,
                  }
                : {})}
            />
          </ListBoxHeader>
        }
      >
        {inbox.isPending ? (
          <li className="px-4">
            <Skeleton label="Loading what needs you…" lines={2} />
          </li>
        ) : null}
        {inbox.isError ? (
          <li className="p-3">
            <ErrorNotice title="What needs you could not be loaded." error={inbox.error} />
          </li>
        ) : null}
        {settled && count === 0 && !background.unchecked ? (
          <QuietLine>Nothing needs you right now.</QuietLine>
        ) : null}
        {shown.map((item) => {
          const known = keys.get(item.taskId);
          const projectKey =
            item.projectId === null
              ? (known?.project ?? null)
              : (projects.find((project) => project.id === item.projectId)?.key ?? null);
          const ticket = item.ticket ?? known?.ticket ?? null;
          return (
            <ListRow
              key={item.id}
              leading={<StatusIcon status="needs_you" />}
              title={
                item.approval === undefined ? (
                  <UntrustedText value={item.text} className="line-clamp-2" />
                ) : (
                  <ApprovalSummary approval={item.approval} className="line-clamp-2" />
                )
              }
              meta={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {item.stop === undefined ? null : (
                    <>
                      <span data-home-stop={item.stop.kind} className="text-attention">
                        <WaitingWords parts={item.stop.parts} />
                      </span>
                      <Dot />
                    </>
                  )}
                  <Where project={projectKey} ticket={ticket} stage={item.stage} />
                  <Dot />
                  <span>{`${formatElapsed(item.at, now())} ago`}</span>
                </span>
              }
              actions={
                // The row's one link (S-23.26): the title is text, so the action is what a click
                // anywhere on the row opens — the task, never the command itself.
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: item.taskId }}
                  {...rowLink(buttonClassName('default', 'sm'))}
                >
                  {actionWord(item)}
                  {/* Plain text, not `UntrustedText`: its links would nest inside this one. */}
                  <span className="sr-only">{` ${sanitiseUntrusted(ticket ?? 'this task')}`}</span>
                </Link>
              }
            />
          );
        })}
        {items.length > shown.length ? (
          <QuietLine>{`${formatInteger(items.length - shown.length)} more in the inbox.`}</QuietLine>
        ) : null}
        {/* S-25.16: the tickets these stopped tasks keep from starting, linked to the queue. */}
        {heldQueues.map((held) => (
          <li
            key={held.projectKey}
            data-home-queue={held.projectKey}
            className="px-4 py-3 text-sm text-fg-muted"
          >
            <Link
              to="/projects/$key"
              params={{ key: held.projectKey }}
              hash={QUEUED_COLUMN_ANCHOR}
              className="text-link underline"
            >
              {heldQueueLine(held.tickets)}
            </Link>
            {heldQueues.length > 1 ? (
              <>
                {' in '}
                <UntrustedText value={held.projectName} />
              </>
            ) : null}
          </li>
        ))}
        {/* After the people's rows and never cut by `HOME_ROWS`: a queue of questions must not
            hide that the platform itself is stuck. */}
        {background.unchecked ? (
          <li data-home-background-unchecked="" className="px-4 py-3 text-sm text-fg-muted">
            Background failures could not be checked.
          </li>
        ) : null}
        {background.rows.map((row) => (
          <ListRow
            key={row.section}
            leading={<StatusIcon status="failure" />}
            title={<span data-home-background={row.section}>{row.title}</span>}
            meta={
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span>{row.meta}</span>
                <Dot />
                <span>Shown to administrators</span>
              </span>
            }
            actions={
              <Link
                to="/settings/$section"
                params={{ section: row.section }}
                {...rowLink(buttonClassName('default', 'sm'))}
              >
                Review
                <span className="sr-only">{` ${row.title}`}</span>
              </Link>
            }
          />
        ))}
      </ListBox>
    </section>
  );
};

// ── Running now ──────────────────────────────────────────────────────────────

type AgentEntry = NonNullable<ReturnType<typeof useAgents>['data']>['items'][number];

/**
 * A running agent's activity in the words every other screen uses (`ui/activity.ts`): "Working:
 * Reading files". Home has no task state or asks for the row, so it reads the run and its latest
 * transcript entry — what a person needing to act looks like is Home's *Needs you* box above.
 */
const homeActivityWords = (entry: AgentEntry, now: number): string => {
  const { activity, detail } = homeActivity(entry, now);
  const word = ACTIVITY_META[activity].label;
  return detail === null ? word : `${word}: ${detail}`;
};

const homeActivity = (entry: AgentEntry, now: number) =>
  activityOf({
    run: {
      status: entry.run.status,
      terminal_reason: entry.run.terminal_reason ?? null,
      start_failure: entry.run.start_failure,
      started_at: entry.run.started_at ?? null,
    },
    seat: entry.seat !== null,
    latest:
      entry.activity === null
        ? null
        : { kind: entry.activity.kind, tool_name: entry.activity.tool_name, at: entry.activity.at },
    role: entry.role,
    now,
  });

/**
 * The row's activity — and while the run waits for a machine nobody has (S-26.8b part 2, the M26
 * UX spec § 4), why, in its short form: "Waiting · Vojtěch’s machine is offline", every name through
 * `UntrustedText`; *your machine* when it is the reader's.
 */
const HomeActivity = ({
  entry,
  now,
  viewerId,
}: {
  readonly entry: AgentEntry;
  readonly now: number;
  readonly viewerId: string | null;
}): ReactElement => {
  const short =
    homeActivity(entry, now).activity === 'waiting' ? waitingShort(entry.waiting, viewerId) : null;
  return short === null ? (
    <>{homeActivityWords(entry, now)}</>
  ) : (
    <span data-home-waiting={entry.waiting?.reason ?? ''}>
      <WaitingWords parts={short} />
    </span>
  );
};

const RunningBox = ({ projects }: { readonly projects: readonly ProjectItem[] }) => {
  const agents = useAgents();
  const viewerId = useSession().data?.user.id ?? null;
  const { now } = useServices();
  const nowMs = now();
  const items = agents.data?.items ?? [];
  const shown = items.slice(0, HOME_ROWS);
  const keys = useTicketKeys(
    shown.map((entry) => entry.task_id),
    projects,
  );

  return (
    <section aria-label="Running now" data-home-box="running">
      <ListBox
        label="Running now"
        header={
          <ListBoxHeader
            actions={
              <Link to="/agents" className={HEADER_LINK}>
                Agents →
              </Link>
            }
          >
            <BoxTitle
              title="Running now"
              {...(agents.isSuccess
                ? {
                    count: items.length,
                    // The definition the old "Agents running" metric carried.
                    countLabel: `${formatInteger(items.length)} runs whose status is running right now`,
                  }
                : {})}
            />
          </ListBoxHeader>
        }
      >
        {agents.isPending ? (
          <li className="px-4">
            <Skeleton label="Loading running agents…" lines={2} />
          </li>
        ) : null}
        {agents.isError ? (
          <li className="p-3">
            <ErrorNotice title="Running agents could not be loaded." error={agents.error} />
          </li>
        ) : null}
        {agents.isSuccess && items.length === 0 ? (
          <QuietLine>No agent is running right now.</QuietLine>
        ) : null}
        {shown.map((entry) => {
          const known = keys.get(entry.task_id);
          const projectKey =
            projects.find((project) => project.id === entry.project_id)?.key ??
            known?.project ??
            null;
          return (
            <ListRow
              key={entry.run.id}
              leading={<StatusIcon status="running" />}
              title={
                <Link
                  to="/runs/$runId"
                  params={{ runId: entry.run.id }}
                  {...rowLink('hover:text-link hover:underline')}
                >
                  {runSubject({ stage: entry.run.stage, role: entry.role })}
                </Link>
              }
              meta={
                <span className="flex flex-col gap-0.5">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Where project={projectKey} ticket={known?.ticket ?? null} stage={null} />
                    <Dot />
                    {/* What it is doing, in the one activity vocabulary — never a model id
                        (research/21 § 4, BACKLOG 1262). */}
                    <span data-home-activity="">
                      <HomeActivity entry={entry} now={nowMs} viewerId={viewerId} />
                    </span>
                  </span>
                  {entry.run.latest_progress === null ? null : (
                    <span data-home-progress="" className="text-fg">
                      <UntrustedText
                        value={firstLine(entry.run.latest_progress.summary)}
                        className="line-clamp-1"
                      />
                    </span>
                  )}
                </span>
              }
              trailing={
                <>
                  <span className="tabular-nums">{formatElapsed(entry.run.started_at, nowMs)}</span>
                  <span className="tabular-nums">{formatRunCost(entry.run.cost)}</span>
                </>
              }
            />
          );
        })}
        {items.length > shown.length ? (
          <QuietLine>{`${formatInteger(items.length - shown.length)} more on the Agents page.`}</QuietLine>
        ) : null}
      </ListBox>
    </section>
  );
};

// ── Projects ─────────────────────────────────────────────────────────────────

const ProjectsBox = ({
  projects,
  newProject,
}: {
  readonly projects: readonly ProjectItem[];
  /**
   * *New project*: `null` when the caller may not create one (`project.create` is admin), else
   * whether it is the page's one primary action (it is, once setup is finished).
   */
  readonly newProject: 'primary' | 'default' | null;
}) => {
  const open = projects.reduce((total, project) => total + project.open_tasks, 0);
  return (
    <section aria-label="Projects" data-home-box="projects">
      <ListBox
        label="Projects"
        header={
          <ListBoxHeader
            {...(newProject === null
              ? {}
              : {
                  actions: (
                    <Link to="/onboarding" className={buttonClassName(newProject)}>
                      New project
                    </Link>
                  ),
                })}
          >
            <BoxTitle title="Projects" />
            <span
              className="text-fg-muted"
              title="Tasks in any state other than done or cancelled."
            >{`${formatInteger(open)} open tasks`}</span>
          </ListBoxHeader>
        }
      >
        {projects.map((project) => (
          <ListRow
            key={project.id}
            leading={
              <span aria-hidden="true" className="text-fg-muted">
                <RepoIcon size={16} />
              </span>
            }
            title={
              <Link
                to="/projects/$key"
                params={{ key: project.key }}
                {...rowLink('hover:text-link hover:underline')}
              >
                <UntrustedText value={project.name} />
              </Link>
            }
            meta={
              <span className="inline-flex flex-wrap items-center gap-2">
                <UntrustedText value={project.key} className="font-mono" />
                {project.status === 'active' ? null : (
                  <Badge tone="neutral">{PROJECT_STATUS_LABEL[project.status]}</Badge>
                )}
              </span>
            }
            trailing={
              <>
                <ReadinessLabel level={project.readiness_level} project={project} />
                <span title="Tasks in this project that are not done or cancelled.">
                  {`${formatInteger(project.open_tasks)} open`}
                </span>
                <span
                  className="w-24 text-right tabular-nums"
                  title="Provider-reported cost for this project over the last 30 days."
                >
                  {`${formatUsd(project.spent_usd_30d)} · 30d`}
                </span>
              </>
            }
          />
        ))}
      </ListBox>
    </section>
  );
};

// ── The rail: spend and the instance ─────────────────────────────────────────

const RailBox = ({
  title,
  label,
  children,
}: {
  readonly title: string;
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement => (
  <section
    aria-label={label}
    className="flex flex-col gap-3 rounded-md border border-line bg-default p-4"
  >
    <h2 className="text-sm font-semibold text-fg">{title}</h2>
    {children}
  </section>
);

const SpendBox = ({ projects }: { readonly projects: readonly ProjectItem[] }) => {
  const budgets = useOrgBudgets();
  const month = (budgets.data?.items ?? []).find(
    (budget) => budget.scope === 'org' && budget.window === 'month',
  );
  const spend = projects.reduce((total, project) => total + project.spent_usd_30d, 0);
  return (
    // One time window per label (S-23.23, the UX audit's § 4): the box holds two — the cap's month
    // to date and the last 30 days — so its title names neither.
    <RailBox title="Spend" label="Spend">
      {budgets.isPending ? <Skeleton label="Loading the monthly cap…" lines={1} /> : null}
      {budgets.isError ? (
        <ErrorNotice title="The monthly cap could not be loaded." error={budgets.error} />
      ) : null}
      {month === undefined ? (
        budgets.isSuccess ? (
          <p className="text-sm text-fg-muted">No monthly cap is set for the organisation.</p>
        ) : null
      ) : (
        <div className="flex flex-col gap-2">
          <Metric
            label="Against the monthly cap"
            value={`${formatUsd(month.spent_usd)} of ${formatUsd(month.limit_usd)}`}
            definition="Cost booked against the organisation's monthly cap since the month began, in the organisation's timezone. Reaching the cap stops new runs; a running one finishes."
          />
          {/* A native <meter>, as the budgets page draws it: no inline style. */}
          <meter
            aria-label="Monthly cap used"
            className="w-full"
            min={0}
            max={Math.max(month.limit_usd, month.spent_usd)}
            value={month.spent_usd}
          >
            {`${Math.round(month.limit_usd === 0 ? 0 : (month.spent_usd / month.limit_usd) * 100)}%`}
          </meter>
        </div>
      )}
      <Metric
        label="Spend, last 30 days"
        value={formatUsd(spend)}
        definition="Sum of provider-reported cost across all projects over the last 30 days; estimated where the provider reports none."
      />
      {/* Where the figures go from here (research/21 § 3's missing path, F8): the caps, and the
          statistics that say what the spend bought. */}
      <p className="flex flex-wrap gap-x-3 text-sm" data-home-spend-links="">
        <Link to="/settings/$section" params={{ section: 'budgets' }} className="text-link">
          Organisation budgets
        </Link>
        <Link to="/stats" className="text-link">
          Statistics
        </Link>
      </p>
    </RailBox>
  );
};

const InstanceBox = () => {
  const version = useVersion();
  const { status } = useRealtime();
  const connection = connectionLabel(status);
  return (
    <RailBox title="Instance" label="Instance">
      <p className="inline-flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        <span data-home-connection={connection.tone} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cx('size-2 rounded-full', CONNECTION_DOT[connection.tone])}
          />
          <span className="text-fg">{connection.text}</span>
        </span>
        {version.data === undefined ? null : (
          <>
            <Dot />
            <UntrustedText value={version.data.version} className="font-mono text-xs" />
          </>
        )}
      </p>
    </RailBox>
  );
};

// ── The setup checklist ──────────────────────────────────────────────────────

const STEP_STATE = (fact: SetupFact, current: boolean): Step['state'] =>
  fact === 'done' ? 'done' : current ? 'current' : 'upcoming';

/** A step's destination as a `<Link>` (the only place the router meets `home-setup.ts`). */
const DestinationLink = ({
  destination,
  className,
  children,
}: {
  readonly destination: SetupDestination;
  readonly className: string;
  readonly children: ReactNode;
}): ReactElement => {
  switch (destination.to) {
    case '/integrations':
      return (
        <Link to="/integrations" className={className}>
          {children}
        </Link>
      );
    case '/onboarding':
      return (
        <Link
          to="/onboarding"
          {...(destination.project === undefined
            ? {}
            : { search: { project: destination.project } })}
          className={className}
        >
          {children}
        </Link>
      );
    case '/workers/new':
      return (
        <Link
          to="/workers/new"
          search={{
            ...(destination.step === undefined ? {} : { step: destination.step }),
            ...(destination.since === undefined ? {} : { since: destination.since }),
          }}
          className={className}
        >
          {children}
        </Link>
      );
    case '/workers':
      return (
        <Link to="/workers" className={className}>
          {children}
        </Link>
      );
    case '/projects/$key':
      return (
        <Link
          to="/projects/$key"
          params={{ key: destination.key }}
          hash={destination.hash}
          className={className}
        >
          {children}
        </Link>
      );
  }
};

const SetupBox = ({
  checklist,
  size,
}: {
  readonly checklist: SetupChecklist;
  readonly size: 'page' | 'rail';
}): ReactElement => {
  const next = checklist.next;
  const done = checklist.steps.filter((step) => step.fact === 'done').length;
  const steps: Step[] = checklist.steps.map((step) => ({
    id: step.id,
    label: step.label,
    state: STEP_STATE(step.fact, step === next),
    hint: step.fact === 'unknown' ? `${step.hint} It could not be checked just now.` : step.hint,
    render: ({ className, children }) => (
      <DestinationLink destination={step.destination} className={className}>
        {children}
      </DestinationLink>
    ),
  }));
  return (
    <section
      aria-label="Set up"
      data-home-box="setup"
      className={cx(
        'flex flex-col gap-4 rounded-md border border-line bg-default',
        size === 'page' ? 'p-6' : 'p-4',
      )}
    >
      <div className="flex flex-col gap-1">
        <h2
          className={cx(
            'text-fg',
            size === 'page' ? 'text-2xl font-black tracking-[-0.02em]' : 'text-sm font-semibold',
          )}
        >
          {size === 'page' ? 'Set up your instance' : 'Finish setting up'}
        </h2>
        <p className="text-sm text-fg-muted">{`${formatInteger(done)} of ${formatInteger(
          checklist.steps.length,
        )} done. Each step is ticked from what the platform already knows.`}</p>
      </div>
      <Stepper label="Setup steps" steps={steps} />
      {next === null ? null : (
        <div>
          <DestinationLink destination={next.destination} className={buttonClassName('primary')}>
            Continue setup
          </DestinationLink>
        </div>
      )}
    </section>
  );
};

/**
 * Once the setup project has run a ticket: the pieces a working install still lacks, each with what
 * its absence costs and a link to fix it (research/21 F10). No primary button: Home's one primary is
 * *New project* then, and each piece's link says exactly what it opens.
 */
const MissingBox = ({ pieces }: { readonly pieces: readonly MissingPiece[] }): ReactElement => (
  <section
    aria-label="Missing from setup"
    data-home-box="missing"
    className="flex flex-col gap-3 rounded-md border border-line bg-default p-4"
  >
    <h2 className="text-sm font-semibold text-fg">Missing from setup</h2>
    <ul className="flex flex-col gap-3">
      {pieces.map((piece) => (
        <li key={piece.id} data-missing-piece={piece.id} className="flex flex-col gap-1 text-sm">
          <span className="inline-flex items-start gap-2">
            <StatusIcon status="waiting" size={12} decorative />
            <span>{piece.text}</span>
          </span>
          <DestinationLink destination={piece.destination} className={HEADER_LINK}>
            {`${piece.action} →`}
          </DestinationLink>
        </li>
      ))}
    </ul>
  </section>
);

/** Every fact the checklist needs, from the reads an admin may make. */
const useSetupChecklist = (projects: readonly ProjectItem[]) => {
  const integrations = useBindableIntegrations();
  const setup = setupProjectOf(projects);
  const setupId = setup?.id ?? null;
  // A level above 0 is only ever written by an evaluation, so the read is asked only below it.
  const readiness = useProjectReadiness(
    setup !== null && setup.readiness_level === 0 ? setupId : null,
  );
  const autonomy = useProjectAutonomy(setupId);
  const tasks = useProjectTasks(setupId);
  // S-23.20: the worker step exists only where nothing on the server would run the project.
  const need = useWorkerNeed(setupId);
  const workers = useWorkersWhen(need === true);

  const has = (type: 'task_management' | 'git'): SetupFact =>
    integrations.isPending
      ? 'pending'
      : integrations.isError
        ? 'unknown'
        : integrations.items.some((item) => item.type === type)
          ? 'done'
          : 'todo';
  const tracker = has('task_management');
  const git = has('git');
  const connect: SetupFact =
    tracker === 'done' && git === 'done'
      ? 'done'
      : tracker === 'todo' || git === 'todo'
        ? 'todo'
        : tracker === 'pending' || git === 'pending'
          ? 'pending'
          : 'unknown';
  const discovery: SetupFact =
    setup !== null && setup.readiness_level > 0
      ? 'done'
      : readiness.isSuccess
        ? 'done'
        : readiness.isError
          ? readiness.error instanceof ApiError && readiness.error.status === 409
            ? 'todo'
            : 'unknown'
          : 'pending';
  const autonomyFact: SetupFact = autonomy.isSuccess
    ? autonomy.data.materialised
      ? 'done'
      : 'todo'
    : autonomy.isError
      ? 'unknown'
      : 'pending';
  const ticket: SetupFact = tasks.isSuccess
    ? tasks.data.items.some((task) => task.ticket.provider !== PLATFORM_TICKET_PROVIDER)
      ? 'done'
      : 'todo'
    : tasks.isError
      ? 'unknown'
      : 'pending';

  const active = (workers.data?.items ?? []).filter((item) => item.state === 'active');
  const worker: SetupFact | undefined =
    need === 'pending'
      ? 'pending'
      : need !== true
        ? undefined
        : workers.isSuccess
          ? active.some((item) => isReadyToWork(workerReadinessOf(item)))
            ? 'done'
            : 'todo'
          : workers.isError
            ? 'unknown'
            : 'pending';
  // Every worker that exists but cannot take work, the newest first (S-25.15): the checklist's step
  // names the newest, and Home's missing piece counts them all once there are several.
  const blockedWorkers: readonly BlockedWorker[] =
    worker !== 'todo'
      ? []
      : [...active]
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
          .flatMap((item): BlockedWorker[] => {
            // Its first blocker — or that it is updating itself (S-23.27).
            const blocker = leadingClaimBlocker(workerReadinessOf(item).claim_blockers);
            return blocker === undefined
              ? []
              : [
                  {
                    name: sanitiseUntrusted(item.name),
                    reason: blocker.word,
                    fix: blocker.fix,
                    updating: blocker.updating,
                    blocker: blocker.blocker,
                    createdAt: item.created_at,
                  },
                ];
          });
  const blockedWorker = blockedWorkers[0] ?? null;

  const checklist = setupChecklist(
    {
      connect,
      project: projects.length > 0 ? 'done' : 'todo',
      discovery,
      autonomy: autonomyFact,
      ...(worker === undefined ? {} : { worker }),
      ticket,
    },
    setup?.key ?? null,
    blockedWorker,
  );
  return {
    checklist,
    home: homeSetup(
      checklist,
      missingPieces({ tracker, git, ...(worker === undefined ? {} : { worker }) }, blockedWorkers),
    ),
    noIntegration: integrations.isSuccess && integrations.items.length === 0,
  };
};

// ── The page ─────────────────────────────────────────────────────────────────

const NO_SETUP: HomeSetup = { kind: 'none' };

const Boxes = ({
  projects,
  setup,
  canCreateProject,
  admin,
}: {
  readonly projects: readonly ProjectItem[];
  /** The checklist, the missing pieces or nothing — always nothing for somebody not an admin. */
  readonly setup: HomeSetup;
  readonly canCreateProject: boolean;
  /** An administrator's *Needs you* also lists the background failures. */
  readonly admin: boolean;
}): ReactElement => (
  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <div className="flex min-w-0 flex-col gap-6">
      <NeedsYouBox projects={projects} admin={admin} />
      <RunningBox projects={projects} />
      <ProjectsBox
        projects={projects}
        newProject={!canCreateProject ? null : setup.kind === 'checklist' ? 'default' : 'primary'}
      />
    </div>
    <aside aria-label="At a glance" className="flex flex-col gap-4">
      {setup.kind === 'checklist' ? <SetupBox checklist={setup.checklist} size="rail" /> : null}
      {setup.kind === 'missing' ? <MissingBox pieces={setup.pieces} /> : null}
      <SpendBox projects={projects} />
      <InstanceBox />
    </aside>
  </div>
);

/** An admin's Home: the checklist decides whether this is the first run. */
const AdminHome = ({
  projects,
  canCreateProject,
}: {
  readonly projects: readonly ProjectItem[];
  /** The projects read's `can_create` (S-23.23), the create route's own answer. */
  readonly canCreateProject: boolean;
}) => {
  const { checklist, home, noIntegration } = useSetupChecklist(projects);
  if (projects.length === 0 || noIntegration) {
    return checklist.settling ? (
      <Skeleton label="Checking what is set up…" />
    ) : (
      <SetupBox checklist={checklist} size="page" />
    );
  }
  // While a fact is still being read, the boxes render without the checklist rather than flicker
  // it; once a ticket has run, only a missing piece is named (`homeSetup`).
  return <Boxes projects={projects} setup={home} canCreateProject={canCreateProject} admin />;
};

export const DashboardScreen = (): ReactElement => {
  useTopics(['org']);
  const session = useSession();
  const projects = useProjects();
  const role = session.data?.user.role;
  const items = projects.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Greeting user={session.data?.user} />
      {/*
        `GET /api/integrations` is `integration.read`, an organisation `maintainer` (Q36): a member or
        a viewer is not asked, so the page makes no request it knows will answer 403.
      */}
      {role === 'admin' || role === 'maintainer' ? <UnreadableAccountsBanner /> : null}
      {projects.isPending || session.isPending ? (
        <Skeleton label="Loading your home page…" />
      ) : null}
      {projects.isError ? (
        <ErrorNotice title="Projects could not be loaded." error={projects.error} />
      ) : null}
      {projects.isSuccess && session.isSuccess ? (
        role === 'admin' ? (
          // Every setup step is an admin's to do (`project.create`, `integration.write`).
          <AdminHome projects={items} canCreateProject={projects.data?.can_create === true} />
        ) : items.length === 0 ? (
          <Blankslate
            informational
            size="spacious"
            icon={<RepoIcon size={24} />}
            title="Nothing is set up yet"
            hint="An admin connects the tracker and the git host and creates the first project. This page then shows what needs you and what the agents are doing."
          />
        ) : (
          <Boxes projects={items} setup={NO_SETUP} canCreateProject={false} admin={false} />
        )
      ) : null}
    </div>
  );
};
