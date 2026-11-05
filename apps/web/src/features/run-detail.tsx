/**
 * Run detail — the "click and watch" requirement (product/10 § "Run detail"), drawn as a GitHub
 * Actions job page (research/19 § 5.2 "Run", S-23.10).
 *
 * - **The header**: back to the task (its key and title, the provider's text), the run's status icon
 *   and *Implementation · Developer · attempt 3*, and the actions — **Cancel run** (the outline
 *   danger button, the only coloured action while the run is live, behind a confirming dialog),
 *   **Re-run ▾** (a menu: re-run as configured, or with another model or effort in a dialog holding
 *   the retry fields — the primary action once a run failed) and `···` (*Take over…* in a dialog,
 *   *Download transcript*).
 * - **The job list** down the left: the task's runs in stage order with their status icons
 *   (`run-jobs.ts`), this one current, and under it *Details* — the settings hash and whether it
 *   moved since the task's previous run (WP-112), the saved work (backlog 467), the prompt version.
 * - **The main column**: a summary strip (status, model, effort, cost, elapsed, turns, tokens); while
 *   the run is live a *Now:* line from the one activity vocabulary (`ui/activity.ts`) and the newest
 *   rows of the stage dialog's *Live activity* list (`viz/flow/activity-list.tsx`); then four tabs —
 *   the transcript as **log steps** (`transcript/view.tsx`) in a pane of its own sized to the
 *   viewport, the exact prompt, the context pack, and the settings it was planned with
 *   (`features/run-settings.tsx`).
 * - **Steer** sits under the log, sticky to the bottom of the window while the run is live (accepted,
 *   then applied or refused by the process holding the run — the list under it says which, WP-85),
 *   and the stage feedback form closes the page.
 *
 * Retry creates a *new* run rather than changing this one (`POST /api/runs/:id/retry`). Take over
 * and hand back are the task's (`features/take-over.tsx`, the component the task screen renders).
 *
 * This route is **lazily loaded** (`routes/tree.tsx`): the transcript renderer is the largest
 * component in the app and TD-013's budget is about the *initial* bundle. A user on the board has
 * not paid for it.
 */

