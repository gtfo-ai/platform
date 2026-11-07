/**
 * The project board (product/10 § "Board (project)", research/19 § 5.2 "Board"): GitHub Projects'
 * board look in the brand, and its *List* view (`?view=list`).
 *
 * Columns are task states rather than pipeline stages. That is a pre-existing narrowing of
 * product/10 — "stages from the project's pipeline template plus Queued / Needs human / Done (7d)"
 * — which research/19 keeps as open item O2 rather than widening here; the *stage* a task is in is
 * on the card, as its phase strip. Below `xl` the columns scroll sideways (snapping to a column)
 * instead of wrapping, so the pipeline still reads left to right.
 *
 * Both views read the **same** page (`useProjectTasks`): the list's filters — state, template,
 * needs you — are applied here, over what the board already holds, with no endpoint of their own.
 * The agents read (`useAgents`, one request for the organisation) says which tasks an agent is
 * working on, and what it is doing.
 *
 * **Whose tasks** (S-26.8b, the M26 UX spec § 3): a segmented control — *Everyone* · *Mine* ·
 * *Unassigned* — in the list box's header (and, on the board view, beside the view toggle, which is
 * the board's only header row). It is `?owner=me|none`, which the **server** applies (S-26.1), so
 * both views read the filtered page; it is remembered per person (`./board-owner-filter.ts`). A card
 * shows its owner's avatar (`./board-card.tsx`); the *Needs you* rule does not change with it.
 *
 * Drag is not supported by design: the pipeline owns state (product/10).
 */
