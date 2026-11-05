/**
 * The command palette and the shortcuts sheet (research/19 § 5.1, § 3 rule 10) — a lazy chunk,
 * imported the first time either is opened (`keyboard.tsx`), so the initial graph carries neither.
 *
 * **Hand-written, on Base UI's Dialog**, rather than `cmdk`, which technical/09's stack line names:
 * cmdk brings its own Radix dialog (a second modal implementation beside Base UI's, with its own
 * focus trap and portal) for a list this size, which a filter, a sort and the APG combobox pattern
 * cover in one file. The pattern, as the WAI-ARIA Authoring Practices write it for a combobox whose
 * popup is a listbox: the field is `role="combobox"` with `aria-controls` naming the listbox,
 * `aria-autocomplete="list"`, `aria-expanded` and `aria-activedescendant` pointing at the active
 * option, so the focus **stays in the field** while ↓/↑ move the active option and Enter takes it.
 * Escape is the Dialog's (it closes, and the focus returns to what opened it).
 *
 * **What it offers comes from reads already made** — no endpoint of its own: the organisation's
 * screens (`NAV`), the current project's tabs, every project in the projects read, every task in
 * whichever project task reads are in the query cache (the board's, Home's escalated tasks, the
 * `+` menu's), and the actions — New project (an administrator's, as in the `+` menu), Start a
 * ticket in this project (when the tasks read says the caller may), Open inbox, and the shortcuts
 * sheet. There is no theme action: the application has one theme, dark (TD-033 as amended). A
 * project's name and key, a ticket's key and its title are somebody's text (BD-022): they are matched as strings and rendered as text nodes (`UntrustedText`), and an
 * option's `id` is its position, never its text.
 */
import type { ProjectSummary, TaskListItem, TasksResponse } from '@platform/contracts';
import { SearchIcon } from '@primer/octicons-react/SearchIcon';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cx } from '../ui/cx.js';
import { Dialog } from '../ui/dialog.js';
import { UntrustedText } from '../ui/untrusted.js';
import { NAV } from './nav.js';
import {
  PROJECT_TABS,
  type ProjectTab,
  requestStartTicket,
  START_TICKET_ANCHOR,
} from './project-frame.js';
import { useProjects } from './queries.js';
import { SHORTCUT_GROUPS, useShortcutsEnabled } from './shortcuts.js';

export type PaletteAction = 'new-project' | 'start-ticket' | 'inbox' | 'shortcuts';

/** Where an option goes, or what it does — never a closure, so the list is plain data. */
export type PaletteTarget =
  | { readonly kind: 'screen'; readonly to: (typeof NAV)[number]['to'] }
  | { readonly kind: 'tab'; readonly projectKey: string; readonly tab: ProjectTab }
  | { readonly kind: 'project'; readonly projectKey: string }
  | { readonly kind: 'task'; readonly taskId: string; readonly projectKey: string | null }
  | { readonly kind: 'action'; readonly action: PaletteAction };

export type PaletteGroup = 'Screen' | 'Project' | 'Task' | 'Action';

export interface PaletteItem {
  /** Unique in the list; a React key, never an attribute. */
  readonly key: string;
  readonly group: PaletteGroup;
  readonly label: string;
  /** A second line: a project's key, a ticket's title — untrusted where it comes from a read. */
  readonly detail: string | null;
  /** Further words that match it, never shown. */
  readonly keywords: readonly string[];
  readonly target: PaletteTarget;
}

export interface PaletteContext {
  readonly projects: readonly ProjectSummary[];
  readonly tasks: readonly TaskListItem[];
  /** The project the page is in, if any. */
  readonly current: ProjectSummary | null;
  readonly canCreateProject: boolean;
  /** Whether the current project's tasks read says the caller may start a ticket. */
  readonly canStartTicket: boolean;
}