import type { ContextPackRecord, RunReadResponse, RunRecord, RunSeat } from '@platform/contracts';
import { ArrowLeftIcon } from '@primer/octicons-react/ArrowLeftIcon';
import { TriangleDownIcon } from '@primer/octicons-react/TriangleDownIcon';
import { Link } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useState, useSyncExternalStore } from 'react';
import { transcriptDownloadPath } from '../api/endpoints.js';
import {
  useRun,
  useRunCommandLog,
  useRunCommands,
  useRunContextPack,
  useRunMessages,
  useRunPrompt,
  useRunSettings,
  useTask,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { TranscriptView } from '../transcript/view.js';
import {
  ActionMenu,
  ActionMenuItem,
  ActionMenuLinkItem,
  ActionMenuSeparator,
} from '../ui/action-menu.js';
import { ACTIVITY_META, activityFromBlocks, activityOf } from '../ui/activity.js';
import { Button } from '../ui/button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Dialog } from '../ui/dialog.js';
import { RUN_STATUS_LABEL, runSubject, stageLabel } from '../ui/humanize.js';
import {
  Badge,
  Card,
  ErrorNotice,
  formatElapsed,
  formatInteger,
  formatRunCost,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { NavList } from '../ui/nav-list.js';
import { PageHeader } from '../ui/page-header.js';
import { StatusIcon } from '../ui/status.js';
import { CodeText, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { usagePauseWords } from '../ui/usage-pause.js';
import { ActivityList } from '../viz/flow/activity-list.js';
import { activityRows } from '../viz/flow/activity-rows.js';
import { FeedbackForm } from './feedback.js';
import { RunCommandLog } from './run-command-log.js';
import { isFailedRun, isLiveRun, jobLabel, jobsInStageOrder, RUN_STATUS_ICON } from './run-jobs.js';
import { isStoppedRun, RunNotStartedPanel } from './run-not-started.js';
import {
  configuredLabel,
  INITIAL_RETRY_MODEL_CHOICE,
  type RetryModelChoice,
  RetryModelField,
  retryModelRequest,
} from './run-retry-model.js';
import { RunSavedWorkLine } from './run-saved-work.js';
import { RunSettingsLine, RunSettingsPanel } from './run-settings.js';
import { TakeOverPanel } from './take-over.js';

type Tab = 'transcript' | 'prompt' | 'context' | 'settings';

/**
 * The documents a run was **shown**: tier 0 and the tier-1 entries recorded `validated: true`
 * (WP-44, PROGRESS backlog 168).
 *
 * A tier-1 entry recorded `validated: false` was dropped by the assembler before the count and the
 * budget — its `paths:` glob resolved to nothing at the indexed commit — so it was never in the
 * prompt. The stored `total_tokens` excludes it and the statistics' `kb_usage` admits only
 * `validated` rows; this is the same rule, spelled once for the screen (standing rule 41). The
 * unvalidated entries stay in the list, marked, because they are the audit technical/07 step 3
 * promises.
 */
export const admittedDocuments = (pack: ContextPackRecord): number =>
  pack.tier0.length + pack.tier1.filter((entry) => entry.validated).length;

/**
 * Why tier 1 has no text-matched document, in words — or what the text step did (WP-44, PROGRESS
 * backlog 172). `null` for a pack recorded before the step was (migration 0047).
 */
export const textSearchText = (pack: ContextPackRecord): string | null => {
  const search = pack.text_search;
  if (search === null || search === undefined) {
    return null;
  }
  const kept = search.kept_terms.join(', ');
  const dropped = search.dropped_terms.join(', ');
  const omitted =
    search.omitted_terms === 0
      ? ''
      : ` ${search.omitted_terms} term${search.omitted_terms === 1 ? ' is' : 's are'} not shown (redacted or too long).`;
  const statistics =
    search.floor === 'no_statistics'
      ? ' The index carries no word statistics yet, so no word was dropped as too common.'
      : '';
  switch (search.outcome) {
    case 'not_searched':
      return 'No text search ran: this project has no knowledge index yet, so only the path rules could match.';
    case 'no_terms':
      return `No text search ran: the task text had no keyword to search for.${omitted}`;
    case 'all_uninformative':
      return `Every keyword was dropped as too common in this project to mean anything: ${dropped}.${omitted}`;
    case 'no_match':
      return `Searched for ${kept}${dropped === '' ? '' : ` (dropped as too common: ${dropped})`} and nothing matched.${statistics}${omitted}`;
    default:
      return `Searched for ${kept}${dropped === '' ? '' : ` (dropped as too common: ${dropped})`}: ${search.matched_documents} document${search.matched_documents === 1 ? '' : 's'} matched.${statistics}${omitted}`;
  }
};

/**
 * A run that completed **past its budget cap** (PROGRESS backlog 466, BD-010's 2026-10-05
 * amendment). The CLI acknowledged a valid artifact in the turn that crossed the cap, so the platform
 * kept the artifact. The run's terminal reason, `error_max_budget_usd`, is the record of the overrun,
 * and its cost is counted like any other run's.
 */
export const crossedBudgetCap = (run: Pick<RunRecord, 'status' | 'terminal_reason'>): boolean =>
  run.status === 'completed' && run.terminal_reason === 'error_max_budget_usd';

/**
 * The run page's tabs, in order. `docs/user-guide.md` § 5 names each one in bold and says how many
 * there are; `user-guide-census.test.ts` holds the two together (WP-129).
 */
export const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'context', label: 'Context pack' },
  { id: 'settings', label: 'Settings' },
];

/** How many of the newest *Live activity* rows the run page shows under its *Now:* line. */
export const LIVE_ACTIVITY_ROWS = 5;

type Effort = 'low' | 'medium' | 'high' | '';

/** Elapsed: to now while the run is live, to its end once it ended. */
const elapsedOf = (record: RunRecord, nowMs: number): string => {
  if (isLiveRun(record.status) || record.ended_at === null || record.ended_at === undefined) {
    return formatElapsed(record.started_at, nowMs);
  }
  const ended = Date.parse(record.ended_at);
  return formatElapsed(record.started_at, Number.isNaN(ended) ? nowMs : ended);
};

/**
 * Who executed the run (WP-283 (5)) — the run read's `seat`, the agents list's own shape: a named
 * remote worker, the platform's own server claimant, or `null` while no claimant took it (and for a
 * server that answers no seat at all). A worker's name is its owner's choice: untrusted text.
 */
export const executedByOf = (
  seat: RunSeat | null | undefined,
):
  | { readonly kind: 'worker'; readonly name: string | null; readonly user: string | null }
  | { readonly kind: 'server' }
  | null =>
  seat === null || seat === undefined
    ? null
    : seat.kind === 'server'
      ? { kind: 'server' }
      : { kind: 'worker', name: seat.worker_name, user: seat.user_name ?? null };

const ExecutedBy = ({
  seat,
  nowMs,
}: {
  readonly seat: RunSeat | null | undefined;
  readonly nowMs: number;
}): ReactElement => {
  const executed = executedByOf(seat);
  if (executed === null) {
    return <span className="text-base text-fg-muted">not claimed yet</span>;
  }
  if (executed.kind === 'server') {
    return <span className="text-base">the platform server</span>;
  }
  const pause = seat?.usage_pause ?? null;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-base break-all">
        {executed.name === null ? 'a remote worker' : <UntrustedText value={executed.name} />}{' '}
        {executed.user === null ? (
          '(worker)'
        ) : (
          <>
            (<UntrustedText value={executed.user} />
            ’s worker)
          </>
        )}
      </span>
      {/* WP-285: the worker's usage limit holds it — the Workers screen's own sentence. */}
      {pause === null || Date.parse(pause.until) <= nowMs ? null : (
        <span data-usage-pause="" className="text-sm text-fg-muted">
          {usagePauseWords(pause, nowMs)}
        </span>
      )}
    </span>
  );
};