import { createTaskRequestSchema, type TaskListItem, type TaskState } from '@platform/contracts';
import { ListUnorderedIcon } from '@primer/octicons-react/ListUnorderedIcon';
import { ProjectIcon } from '@primer/octicons-react/ProjectIcon';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { START_TICKET_ANCHOR, useStartTicketRequests } from '../app/project-frame.js';
import {
  useAgents,
  useProjectByKey,
  useProjectTasks,
  useSession,
  useStartTask,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { Blankslate } from '../ui/blankslate.js';
import { Bot } from '../ui/bot/bot.js';
import { buttonClassName } from '../ui/button.js';
import { Counter } from '../ui/counter.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { Dialog } from '../ui/dialog.js';
import { type BoardOwnerFilter, OWNER_WORDS, TASK_STATE_LABEL, titleCase } from '../ui/humanize.js';
import { Button, EmptyState, ErrorNotice, Field } from '../ui/kit.js';
import { ListBox, ListBoxHeader } from '../ui/list-box.js';
import { Select } from '../ui/select.js';
import { Skeleton } from '../ui/skeleton.js';
import { UntrustedText } from '../ui/untrusted.js';
import {
  type AgentEntry,
  type MenuCapabilities,
  needsYou,
  TaskCard,
  TaskRow,
} from './board-card.js';
import {
  boardOwnerFilter,
  ownerSearchValue,
  readStoredOwnerFilter,
  storeOwnerFilter,
  type UrlOwnerFilter,
} from './board-owner-filter.js';

/**
 * The columns, in pipeline order, and the column each state belongs to when nothing waits on a
 * person. Every state appears exactly once, so no task can be invisible. A paused task is *Active*
 * by its state: a pause somebody chose waits on nobody, and a pause only a person ends (a budget, a
 * take-over) is moved to *Needs you* by {@link boardColumnOf}, as every other waiting task is.
 */
export const BOARD_COLUMNS = [
  { id: 'queued', title: 'Queued', states: ['queued'] },
  { id: 'active', title: 'Active', states: ['active', 'returned', 'paused'] },
  {
    id: 'waiting',
    title: 'Needs you',
    states: ['waiting_answers', 'waiting_approval', 'needs_human'],
  },
  { id: 'review', title: 'Ready to merge', states: ['ready_for_merge', 'merged', 'retro'] },
  { id: 'done', title: 'Done', states: ['done', 'cancelled'] },
] as const;

/** The column a state belongs to by itself; a state this build has not heard of is *Active*. */
export const columnFor = (state: string): string =>
  BOARD_COLUMNS.find((column) => (column.states as readonly string[]).includes(state))?.id ??
  'active';

/** The *Needs you* column's id. */
export const NEEDS_YOU_COLUMN = 'waiting';

/**
 * The column a task is drawn in (S-25.4, product/10's 2026-11-06 Board amendment): *Needs you*
 * whenever `ui/task-status.ts`' `needsYou` says so — the rule the card's ◆ and the task header read
 * — whatever its stage; its state's column otherwise.
 */
export const boardColumnOf = (task: TaskListItem): string =>
  needsYou(task) ? NEEDS_YOU_COLUMN : columnFor(task.state);

/** Every published state, in the columns' order — the list view's state filter. */
const STATES_IN_ORDER: readonly TaskState[] = BOARD_COLUMNS.flatMap((column) => [...column.states]);

/** The empty board's title and what it teaches (product/10: "empty states teach"). */
export const EMPTY_BOARD_TITLE = 'Tickets you label for agents appear here';

/**
 * What an empty board says — **only what exists** (WP-122, PROGRESS backlog 379). The pick-up rules
 * a binding has are a label, a status, an epic or a query (`ticketMatchRuleSchema`); the start by
 * hand is named only to a caller it is offered to.
 */
export const emptyBoardHint = (canStart: boolean): string =>
  canStart
    ? "A task appears when a ticket matches this project's start rule — a label, a status, an epic or a query — or when you start one by its key."
    : "A task appears when a ticket matches this project's start rule — a label, a status, an epic or a query. A member of the project can also start one by its key.";

// ── The list view's filters ──────────────────────────────────────────────────

export interface BoardFilters {
  readonly state: TaskState | 'all';
  readonly template: string | 'all';
  readonly needsYou: boolean;
}

export const NO_FILTERS: BoardFilters = { state: 'all', template: 'all', needsYou: false };

/** The tasks a filter keeps, in the page's order (newest first). Pure, so it is tested alone. */
export const filterTasks = (
  items: readonly TaskListItem[],
  filters: BoardFilters,
): readonly TaskListItem[] =>
  items.filter(
    (task) =>
      (filters.state === 'all' || task.state === filters.state) &&
      (filters.template === 'all' || task.template === filters.template) &&
      (!filters.needsYou || needsYou(task)),
  );

/** `?view=list` — anything else is the board. */
export const BOARD_VIEWS = ['board', 'list'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

// ── Start a ticket ───────────────────────────────────────────────────────────

/**
 * product/04 S0's manual **Start** (WP-122, PROGRESS backlog 379): a ticket named by its key, for a
 * ticket no pickup rule matches.
 *
 * Rendered only for a caller who holds `task.create` in this project (`can_start_task`, the
 * server's own `can()` over the effective role); the route refuses everyone else regardless. The
 * key is checked against the contract's character set **before** it is sent, so a typo is a
 * sentence here rather than a `400`, and the server's refusal — no tracker bound, the ticket
 * already has a task, the tracker does not know the key — is shown as the server said it. A
 * success is a recorded match, not a task: intake creates the task, and the project topic puts it
 * on the board.
 */
export const StartTicketForm = ({
  projectId,
  inputRef,
}: {
  readonly projectId: string;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
}): ReactElement => {
  const start = useStartTask();
  const [key, setKey] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  return (
    <form
      id={START_TICKET_ANCHOR}
      aria-label="Start a ticket by its key"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = createTaskRequestSchema.safeParse({ ticket_key: key.trim() });
        if (!parsed.success) {
          setInvalid(
            'A ticket key is letters, digits, ".", "_" and "-", at most 64 characters — for example ACME-123.',
          );
          return;
        }
        setInvalid(null);
        setStarted(null);
        start.mutate(
          { projectId, ticket_key: parsed.data.ticket_key },
          {
            onSuccess: (answer) => {
              setStarted(answer.ticket.key);
              setKey('');
            },
          },
        );
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <Field
            {...(inputRef === undefined ? {} : { ref: inputRef })}
            label="Ticket key"
            hint="For a ticket no start rule matches. The limit on parallel tasks, How much agents do alone and one task per ticket still apply."
            placeholder="ACME-123"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </div>
        <Button type="submit" tone="primary" disabled={start.isPending || key.trim() === ''}>
          Start
        </Button>
      </div>
      {invalid === null ? null : <ErrorNotice title="That is not a ticket key." detail={invalid} />}
      {start.isError ? (
        <ErrorNotice title="The ticket was not started." error={start.error} />
      ) : null}
      {started === null ? null : (
        <p role="status" className="text-xs text-fg-muted">
          {'Started '}
          <UntrustedText value={started} />
          {' — its task appears on the board once intake has created it.'}
        </p>
      )}
    </form>
  );
};

/**
 * The start form, as a small Dialog. It opens on `#start-ticket` — the project header's *Start a
 * ticket*, the top bar's `+ → Start a ticket…` and Home's setup checklist all link there — and on
 * every further press (`useStartTicketRequests`, because a second press on the board is the same
 * URL); the key field takes the focus, so the next keystroke is the key. Closing it drops the hash.
 */
const StartTicketDialog = ({
  projectId,
  projectKey,
  open,
  onOpenChange,
}: {
  readonly projectId: string;
  readonly projectKey: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement => {
  const field = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && hash === START_TICKET_ANCHOR) {
          void navigate({
            to: '/projects/$key',
            params: { key: projectKey },
            // Keep the search as it is (`?view=list`): `true` rather than `(previous) => previous`,
            // whose `previous` is every route's search — the Agents page's `view` included.
            search: true,
            replace: true,
          });
        }
      }}
      title="Start a ticket"
      description="Start a task for a ticket by its key."
      initialFocus={field}
    >
      <StartTicketForm projectId={projectId} inputRef={field} />
    </Dialog>
  );
};