/** Every option the palette can offer here, in its resting order (actions, screens, projects, tasks). */
export const paletteItems = (context: PaletteContext): PaletteItem[] => {
  const items: PaletteItem[] = [];
  if (context.canCreateProject) {
    items.push({
      key: 'action:new-project',
      group: 'Action',
      label: 'New project',
      detail: null,
      keywords: ['onboarding', 'create', 'wizard'],
      target: { kind: 'action', action: 'new-project' },
    });
  }
  if (context.current !== null && context.canStartTicket) {
    items.push({
      key: 'action:start-ticket',
      group: 'Action',
      label: 'Start a ticket in this project',
      detail: context.current.name,
      keywords: ['new task', 'create'],
      target: { kind: 'action', action: 'start-ticket' },
    });
  }
  items.push(
    {
      key: 'action:inbox',
      group: 'Action',
      label: 'Open inbox',
      detail: null,
      keywords: ['questions', 'approvals'],
      target: { kind: 'action', action: 'inbox' },
    },
    {
      key: 'action:shortcuts',
      group: 'Action',
      label: 'Keyboard shortcuts',
      detail: null,
      keywords: ['keys', 'help'],
      target: { kind: 'action', action: 'shortcuts' },
    },
  );
  for (const entry of NAV) {
    items.push({
      key: `screen:${entry.to}`,
      group: 'Screen',
      label: entry.label,
      detail: null,
      keywords: [],
      target: { kind: 'screen', to: entry.to },
    });
  }
  if (context.current !== null) {
    for (const { tab, label } of PROJECT_TABS) {
      items.push({
        key: `tab:${tab}`,
        group: 'Screen',
        label,
        detail: context.current.name,
        keywords: [context.current.key],
        target: { kind: 'tab', projectKey: context.current.key, tab },
      });
    }
  }
  for (const project of context.projects) {
    items.push({
      key: `project:${project.id}`,
      group: 'Project',
      label: project.name,
      detail: project.key,
      keywords: [],
      target: { kind: 'project', projectKey: project.key },
    });
  }
  const keyOf = new Map(context.projects.map((project) => [project.id, project.key]));
  const seen = new Set<string>();
  for (const task of context.tasks) {
    if (seen.has(task.id)) {
      continue;
    }
    seen.add(task.id);
    items.push({
      key: `task:${task.id}`,
      group: 'Task',
      label: task.ticket.key,
      detail: task.ticket_title,
      keywords: [],
      target: { kind: 'task', taskId: task.id, projectKey: keyOf.get(task.project_id) ?? null },
    });
  }
  return items;
};

/** The most a query shows: enough to scroll, few enough to read. */
export const MAX_RESULTS = 50;

/**
 * The options a query keeps, best first: an option some word of which **starts** with the query
 * before one that only **contains** it, the resting order kept within each. An empty query shows
 * everything but the tasks — there may be hundreds, and a key is what one is found by.
 */
export const filterPalette = (items: readonly PaletteItem[], query: string): PaletteItem[] => {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return items.filter((item) => item.group !== 'Task').slice(0, MAX_RESULTS);
  }
  const scored: { readonly item: PaletteItem; readonly score: number; readonly order: number }[] =
    [];
  items.forEach((item, order) => {
    const words = [item.label, item.detail ?? '', ...item.keywords].map((word) =>
      word.toLowerCase(),
    );
    if (words.some((word) => word.startsWith(needle))) {
      scored.push({ item, score: 0, order });
    } else if (words.some((word) => word.includes(needle))) {
      scored.push({ item, score: 1, order });
    }
  });
  return scored
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, MAX_RESULTS)
    .map(({ item }) => item);
};

/** Every task in the project task reads the cache holds — the board's, Home's, the `+` menu's. */
const useCachedTasks = (open: boolean): readonly TaskListItem[] => {
  const queryClient = useQueryClient();
  // Read when the palette opens; a task that lands while it is open is there next time.
  return useMemo(() => {
    if (!open) {
      return [];
    }
    return queryClient
      .getQueriesData<TasksResponse>({ queryKey: ['project'] })
      .filter(([key, data]) => key[2] === 'tasks' && data !== undefined)
      .flatMap(([, data]) => data?.items ?? []);
  }, [open, queryClient]);
};