/** The summary strip: what an Actions run's summary row says, with a definition for every number. */
const RunSummary = ({
  record,
  nowMs,
}: {
  readonly record: RunRecord & { readonly seat?: RunSeat | null };
  readonly nowMs: number;
}): ReactElement => (
  <Card>
    <div data-run-summary="" className="flex flex-wrap gap-x-10 gap-y-3">
      <Metric
        label="Status"
        value={
          <span className="inline-flex items-center gap-1.5 text-base">
            <StatusIcon status={RUN_STATUS_ICON[record.status]} decorative />
            {RUN_STATUS_LABEL[record.status]}
          </span>
        }
        definition="Where the run is: starting while its workspace is prepared, running once its agent was asked for, then how it ended."
      />
      <Metric
        label="Executed by"
        value={<ExecutedBy seat={record.seat} nowMs={nowMs} />}
        definition="Which claimant ran this run: the platform's own server, or a developer's remote worker named by its owner."
      />
      <Metric
        label="Model"
        value={
          <span className="font-mono text-base break-all">
            <UntrustedText value={record.model} />
          </span>
        }
        definition="The model this run was planned with."
      />
      <Metric
        label="Effort"
        value={<span className="text-base">{record.effort}</span>}
        definition="The reasoning effort this run was planned with."
      />
      <Metric
        label="Cost"
        value={formatRunCost(record.cost, { estimate: true })}
        definition="Provider-reported cost of this run. Estimated from the price list in local provider mode. Not measured when the run ended with no figure from the provider, which is not the same as free."
      />
      <Metric
        label="Elapsed"
        value={elapsedOf(record, nowMs)}
        definition="Wall-clock time since the run asked for its agent — to now while it runs, to its end once it ended; — while it is still starting."
      />
      <Metric
        label="Turns"
        value={formatInteger(record.num_turns)}
        definition="Assistant turns the SDK reported for this run."
      />
      <Metric
        label="Tokens"
        value={
          <span className="text-base whitespace-nowrap">
            {`${formatInteger(record.usage.input_tokens)} in · ${formatInteger(record.usage.output_tokens)} out · ${formatInteger(record.usage.cache_read_tokens)} cached`}
          </span>
        }
        definition="Uncached input tokens and output tokens billed for this run, then the input tokens served from the prompt cache, which are billed at a lower rate."
      />
    </div>
  </Card>
);