// ── The screen ───────────────────────────────────────────────────────────────

/** The view toggle: two links, the current one marked, so each view is addressable. */
const ViewToggle = ({
  projectKey,
  view,
  owner,
}: {
  readonly projectKey: string;
  readonly view: BoardView;
  /** The owner filter in the URL, kept across the toggle (S-26.8b). */
  readonly owner: UrlOwnerFilter | undefined;
}): ReactElement => {
  const ownerSearch = owner === undefined ? {} : { owner };
  const item = (current: boolean): string =>
    cx(
      'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium',
      current ? 'bg-default text-fg shadow-sm ring-1 ring-line' : 'text-fg-muted hover:text-fg',
      FOCUS_RING,
    );
  return (
    <nav aria-label="Board view" className="inline-flex gap-0.5 rounded-lg bg-subtle p-0.5">
      <Link
        to="/projects/$key"
        params={{ key: projectKey }}
        search={ownerSearch}
        activeOptions={{ exact: true, includeSearch: true }}
        aria-current={view === 'board' ? 'page' : undefined}
        className={item(view === 'board')}
      >
        <ProjectIcon size={16} />
        Board
      </Link>
      <Link
        to="/projects/$key"
        params={{ key: projectKey }}
        search={{ view: 'list', ...ownerSearch }}
        activeOptions={{ exact: true, includeSearch: true }}
        aria-current={view === 'list' ? 'page' : undefined}
        className={item(view === 'list')}
      >
        <ListUnorderedIcon size={16} />
        List
      </Link>
    </nav>
  );
};

/** The board's search with its owner filter set to `value`, or dropped for *Everyone*. */
const withOwner = (
  previous: Record<string, unknown>,
  value: UrlOwnerFilter | undefined,
): Record<string, unknown> => {
  const { owner: _dropped, ...rest } = previous;
  return value === undefined ? rest : { ...rest, owner: value };
};

const OWNER_FILTERS: readonly BoardOwnerFilter[] = ['all', 'me', 'none'];

/**
 * *Everyone* · *Mine* · *Unassigned* (S-26.8b, the M26 UX spec § 3): three pressed-state buttons
 * in one `<fieldset>` named by its legend, the view toggle's look. A press remembers the choice and moves the URL.
 */