export const CommandPalette = ({
  open,
  onOpenChange,
  onShowShortcuts,
  current,
  canCreateProject,
  canStartTicket,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onShowShortcuts: () => void;
  readonly current: ProjectSummary | null;
  readonly canCreateProject: boolean;
  readonly canStartTicket: boolean;
}): ReactElement => {
  const navigate = useNavigate();
  const projects = useProjects();
  const tasks = useCachedTasks(open);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const listId = `${id}-results`;
  const optionId = (index: number): string => `${id}-option-${String(index)}`;

  const items = useMemo(
    () =>
      paletteItems({
        projects: projects.data?.items ?? [],
        tasks,
        current,
        canCreateProject,
        canStartTicket,
      }),
    [projects.data, tasks, current, canCreateProject, canStartTicket],
  );
  const results = useMemo(() => filterPalette(items, query), [items, query]);
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);

  // Every opening starts empty, at the first option.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // The active option stays in view as ↓/↑ move it.
  useEffect(() => {
    if (activeIndex >= 0) {
      list.current
        ?.querySelector(`[data-option-index="${String(activeIndex)}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIndex]);

  const choose = (item: PaletteItem): void => {
    onOpenChange(false);
    const { target } = item;
    switch (target.kind) {
      case 'screen':
        void navigate({ to: target.to });
        return;
      case 'project':
        void navigate({ to: '/projects/$key', params: { key: target.projectKey } });
        return;
      case 'tab':
        void navigateToTab(navigate, target.projectKey, target.tab);
        return;
      case 'task':
        void (target.projectKey === null
          ? navigate({ to: '/tasks/$taskId', params: { taskId: target.taskId } })
          : navigate({
              to: '/projects/$key/tasks/$taskId',
              params: { key: target.projectKey, taskId: target.taskId },
            }));
        return;
      case 'action':
        switch (target.action) {
          case 'new-project':
            void navigate({ to: '/onboarding' });
            return;
          case 'start-ticket':
            if (current !== null) {
              requestStartTicket();
              void navigate({
                to: '/projects/$key',
                params: { key: current.key },
                hash: START_TICKET_ANCHOR,
              });
            }
            return;
          case 'inbox':
            void navigate({ to: '/inbox' });
            return;
          case 'shortcuts':
            onShowShortcuts();
            return;
        }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + results.length) % results.length);
      }
    } else if (event.key === 'Enter') {
      const item = results[activeIndex];
      if (item !== undefined) {
        event.preventDefault();
        choose(item);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search or jump to"
      description="A screen, a project, a ticket key or an action. ↑ ↓ to move, Enter to go, Esc to close."
      initialFocus={field}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 focus-within:outline-2 focus-within:outline-focus">
          <SearchIcon size={16} className="shrink-0 text-fg-muted" />
          <input
            ref={field}
            type="text"
            role="combobox"
            aria-label="Search or jump to"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            {...(activeIndex >= 0 ? { 'aria-activedescendant': optionId(activeIndex) } : {})}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-fg outline-none placeholder:text-fg-subtle"
            placeholder="Type to search"
          />
        </div>
        <p role="status" className="sr-only">
          {results.length === 0
            ? 'Nothing matches.'
            : `${String(results.length)} ${results.length === 1 ? 'result' : 'results'}.`}
        </p>
        {results.length === 0 ? (
          <p className="px-2 text-sm text-fg-muted">
            Nothing matches. A task is found by its ticket key once its project’s board has been
            opened.
          </p>
        ) : null}
        <div ref={list} id={listId} role="listbox" aria-label="Results" className="flex flex-col">
          {results.map((item, index) => (
            // The options are chosen through the field (`aria-activedescendant`), so none takes the
            // focus (`tabIndex={-1}`); the pointer chooses one by clicking, the pattern's mouse half.
            // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard half is the field's onKeyDown.
            <div
              key={item.key}
              tabIndex={-1}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              data-option-index={index}
              data-palette-group={item.group}
              onMouseMove={() => {
                if (index !== activeIndex) {
                  setActive(index);
                }
              }}
              onClick={() => {
                choose(item);
              }}
              className={cx(
                'flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5 text-sm',
                index === activeIndex ? 'bg-subtle text-fg' : 'text-fg',
              )}
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span
                  className={cx(
                    'shrink-0 font-semibold',
                    item.group === 'Task' ? 'font-mono text-xs' : null,
                  )}
                >
                  <UntrustedText value={item.label} />
                </span>
                {item.detail === null ? null : (
                  <span className="min-w-0 truncate text-xs text-fg-muted">
                    <UntrustedText value={item.detail} />
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-fg-muted">{item.group}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
};

/** A project tab's route: the paths are literals, so each is type-checked (as `project-frame.tsx`). */
const navigateToTab = (
  navigate: ReturnType<typeof useNavigate>,
  key: string,
  tab: ProjectTab,
): Promise<void> => {
  switch (tab) {
    case 'board':
      return navigate({ to: '/projects/$key', params: { key } });
    case 'knowledge':
      return navigate({ to: '/projects/$key/knowledge', params: { key } });
    case 'pipeline':
      return navigate({ to: '/projects/$key/pipeline', params: { key } });
    case 'budgets':
      return navigate({ to: '/projects/$key/budgets', params: { key } });
    case 'shadow':
      return navigate({ to: '/projects/$key/shadow', params: { key } });
    case 'settings':
      return navigate({ to: '/projects/$key/settings', params: { key } });
  }
};

/** The `?` sheet: every shortcut, grouped, and where to turn the single keys off. */
export const ShortcutsSheet = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement => {
  const enabled = useShortcutsEnabled();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description={
        enabled
          ? 'None of them fire while you type in a field.'
          : 'Single-key shortcuts are off in this browser; ⌘ K or Ctrl K still opens the search.'
      }
      footer={
        <Link
          to="/settings/$section"
          params={{ section: 'keyboard' }}
          onClick={() => {
            onOpenChange(false);
          }}
          className="text-sm text-link hover:underline"
        >
          {enabled ? 'Turn them off in Settings' : 'Turn them on in Settings'}
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.label} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-fg-muted">{group.label}</h3>
            <dl className="flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <div key={row.keys.join(' ')} className="flex items-center justify-between gap-4">
                  <dt className="text-sm">{row.does}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {row.keys.map((key) => (
                      <kbd
                        key={key}
                        className="rounded border border-line bg-subtle px-1.5 py-0.5 font-mono text-xs"
                      >
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
};