/** The run page's tabs as an underlined tab row; the panels are the screen's. */
const RunTabs = ({
  tab,
  onSelect,
}: {
  readonly tab: Tab;
  readonly onSelect: (tab: Tab) => void;
}): ReactElement => (
  <div role="tablist" aria-label="Run views" className="flex gap-1 border-b border-line">
    {TABS.map((item) => (
      <button
        key={item.id}
        type="button"
        role="tab"
        aria-selected={tab === item.id}
        onClick={() => {
          onSelect(item.id);
        }}
        className={cx(
          'relative my-1 rounded-md px-2 py-1.5 text-sm whitespace-nowrap hover:bg-muted',
          FOCUS_RING,
          tab === item.id ? 'font-semibold text-fg' : 'text-fg-muted hover:text-fg',
        )}
      >
        {item.label}
        {tab === item.id ? (
          <span
            aria-hidden="true"
            className="absolute inset-x-1 -bottom-1.5 h-0.5 rounded-full bg-selected"
          />
        ) : null}
      </button>
    ))}
  </div>
);

/** *Re-run with another model or effort…*: today's retry fields, in a dialog. */
const RetryDialog = ({
  record,
  open,
  onClose,
  pending,
  error,
  onRetry,
}: {
  readonly record: RunReadResponse;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onRetry: (choice: RetryModelChoice, effort: Effort) => void;
}): ReactElement => {
  // WP-167: both selects start on *Configured (…)*, which sends nothing (WP-159 ruling (c)).
  const [model, setModel] = useState<RetryModelChoice>(INITIAL_RETRY_MODEL_CHOICE);
  const [effort, setEffort] = useState<Effort>('');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      title="Re-run with another model or effort"
      description="A retry creates a new run of this stage; this run stays as it is. Configured (…) runs what the project's configuration gives the stage when you press the button."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            tone="primary"
            disabled={pending}
            onClick={() => {
              onRetry(model, effort);
            }}
          >
            Retry run
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* This run's own model and effort are ordinary options and are sent when chosen — for a
            run that was itself an override, "as before" is a choice, not the default. */}
        <div className="flex flex-wrap items-center gap-2">
          <RetryModelField
            current={record.model}
            configured={record.retry_defaults?.model ?? null}
            choice={model}
            onChange={setModel}
          />
          <select
            aria-label="Retry with effort"
            value={effort}
            onChange={(event) => {
              setEffort(event.target.value as Effort);
            }}
            className="rounded-md border border-line-input bg-inset px-2 py-1 text-sm text-fg"
          >
            <option value="">{configuredLabel(record.retry_defaults?.effort ?? null)}</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </div>
        {error === null ? null : (
          <ErrorNotice title="That retry was refused." error={error} detail={error.message} />
        )}
      </div>
    </Dialog>
  );
};