export const OwnerFilterControl = ({
  value,
  onChange,
}: {
  readonly value: BoardOwnerFilter;
  readonly onChange: (next: BoardOwnerFilter) => void;
}): ReactElement => {
  const words = OWNER_WORDS['owner.filter'];
  return (
    <fieldset
      data-owner-filter={value}
      className="m-0 inline-flex min-w-0 gap-0.5 rounded-lg border-0 bg-subtle p-0.5"
    >
      <legend className="sr-only">{words.label}</legend>
      {OWNER_FILTERS.map((filter) => (
        <button
          key={filter}
          type="button"
          aria-pressed={value === filter}
          className={cx(
            'inline-flex h-7 items-center rounded-md px-2.5 text-sm font-medium',
            value === filter
              ? 'bg-default text-fg shadow-sm ring-1 ring-line'
              : 'text-fg-muted hover:text-fg',
            FOCUS_RING,
          )}
          onClick={() => {
            onChange(filter);
          }}
        >
          {words[filter]}
        </button>
      ))}
    </fieldset>
  );
};

/** What a board filtered to *Mine* or *Unassigned* says when it holds nothing. */
export const ownerFilterEmpty = (filter: Exclude<BoardOwnerFilter, 'all'>): string =>
  filter === 'me' ? OWNER_WORDS['owner.filter'].empty_me : OWNER_WORDS['owner.filter'].empty_none;

interface ViewProps {
  readonly items: readonly TaskListItem[];
  readonly projectKey: string;
  readonly projectId: string;
  readonly may: MenuCapabilities;
  readonly agents: ReadonlyMap<string, AgentEntry>;
  readonly nowMs: number;
  /** The signed-in person: *your machine* in a card's waiting words (S-26.8b part 2). */
  readonly viewerId: string | null;
}

const Columns = ({
  items,
  projectKey,
  projectId,
  may,
  agents,
  nowMs,
  viewerId,
}: ViewProps): ReactElement => (
  // It scrolls sideways below `xl`. Not a tab stop of its own: every card holds a link and a menu
  // button, and focusing one scrolls its column into view. `relative`, so the screen-reader-only
  // counts (`sr-only` is `position: absolute`) of a column scrolled out of view are clipped by this
  // box rather than positioned against the page — which they widened by 267 px at 1 024 (S-23.13a).
  <div
    data-board-columns=""
    className="relative flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 xl:grid xl:grid-cols-5 xl:overflow-visible"
  >
    {BOARD_COLUMNS.map((column) => {
      const tasks = items.filter((task) => boardColumnOf(task) === column.id);
      const beacon = column.id === NEEDS_YOU_COLUMN;
      return (
        <section
          key={column.id}
          aria-label={column.title}
          data-column={column.id}
          className={cx(
            'flex w-72 shrink-0 snap-start flex-col gap-2 rounded-lg border bg-subtle p-2 xl:w-auto',
            beacon ? 'border-running/50' : 'border-line',
          )}
        >
          <h3
            data-column-header={column.id}
            className="flex items-center gap-2 px-1 pt-0.5 text-sm font-semibold text-fg"
          >
            {beacon ? (
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-running" />
            ) : null}
            <span className={beacon ? 'text-running' : undefined}>{column.title}</span>
            <Counter
              count={tasks.length}
              tone={beacon && tasks.length > 0 ? 'primary' : 'default'}
              label={`${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
            />
          </h3>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              projectKey={projectKey}
              projectId={projectId}
              may={may}
              agent={agents.get(task.id)}
              nowMs={nowMs}
              viewerId={viewerId}
            />
          ))}
        </section>
      );
    })}
  </div>
);

const ListView = ({
  items,
  projectKey,
  projectId,
  may,
  agents,
  nowMs,
  viewerId,
  ownerControl,
}: ViewProps & {
  /** The owner filter, in the list box's header (S-26.8b). */
  readonly ownerControl: ReactNode;
}): ReactElement => {
  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const shown = filterTasks(items, filters);
  const templates = [...new Set(items.map((task) => task.template))].sort();
  const stateId = useId();
  const templateId = useId();
  return (
    <ListBox
      label="Tasks"
      header={
        <ListBoxHeader
          actions={
            filters === NO_FILTERS ? undefined : (
              <Button size="sm" tone="invisible" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </Button>
            )
          }
        >
          <span className="inline-flex items-center gap-2 font-semibold">
            Tasks
            <Counter
              count={shown.length}
              label={`${shown.length} of ${items.length} tasks shown`}
            />
          </span>
          {ownerControl}
          <span className="inline-flex items-center gap-1.5">
            <label htmlFor={stateId} className="text-fg-muted">
              State
            </label>
            <Select
              id={stateId}
              value={filters.state}
              onChange={(event) =>
                setFilters({ ...filters, state: event.target.value as BoardFilters['state'] })
              }
              controlSize="sm"
            >
              <option value="all">All</option>
              {STATES_IN_ORDER.map((state) => (
                <option key={state} value={state}>
                  {TASK_STATE_LABEL[state]}
                </option>
              ))}
            </Select>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <label htmlFor={templateId} className="text-fg-muted">
              Template
            </label>
            <Select
              id={templateId}
              value={filters.template}
              onChange={(event) => setFilters({ ...filters, template: event.target.value })}
              controlSize="sm"
            >
              <option value="all">All</option>
              {templates.map((template) => (
                <option key={template} value={template}>
                  {titleCase(template)}
                </option>
              ))}
            </Select>
          </span>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={filters.needsYou}
              onChange={(event) => setFilters({ ...filters, needsYou: event.target.checked })}
            />
            Needs you
          </label>
        </ListBoxHeader>
      }
    >
      {shown.length === 0 ? (
        <li data-board-quiet="" className="px-4 py-3 text-sm text-fg-muted">
          No task matches these filters.
        </li>
      ) : (
        shown.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            projectKey={projectKey}
            projectId={projectId}
            may={may}
            agent={agents.get(task.id)}
            nowMs={nowMs}
            viewerId={viewerId}
          />
        ))
      )}
    </ListBox>
  );
};

export const BoardScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const { project, isPending, isError, error } = useProjectByKey(projectKey);
  const search = useSearch({ strict: false }) as {
    readonly view?: string;
    readonly owner?: string;
  };
  // S-26.8b: the owner filter — the URL's, else this person's last choice, else *Everyone* — is
  // the server's `?owner=`, so both views read the filtered page.
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const stored = readStoredOwnerFilter(globalThis.localStorage, userId);
  const owner = boardOwnerFilter(search.owner, stored);
  // Held until the session read settles: before it, the remembered filter is unknown, and an
  // unfiltered read would go out first and then be replaced by the filtered one.
  const tasks = useProjectTasks(
    session.isPending ? null : (project?.id ?? null),
    undefined,
    ownerSearchValue(owner),
    true,
  );
  const agents = useAgents();
  const { now } = useServices();
  const view: BoardView = search.view === 'list' ? 'list' : 'board';
  const navigate = useNavigate();
  const ownerInUrl = search.owner === 'me' || search.owner === 'none' ? search.owner : undefined;
  // A board URL with no filter opens this person's last one, and says so in the URL.
  useEffect(() => {
    if (ownerInUrl === undefined && stored !== null) {
      void navigate({
        to: '/projects/$key',
        params: { key: projectKey },
        search: (previous: Record<string, unknown>) => withOwner(previous, stored),
        // Keep `#start-ticket`: the start dialog opens on it once the page is read.
        hash: true,
        replace: true,
      });
    }
  }, [ownerInUrl, stored, navigate, projectKey]);
  const chooseOwner = (next: BoardOwnerFilter): void => {
    storeOwnerFilter(globalThis.localStorage, userId, next);
    void navigate({
      to: '/projects/$key',
      params: { key: projectKey },
      search: (previous: Record<string, unknown>) => withOwner(previous, ownerSearchValue(next)),
      hash: true,
    });
  };
  useTopics(project === null ? [] : [`project:${project.id}`]);

  // The header's *Start a ticket* and the `+` menu's land on `#start-ticket`; keyed on the press
  // count as well as the hash, because a second press on the board is the same URL.
  const hash = useLocation({ select: (location) => location.hash });
  const requests = useStartTicketRequests();
  const canStart = tasks.data?.can_start_task === true;
  const [startOpen, setStartOpen] = useState(false);
  useEffect(() => {
    if (hash === START_TICKET_ANCHOR && canStart && requests >= 0) {
      setStartOpen(true);
    }
  }, [hash, requests, canStart]);

  if (isPending) {
    return <Skeleton label="Loading project…" lines={3} />;
  }
  if (isError) {
    return <ErrorNotice title="Project could not be loaded." error={error} />;
  }
  if (project === null) {
    return (
      <EmptyState
        title="No such project"
        hint={`No project has the key "${projectKey}". Check the link, or pick one from the dashboard.`}
      />
    );
  }

  const nowMs = now();
  const items = tasks.data?.items ?? [];
  const ownerControl = <OwnerFilterControl value={owner} onChange={chooseOwner} />;
  // The live run per task; the read is the organisation's, so a run of another project is ignored.
  const live = new Map<string, AgentEntry>();
  for (const entry of agents.data?.items ?? []) {
    if (entry.project_id === project.id && !live.has(entry.task_id)) {
      live.set(entry.task_id, entry);
    }
  }
  const viewProps: ViewProps = {
    items,
    projectKey: project.key,
    projectId: project.id,
    // The page's own answer for this caller; a page not read yet offers neither.
    may: {
      cancel: tasks.data?.can_cancel_task === true,
      returnToStage: tasks.data?.can_return_to_stage === true,
      pause: tasks.data?.can_pause_task === true,
      resume: tasks.data?.can_resume_task === true,
    },
    agents: live,
    nowMs,
    viewerId: userId,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* The project's name, its sections and *Start a ticket* are the project frame's header and
          tabs (`app/project-frame.tsx`); the board is the frame's index page. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ViewToggle projectKey={project.key} view={view} owner={ownerSearchValue(owner)} />
        {/* On the list view the filter is in the list box's header; the board has no such row. */}
        {view === 'board' ? ownerControl : null}
      </div>

      {tasks.isError ? (
        <ErrorNotice title="Tasks could not be loaded." error={tasks.error} />
      ) : null}
      {tasks.isPending ? <Skeleton label="Loading tasks…" lines={3} /> : null}

      {/* A filtered board with nothing in it is not an empty project: the filter says so. */}
      {tasks.isSuccess && items.length === 0 && owner !== 'all' && view === 'board' ? (
        <p data-board-owner-empty={owner} className="text-sm text-fg-muted">
          {ownerFilterEmpty(owner)}
        </p>
      ) : null}

      {tasks.isSuccess && items.length === 0 && owner === 'all' ? (
        <Blankslate
          size="spacious"
          icon={<Bot pose="sleeping" scale={2} />}
          title={EMPTY_BOARD_TITLE}
          hint={emptyBoardHint(canStart)}
          action={
            <Link
              to="/projects/$key/settings"
              params={{ key: project.key }}
              className={buttonClassName('default')}
            >
              Open start rules
            </Link>
          }
          {...(canStart
            ? {
                secondary: (
                  <Button tone="invisible" onClick={() => setStartOpen(true)}>
                    Start a ticket by hand
                  </Button>
                ),
              }
            : {})}
        />
      ) : null}

      {tasks.isSuccess && (items.length > 0 || owner !== 'all') ? (
        view === 'list' ? (
          <ListView {...viewProps} ownerControl={ownerControl} />
        ) : items.length > 0 ? (
          <Columns {...viewProps} />
        ) : null
      ) : null}

      {canStart ? (
        <StartTicketDialog
          projectId={project.id}
          projectKey={project.key}
          open={startOpen}
          onOpenChange={setStartOpen}
        />
      ) : null}
    </div>
  );
};