/** *Cancel run*'s confirmation: what cancelling does, before it does it. */
const CancelDialog = ({
  open,
  pending,
  onClose,
  onConfirm,
}: {
  readonly open: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): ReactElement => (
  <Dialog
    open={open}
    onOpenChange={(next) => {
      if (!next) {
        onClose();
      }
    }}
    title="Cancel this run?"
    description="The agent's session is stopped and the run ends cancelled, charged with what it had cost by then. The task is paused. Unfinished work is not saved — take the task over instead if you want it."
    footer={
      <>
        <Button onClick={onClose}>Keep it running</Button>
        <Button tone="danger" disabled={pending} onClick={onConfirm}>
          Cancel run
        </Button>
      </>
    }
  />
);

/** The run's live state in the one vocabulary: *Now: Reading files*, and the newest rows. */
const LiveNow = ({
  record,
  blocks,
  taskState,
  openAsks,
  nowMs,
}: {
  readonly record: RunRecord;
  readonly blocks: Parameters<typeof activityRows>[0];
  readonly taskState: Parameters<typeof activityOf>[0]['task_state'];
  readonly openAsks: number;
  readonly nowMs: number;
}): ReactElement => {
  const now = activityOf({
    run: record,
    latest: activityFromBlocks(blocks),
    role: record.role,
    task_state: taskState,
    open_asks: openAsks,
    now: nowMs,
  });
  const meta = ACTIVITY_META[now.activity];
  const rows = activityRows(blocks, { live: true }).slice(-LIVE_ACTIVITY_ROWS);
  return (
    <section aria-label="What the agent is doing" className="flex flex-col gap-2">
      <p data-run-now={now.activity} className="flex items-center gap-2 text-sm font-medium">
        <StatusIcon status={meta.icon} decorative />
        {`Now: ${now.detail ?? meta.label}`}
      </p>
      <ActivityList rows={rows} className="pl-6" />
    </section>
  );
};

const BackToTask = ({
  taskId,
  ticketKey,
  title,
}: {
  readonly taskId: string;
  readonly ticketKey: string | null;
  readonly title: string | null;
}): ReactElement => (
  <Link
    to="/tasks/$taskId"
    params={{ taskId }}
    className={cx(
      'inline-flex max-w-full items-center gap-1.5 rounded-sm hover:text-fg',
      FOCUS_RING,
    )}
  >
    <span className="inline-flex shrink-0">
      <ArrowLeftIcon size={16} />
    </span>
    {ticketKey === null ? (
      'Back to the task'
    ) : (
      <>
        {/* The key and the title are the tracker's text (BD-022). The key never breaks; the title
            gives way on a narrow screen (S-23.13a). */}
        <UntrustedText
          value={ticketKey}
          className="shrink-0 font-semibold whitespace-nowrap text-fg"
        />
        {title === null ? null : <UntrustedText value={title} className="min-w-0 truncate" />}
      </>
    )}
  </Link>
);

export const RunDetailScreen = ({ runId }: { readonly runId: string }): ReactElement => {
  useTopics([`run:${runId}`]);
  const { transcripts, now } = useServices();
  const run = useRun(runId);
  const messages = useRunMessages(runId);
  const commands = useRunCommands(runId);
  const commandLog = useRunCommandLog(runId);
  const [tab, setTab] = useState<Tab>('transcript');
  const [steer, setSteer] = useState('');
  const [dialog, setDialog] = useState<'cancel' | 'retry' | 'take_over' | null>(null);

  // The run's task: its key and title for the back link, its runs for the job list, and the
  // take-over control — `taken_over` lives on the task, not on a run.
  const task = useTask(run.data?.task_id ?? '', run.data !== undefined);
  const prompt = useRunPrompt(runId, tab === 'prompt');
  const contextPack = useRunContextPack(runId, tab === 'context');
  const settings = useRunSettings(runId, tab === 'settings');

  // The store is the source of truth for the transcript; `useRunMessages` only feeds it.
  const snapshot = useSyncExternalStore(
    (listener) => transcripts.subscribe(runId, listener),
    () => transcripts.snapshot(runId),
    () => transcripts.snapshot(runId),
  );

  if (run.isPending) {
    return <Loading label="Loading run…" />;
  }
  if (run.isError) {
    return <ErrorNotice title="Run could not be loaded." error={run.error} />;
  }

  const record = run.data;
  const nowMs = now();
  const live = isLiveRun(record.status);
  const detail = task.data;
  const jobs = jobsInStageOrder(
    detail === undefined || !detail.runs.some((entry) => entry.id === record.id)
      ? [...(detail?.runs ?? []), record]
      : detail.runs,
    detail?.stages ?? [],
  );
  const openAsks =
    detail === undefined
      ? 0
      : detail.questions.filter((question) => question.status === 'open').length +
        detail.approvals.filter((approval) => approval.status === 'pending').length;
  const takeOverOffered =
    detail !== undefined &&
    (detail.taken_over !== null ||
      (detail.task.state !== 'done' && detail.task.state !== 'cancelled'));

  const retry = (choice: RetryModelChoice, effort: Effort): void => {
    commands.retry.mutate(
      {
        taskId: record.task_id,
        ...retryModelRequest(choice),
        ...(effort === '' ? {} : { effort }),
      },
      {
        onSuccess: () => {
          setDialog(null);
        },
      },
    );
  };

  const actions: ReactNode = (
    <>
      {/* The only coloured action while the run is live (research/19 § 5.2), and it asks first. */}
      {live ? (
        <Button
          tone="danger"
          disabled={commands.cancel.isPending}
          onClick={() => {
            setDialog('cancel');
          }}
        >
          Cancel run
        </Button>
      ) : null}
      <ActionMenu
        trigger={
          <Button tone={isFailedRun(record.status) ? 'primary' : 'default'}>
            Re-run
            <TriangleDownIcon size={16} />
          </Button>
        }
      >
        <ActionMenuItem
          disabled={commands.retry.isPending}
          onSelect={() => {
            retry(INITIAL_RETRY_MODEL_CHOICE, '');
          }}
        >
          Re-run as configured
        </ActionMenuItem>
        <ActionMenuItem
          onSelect={() => {
            commands.retry.reset();
            setDialog('retry');
          }}
        >
          Re-run with another model or effort…
        </ActionMenuItem>
      </ActionMenu>
      <ActionMenu label="Run actions">
        {takeOverOffered && detail !== undefined ? (
          <>
            <ActionMenuItem
              onSelect={() => {
                setDialog('take_over');
              }}
            >
              {detail.taken_over === null ? 'Take over…' : 'Taken over: resume / hand back…'}
            </ActionMenuItem>
            <ActionMenuSeparator />
          </>
        ) : null}
        {/* Same-origin, through `safeHref` like every URL the app renders; the server answers it
            as an attachment, so the browser saves it rather than showing it. */}
        <ActionMenuLinkItem
          url={new URL(transcriptDownloadPath(record.id), window.location.origin).href}
          label="Download transcript"
        />
      </ActionMenu>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        back={
          <BackToTask
            taskId={record.task_id}
            ticketKey={detail?.task.ticket.key ?? null}
            title={detail?.task.ticket_title ?? null}
          />
        }
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusIcon status={RUN_STATUS_ICON[record.status]} size={24} decorative />
            {`${runSubject(record)} · attempt ${record.attempt}`}
          </span>
        }
        meta={
          crossedBudgetCap(record) || record.mode !== 'normal' ? (
            <>
              {crossedBudgetCap(record) ? <Badge tone="warning">budget cap crossed</Badge> : null}
              {record.mode === 'normal' ? null : <Badge>{record.mode}</Badge>}
            </>
          ) : undefined
        }
        actions={actions}
      />

      {commands.cancel.isError ? <ErrorNotice title="That cancel was refused." /> : null}
      {commands.cancel.isSuccess ? (
        <p className="text-xs text-fg-muted">
          {commands.cancel.data.command_id === null
            ? 'No process was running this session, so the run was ended here.'
            : 'Cancel accepted — the process running the agent stops the session and ends the run with what it cost; the commands below say when it was applied.'}
        </p>
      ) : null}
      {commands.retry.isError && dialog !== 'retry' ? (
        <ErrorNotice
          title="That retry was refused."
          error={commands.retry.error}
          detail={commands.retry.error.message}
        />
      ) : null}
      {commands.retry.isSuccess ? (
        <p className="text-xs text-fg-muted">
          A new run was requested; it appears in the task's run list.
        </p>
      ) : null}
      {detail?.taken_over === null || detail === undefined ? null : (
        <p className="text-xs text-fg-muted">
          This task is taken over by a person: the pipeline is paused until it is handed back, from
          the run actions menu.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <NavList
            stackBelow="lg"
            label="Runs of this task"
            groups={[
              {
                label: 'Runs',
                items: jobs.map((job) => ({
                  id: job.id,
                  label: jobLabel(job),
                  icon: <StatusIcon status={RUN_STATUS_ICON[job.status]} decorative />,
                  current: job.id === record.id,
                  render: (props) => (
                    <Link
                      to="/runs/$runId"
                      params={{ runId: job.id }}
                      className={props.className}
                      {...(props['aria-current'] === undefined
                        ? {}
                        : { 'aria-current': props['aria-current'] })}
                    >
                      {props.children}
                      <span className="sr-only">{`, ${RUN_STATUS_LABEL[job.status]}`}</span>
                    </Link>
                  ),
                })),
              },
            ]}
          />
          <DetailsDisclosure summary="Details" className="px-2">
            <div className="flex flex-col gap-2">
              {/* WP-112: whether the settings moved since the task's previous run, before anybody
                  opens the Settings tab. */}
              <RunSettingsLine run={record} runs={detail?.runs} />
              {/* Backlog 467: what the platform did with an unsuccessful run's unfinished work. */}
              <RunSavedWorkLine saved={record.saved_work} />
              <p className="text-xs text-fg-muted">
                {'Prompt version '}
                <UntrustedText value={record.prompt_version} className="font-mono" />
              </p>
            </div>
          </DetailsDisclosure>
        </aside>

        <div className="flex min-w-0 flex-col gap-3">
          <RunSummary record={record} nowMs={nowMs} />
          {live ? (
            <LiveNow
              record={record}
              blocks={snapshot.blocks}
              taskState={detail?.task.state ?? null}
              openAsks={openAsks}
              nowMs={nowMs}
            />
          ) : null}

          <RunTabs tab={tab} onSelect={setTab} />

          {/* Backlog 453: a run whose workspace never started has no transcript to show, and an
              empty one read as "nothing happened yet". The reason is shown in its place — and since
              WP-154 (b′) for a run a person cancelled before its CLI was asked to start, too. */}
          {tab === 'transcript' && record.start_failure !== null ? (
            <RunNotStartedPanel failure={record.start_failure} stopped={isStoppedRun(record)} />
          ) : null}

          {tab === 'transcript' && record.start_failure === null ? (
            <div className="flex flex-col gap-3">
              {messages.isError ? (
                <ErrorNotice
                  title="The transcript page could not be loaded."
                  detail="Live frames still arrive on the stream; what happened before this screen opened is missing."
                />
              ) : null}
              {/* The log pane is its own scroll container sized to the viewport, so following
                  the end and "paused, N behind" work on it and the page does not grow. */}
              <TranscriptView
                blocks={snapshot.blocks}
                scrollerClassName="h-[max(20rem,calc(100dvh-16rem))]"
              />
              {/* `created` is live but has no session yet: the server refuses a steer there
                  (`run_not_live`), so the box appears once the run is claimed. */}
              {record.status === 'starting' || record.status === 'running' ? (
                <form
                  data-steer=""
                  className="sticky bottom-0 z-10 flex gap-2 border-t border-line bg-canvas py-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    commands.steer.mutate(steer, {
                      onSuccess: () => {
                        setSteer('');
                      },
                    });
                  }}
                >
                  <input
                    aria-label="Steer the agent"
                    value={steer}
                    onChange={(event) => {
                      setSteer(event.target.value);
                    }}
                    placeholder="Send a message to the running agent…"
                    className="min-w-0 flex-1 rounded-md border border-line-input bg-inset px-2 py-1 text-sm"
                  />
                  <Button
                    type="submit"
                    tone="primary"
                    disabled={commands.steer.isPending || steer.trim() === ''}
                  >
                    Steer
                  </Button>
                </form>
              ) : null}
              {commands.steer.isError ? (
                <ErrorNotice title="That steer was not accepted: the run may have ended, or you sent one within the last five seconds (the limit is one message per five seconds)." />
              ) : null}
              {commands.steer.isSuccess ? (
                <p className="text-xs text-fg-muted">
                  Accepted. The agent runs in another process, which applies the message — whether
                  it did is shown under “Commands sent to this run”.
                </p>
              ) : null}
              {commandLog.isError ? (
                <ErrorNotice
                  title="What became of the commands sent to this run could not be loaded."
                  error={commandLog.error}
                />
              ) : null}
              <RunCommandLog commands={commandLog.data?.items ?? []} />
            </div>
          ) : null}
          {tab === 'prompt' ? (
            <div className="flex flex-col gap-3">
              <SectionHeading>Prompt snapshot</SectionHeading>
              {prompt.isPending ? <Loading label="Loading prompt…" /> : null}
              {prompt.isError ? (
                <ErrorNotice title="The prompt could not be loaded." error={prompt.error} />
              ) : null}
              {prompt.data === undefined ? null : (
                <>
                  <p className="font-mono text-xs text-fg-muted">
                    <UntrustedText value={prompt.data.prompt_version} />
                  </p>
                  {prompt.data.prompts_withheld === null ? null : (
                    // WP-121 (PROGRESS backlog 363): why the project's prompt files are not below.
                    <ErrorNotice
                      title="The project’s prompt files were withheld from this prompt."
                      detail={[
                        prompt.data.prompts_withheld.reason,
                        ...prompt.data.prompts_withheld.integrations.map(
                          (entry) => `${entry.integration}: ${entry.reason}`,
                        ),
                      ].join(' — ')}
                    />
                  )}
                  <CodeText value={prompt.data.system_prompt} />
                  <CodeText value={prompt.data.user_prompt} />
                </>
              )}
            </div>
          ) : null}

          {tab === 'context' ? (
            <div className="flex flex-col gap-3">
              <SectionHeading>Context pack</SectionHeading>
              {contextPack.isPending ? <Loading label="Loading context pack…" /> : null}
              {contextPack.isError ? (
                <ErrorNotice
                  title="The context pack could not be loaded."
                  error={contextPack.error}
                />
              ) : null}
              {contextPack.data === undefined ? null : (
                <Card>
                  <div className="grid grid-cols-3 gap-4 pb-3">
                    <Metric
                      label="Budget"
                      value={formatInteger(contextPack.data.budget_tokens)}
                      definition="Token budget the context assembler was allowed to spend."
                    />
                    <Metric
                      label="Used"
                      value={formatInteger(contextPack.data.total_tokens)}
                      definition="Tokens the assembled pack actually cost."
                    />
                    <Metric
                      label="Documents"
                      value={formatInteger(admittedDocuments(contextPack.data))}
                      definition="Knowledge-base documents this run was shown: the unconditional tier 0 and the tier-1 documents that were admitted. A tier-1 page whose paths: rule matched nothing in the repository is listed below as not admitted and is not counted."
                    />
                  </div>
                  {textSearchText(contextPack.data) === null ? (
                    <p className="pb-2 text-xs text-fg-muted">
                      This run’s pack was recorded before the text search’s outcome was.
                    </p>
                  ) : (
                    <p className="pb-2 text-xs text-fg-muted">
                      {/* The terms are words of the ticket: somebody else's text (BD-022). */}
                      <UntrustedText value={textSearchText(contextPack.data) ?? ''} />
                    </p>
                  )}
                  <ul className="flex flex-col gap-1 text-xs">
                    {contextPack.data.tier0.map((entry) => (
                      <li key={entry.path} className="flex gap-2 font-mono">
                        <UntrustedText value={entry.path} />
                        <span className="ml-auto text-fg-muted">{formatInteger(entry.tokens)}</span>
                      </li>
                    ))}
                    {contextPack.data.tier1.map((entry) => (
                      <li key={entry.path} className="flex gap-2 font-mono">
                        <UntrustedText value={entry.path} />
                        {entry.validated ? null : (
                          <span data-not-admitted="true">
                            <Badge tone="warning">
                              not admitted — its paths: did not resolve at the indexed commit
                            </Badge>
                          </span>
                        )}
                        <span className="ml-auto text-fg-muted">{formatInteger(entry.tokens)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          ) : null}

          {tab === 'settings' ? <RunSettingsPanel query={settings} /> : null}

          {/* An ask run has no stage to give feedback on (backlog 493). */}
          {record.stage === null ? null : (
            <FeedbackForm
              heading={`Feedback on the ${stageLabel(record.stage)} stage`}
              hint="Scoped to the stage rather than to this attempt: a run is one attempt, and the retrospective reads the stage."
              pending={commands.feedback.isPending}
              failed={commands.feedback.isError}
              accepted={commands.feedback.isSuccess}
              onSubmit={(input) => {
                if (record.stage !== null) {
                  commands.feedback.mutate({
                    taskId: record.task_id,
                    stage: record.stage,
                    ...input,
                  });
                }
              }}
            />
          )}
        </div>
      </div>

      <CancelDialog
        open={dialog === 'cancel'}
        pending={commands.cancel.isPending}
        onClose={() => {
          setDialog(null);
        }}
        onConfirm={() => {
          setDialog(null);
          commands.cancel.mutate('cancelled from the UI');
        }}
      />
      <RetryDialog
        record={record}
        open={dialog === 'retry'}
        onClose={() => {
          setDialog(null);
        }}
        pending={commands.retry.isPending}
        error={commands.retry.error}
        onRetry={retry}
      />
      {detail === undefined ? null : (
        <Dialog
          open={dialog === 'take_over'}
          onOpenChange={(next) => {
            if (!next) {
              setDialog(null);
            }
          }}
          size="lg"
          title={detail.taken_over === null ? 'Take over this task' : 'Hand the task back'}
          description={`${sanitiseUntrusted(detail.task.ticket.key)} — the take-over is the task's, whichever run you opened it from.`}
        >
          <TakeOverPanel
            taskId={detail.task.id}
            state={detail.task.state}
            merged={detail.stages.some((entry) => entry.stage === 'merged_gate')}
            takenOver={detail.taken_over}
            runs={detail.runs}
          />
        </Dialog>
      )}
    </div>
  );
};
