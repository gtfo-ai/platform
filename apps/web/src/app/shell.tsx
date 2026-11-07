/**
 * The application shell — the frame of every signed-in screen (TD-033 § 1; research/19 § 5.1).
 *
 * **The top bar** is deep night (TD-033 § 2, the brand anchor the wordmark lives on), the page's own
 * colour since TD-033's 2026-11-05 amendment, so its bottom border is what separates the two. Left
 * to right: the wordmark (Home); inside a project, `/ <name> ▾`, the
 * breadcrumb that is also the project switcher; then **Search or jump to…** (the command palette,
 * and the keyboard shortcuts behind it — `app/keyboard.tsx`), the running indicator with the
 * connection dot, the `+` menu, the inbox with its count, the Settings gear (S-25.6), and the avatar
 * menu. Menus are Base UI's
 * (`ui/action-menu.tsx`) and portalled to `<body>`, drawn on the card ground (`bg-default`).
 *
 * **The second row** is the organisation's UnderlineNav (`NAV`, the five daily screens since S-25.6)
 * outside a project; inside one, the project's own layout (`app/project-frame.tsx`) draws its header
 * and tabs instead, as a GitHub repository replaces the dashboard's navigation. Settings — and with
 * it the Admin screens, Integrations, Workers and the Audit log — is the top bar's gear (from `sm`;
 * on a phone the account menu's entry, which every width keeps) and `g s`.
 *
 * **Both rows stick** while the page scrolls (S-23.18) — the top bar always, the second row from
 * `sm` (inside a project only its tabs; the project's title scrolls away). `styles.css` declares
 * their heights and the `scroll-padding-top` that keeps a focused or anchored target out from under
 * them.
 *
 * The connection state is not decoration. This app never polls (see `queries.ts`), so a stream
 * that has stopped delivering is a screen that has silently stopped updating — the failure product
 * /10 cares about most ("live updates everywhere, no refresh"). The dot is the one place that says
 * whether the promise is being kept, its word is shown whenever the stream is not live, and it is
 * `aria-live` so it is announced rather than only shown.
 */

import type { ProjectSummary } from '@platform/contracts';
import { DeviceDesktopIcon } from '@primer/octicons-react/DeviceDesktopIcon';
import { GearIcon } from '@primer/octicons-react/GearIcon';
import { InboxIcon } from '@primer/octicons-react/InboxIcon';
import { PlayIcon } from '@primer/octicons-react/PlayIcon';
import { PlusIcon } from '@primer/octicons-react/PlusIcon';
import { RepoIcon } from '@primer/octicons-react/RepoIcon';
import { SignOutIcon } from '@primer/octicons-react/SignOutIcon';
import { TriangleDownIcon } from '@primer/octicons-react/TriangleDownIcon';
import { useQueryClient } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { type ReactElement, useSyncExternalStore } from 'react';
import { displayName, type SessionUser } from '../auth/session.js';
import { ORG_ADMIN_LINKS } from '../features/settings-sections.js';
import { useRealtime, useTopics } from '../realtime/provider.js';
import {
  ActionMenu,
  ActionMenuHeader,
  ActionMenuItem,
  ActionMenuRadioGroup,
  ActionMenuRadioItem,
  ActionMenuSeparator,
} from '../ui/action-menu.js';
import { Avatar } from '../ui/avatar.js';
import { buttonClassName } from '../ui/button.js';
import { Counter } from '../ui/counter.js';
import { FOCUS_RING } from '../ui/cx.js';
import { Flash } from '../ui/flash.js';
import { USER_ROLE_LABEL } from '../ui/humanize.js';
import { type BadgeTone, Button, cx, formatInteger } from '../ui/kit.js';
import { Logo } from '../ui/logo.js';
import type { NavItem, NavLinkProps } from '../ui/nav-item.js';
import { StatusIcon } from '../ui/status.js';
import { inboxRows } from '../ui/task-status.js';
import { Tooltip } from '../ui/tooltip.js';
import { UnderlineNav } from '../ui/underline-nav.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { CommandLayer } from './keyboard.js';
import { isCurrentSection, NAV } from './nav.js';
import { pageWidth, requestStartTicket, START_TICKET_ANCHOR } from './project-frame.js';
import { useAgents, useInbox, useProjects, useProjectTasks, useSession } from './queries.js';
import { useRunFrame } from './run-frame.js';
import { useServices } from './services.js';

export { isCurrentSection, NAV } from './nav.js';

/**
 * The counts the frame shows: projects, what waits for a person (the Inbox's rows — open
 * questions, pending approvals, held CI jobs and stopped tasks, `ui/task-status.ts`' `inboxRows`)
 * and the runs in flight (the agents read, the Home screen's "Agents running"). `undefined` while
 * a read has no answer — the frame then draws no number, never a zero it does not know (rule 16).
 */
export interface FrameCounts {
  readonly projects: number | undefined;
  readonly inbox: number | undefined;
  readonly running: number | undefined;
}

export const useFrameCounts = (): FrameCounts => {
  const projects = useProjects();
  const inbox = useInbox();
  const agents = useAgents();
  return {
    projects: projects.data?.items.length,
    // The Inbox's own rows (`ui/task-status.ts`): a held CI job (BACKLOG 1300) and, since S-25.15
    // part B, a task stopped for a person are rows too.
    inbox: inbox.data === undefined ? undefined : inboxRows(inbox.data).total,
    running: agents.data?.items.length,
  };
};

/** Status → what a human is told, and in which colour. Pure, so it is asserted directly. */
export const connectionLabel = (
  status: string,
): { readonly text: string; readonly tone: BadgeTone } => {
  switch (status) {
    case 'open':
      return { text: 'Live', tone: 'success' };
    case 'connecting':
      return { text: 'Connecting', tone: 'neutral' };
    case 'reconnecting':
      return { text: 'Reconnecting', tone: 'warning' };
    case 'server_shutdown':
      return { text: 'Server restarting', tone: 'warning' };
    case 'closed':
      return { text: 'Disconnected', tone: 'danger' };
    default:
      return { text: 'Idle', tone: 'neutral' };
  }
};

/**
 * The avatar menu: who is signed in, *Settings* and "Sign out". The trigger is named "Account
 * menu"; there is no theme choice (one dark theme, TD-033's 2026-11-05 amendment). Settings is here
 * rather than in the top row since S-25.6 (product/10's 2026-11-06 IA amendment), as GitHub's is.
 */
const AccountMenu = ({
  user,
  onSignOut,
}: {
  readonly user: SessionUser | null;
  readonly onSignOut: () => void;
}): ReactElement => {
  const navigate = useNavigate();
  const name = user === null ? 'Not signed in' : displayName(user);
  return (
    <ActionMenu
      trigger={
        <button
          type="button"
          aria-label="Account menu"
          className={cx(
            'inline-flex items-center gap-1 rounded-full p-0.5 pr-1 text-fg-muted hover:text-fg',
            FOCUS_RING,
          )}
        >
          <Avatar name={name} size={24} decorative />
          <TriangleDownIcon size={16} />
        </button>
      }
    >
      <ActionMenuHeader>
        {user === null ? (
          'Not signed in'
        ) : (
          <>
            Signed in as <span className="font-semibold text-fg">{name}</span>
            <span className="block">{`Role: ${USER_ROLE_LABEL[user.role]}`}</span>
          </>
        )}
      </ActionMenuHeader>
      {user === null ? null : (
        <>
          <ActionMenuSeparator />
          <ActionMenuItem
            leadingIcon={<GearIcon size={16} />}
            onSelect={() => {
              void navigate({ to: '/settings' });
            }}
          >
            Settings
          </ActionMenuItem>
          <ActionMenuItem leadingIcon={<SignOutIcon size={16} />} onSelect={onSignOut}>
            Sign out
          </ActionMenuItem>
        </>
      )}
    </ActionMenu>
  );
};

/**
 * **"The platform was updated — reload this page"** (WP-154 (d), PROGRESS backlog 487): shown once
 * the server answers `/api/version` with a different build from this bundle's
 * (`platform-version.ts`). A screen whose read was refused for it shows nothing of its own
 * (`ErrorNotice`), so this banner is the one place the page says it — instead of a schema error that
 * reads as a server fault.
 */
export const PlatformUpdatedBanner = (): ReactElement | null => {
  const { platform } = useServices();
  const updated = useSyncExternalStore(platform.subscribe, platform.updated, platform.updated);
  if (!updated) {
    return null;
  }
  return (
    <Flash
      tone="info"
      live="alert"
      data-testid="platform-updated"
      className="rounded-none border-x-0 border-t-0"
      title="The platform was updated — reload this page."
      action={
        // `default`, not the beacon (S-23.23): the banner sits above every screen, and that screen
        // keeps its own one primary action.
        <Button
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </Button>
      }
    >
      This tab still runs the previous version, which cannot read the new server's answers.
    </Flash>
  );
};

/** The connection's dot, by the badge tone the words already had. */
export const CONNECTION_DOT: Readonly<Record<BadgeTone, string>> = {
  success: 'bg-success',
  warning: 'bg-attention',
  danger: 'bg-danger',
  neutral: 'bg-fg-muted',
  accent: 'bg-link',
};

/**
 * "● 2 running", with the stream's state beside it (research/19 § 5.1). The count is the agents
 * read and links to Agents; it pulses amber while anything runs, and stands still under reduced
 * motion (`.status-running`). The connection is a dot inside the same pill, and its word is
 * visible whenever it is **not** live — a stream that stopped is the failure this app most needs to
 * say (see the module's docblock) — and screen-reader text when it is. The live region keeps its
 * `role="status"`, `aria-live` and `data-testid="connection-status"`, and its text is exactly the
 * word, so the realtime spec reads it unchanged.
 */
export const RunningIndicator = ({
  running,
  status,
}: {
  readonly running: number | undefined;
  readonly status: string;
}): ReactElement => {
  const connection = connectionLabel(status);
  return (
    <div className="inline-flex h-8 items-center rounded-full border border-line text-sm">
      <Link
        to="/agents"
        className={cx(
          'inline-flex h-full items-center gap-1.5 rounded-l-full pr-2 pl-2.5 text-fg hover:bg-subtle',
          FOCUS_RING,
        )}
      >
        <StatusIcon
          status={running !== undefined && running > 0 ? 'running' : 'queued'}
          decorative
          size={12}
        />
        {/* Below `sm` the count stands alone, so the top bar fits a 390 px phone (S-23.13a); the
            word stays for a screen reader. */}
        <span className="tabular-nums">
          {running === undefined ? (
            'Agents'
          ) : (
            <>
              {formatInteger(running)}
              <span className="max-sm:sr-only"> running</span>
            </>
          )}
        </span>
      </Link>
      <span aria-hidden="true" className="h-4 w-px bg-line" />
      <span
        data-testid="connection-status"
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-1.5 pr-2.5 pl-2 text-xs text-fg-muted"
      >
        <span
          aria-hidden="true"
          data-connection-dot={connection.tone}
          className={cx('size-2 rounded-full', CONNECTION_DOT[connection.tone])}
        />
        <span className={connection.tone === 'success' ? 'sr-only' : undefined}>
          {connection.text}
        </span>
      </span>
    </div>
  );
};

/**
 * `/ <Project name> ▾` — the breadcrumb and the project switcher (research/19 § 5.1): every project
 * by key and name, the current one checked, then *All projects* and *New project*. A project name
 * is somebody's text (BD-022), so it renders through `UntrustedText`, and the trigger's name is
 * sanitised before it reaches the attribute.
 */
export const ProjectSwitcher = ({
  current,
  projects,
  canCreateProject = false,
}: {
  readonly current: ProjectSummary;
  readonly projects: readonly ProjectSummary[];
  /** The projects read's `can_create` (S-23.23): *New project* is offered only then. */
  readonly canCreateProject?: boolean;
}): ReactElement => {
  const navigate = useNavigate();
  return (
    <ActionMenu
      align="start"
      trigger={
        <button
          type="button"
          aria-label={`${sanitiseUntrusted(current.name)}, switch project`}
          className={cx(
            'inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-semibold text-fg hover:bg-subtle',
            FOCUS_RING,
          )}
        >
          <UntrustedText value={current.name} className="truncate" />
          <TriangleDownIcon size={16} />
        </button>
      }
    >
      <ActionMenuRadioGroup
        label="Switch project"
        value={current.key}
        onValueChange={(key: string) => {
          void navigate({ to: '/projects/$key', params: { key } });
        }}
      >
        {projects.map((project) => (
          <ActionMenuRadioItem key={project.id} value={project.key} closeOnClick>
            <span className="font-mono text-xs text-fg-muted">
              <UntrustedText value={project.key} />
            </span>
            <UntrustedText value={project.name} className="truncate" />
          </ActionMenuRadioItem>
        ))}
      </ActionMenuRadioGroup>
      <ActionMenuSeparator />
      <ActionMenuItem
        leadingIcon={<RepoIcon size={16} />}
        onSelect={() => {
          void navigate({ to: '/projects' });
        }}
      >
        All projects
      </ActionMenuItem>
      {canCreateProject ? (
        <ActionMenuItem
          leadingIcon={<PlusIcon size={16} />}
          onSelect={() => {
            void navigate({ to: '/onboarding' });
          }}
        >
          New project
        </ActionMenuItem>
      ) : null}
    </ActionMenu>
  );
};

/**
 * `+ ▾`: *New project* for a caller the projects read says may create one (`can_create`, the create
 * route's own `project.create`, S-23.23 — so nobody else is offered a wizard whose first command
 * answers 403), *Add a worker* for everybody signed in (`worker.register` is any active user's —
 * TD-031 §10c, the approver is the worker's owner — S-23.20), *Start a ticket…* inside a project
 * whose tasks read says the caller may start one (`can_start_task`) — it opens the board's start
 * form, the one place a ticket is started. With none of them, there is no menu.
 */
const CreateMenu = ({
  project,
  canCreateProject,
  canAddWorker,
}: {
  readonly project: ProjectSummary | null;
  readonly canCreateProject: boolean;
  readonly canAddWorker: boolean;
}): ReactElement | null => {
  const navigate = useNavigate();
  const tasks = useProjectTasks(project?.id ?? null);
  const canStart = project !== null && tasks.data?.can_start_task === true;
  if (!canCreateProject && !canAddWorker && !canStart) {
    return null;
  }
  return (
    <ActionMenu
      trigger={
        <button
          type="button"
          aria-label="Create new…"
          className={cx(
            'inline-flex h-8 items-center gap-0.5 rounded-md border border-line px-1.5 text-fg-muted hover:bg-subtle hover:text-fg',
            FOCUS_RING,
          )}
        >
          <PlusIcon size={16} />
          <span className="inline-flex max-sm:hidden">
            <TriangleDownIcon size={16} />
          </span>
        </button>
      }
    >
      {canCreateProject ? (
        <ActionMenuItem
          leadingIcon={<RepoIcon size={16} />}
          onSelect={() => {
            void navigate({ to: '/onboarding' });
          }}
        >
          New project
        </ActionMenuItem>
      ) : null}
      {canAddWorker ? (
        <ActionMenuItem
          leadingIcon={<DeviceDesktopIcon size={16} />}
          onSelect={() => {
            void navigate({ to: '/workers/new' });
          }}
        >
          Add a worker
        </ActionMenuItem>
      ) : null}
      {project === null || !canStart ? null : (
        <ActionMenuItem
          leadingIcon={<PlayIcon size={16} />}
          onSelect={() => {
            requestStartTicket();
            void navigate({
              to: '/projects/$key',
              params: { key: project.key },
              hash: START_TICKET_ANCHOR,
            });
          }}
        >
          Start a ticket…
        </ActionMenuItem>
      )}
    </ActionMenu>
  );
};

/** The inbox, as GitHub's notification button: an icon, a beacon count when something waits. */
export const InboxButton = ({ count }: { readonly count: number | undefined }): ReactElement => (
  <Link
    to="/inbox"
    aria-label={
      // Never just "Inbox": that is the navigation's link, and the two are different controls.
      count === undefined
        ? 'Open the inbox'
        : count === 0
          ? 'Open the inbox, nothing waiting for you'
          : `Open the inbox, ${formatInteger(count)} waiting for you`
    }
    data-inbox-count={count ?? ''}
    className={cx(buttonClassName('invisible'), 'relative size-8 px-0 py-0')}
  >
    <InboxIcon size={16} />
    {count === undefined || count === 0 ? null : (
      <Counter count={count} tone="primary" className="absolute -top-1.5 -right-1.5" />
    )}
  </Link>
);

/**
 * The Settings gear (S-25.6): Settings left the top row, and its Admin group — Integrations,
 * Workers, the Audit log — is two presses from anywhere through it. Current on Settings and on every
 * Admin screen (`aria-current`, as the row's entries are). Hidden below `sm`, where the top bar has
 * no room for it; the account menu's *Settings* is there at every width.
 */
export const SettingsButton = (): ReactElement => {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current =
    isCurrentSection('/settings', pathname) ||
    ORG_ADMIN_LINKS.some((link) => isCurrentSection(link.to, pathname));
  return (
    <Tooltip content="Settings" side="bottom">
      <Link
        to="/settings"
        aria-label="Settings"
        {...(current ? { 'aria-current': 'page' as const } : {})}
        // Exact: `/settings` itself redirects, so the router never marks it; `current` above is the
        // one judgement, and it counts the Admin screens as Settings' too.
        activeOptions={{ exact: true }}
        className={cx(
          buttonClassName('invisible'),
          'size-8 px-0 py-0 max-sm:hidden',
          current ? 'text-fg' : undefined,
        )}
      >
        <GearIcon size={16} />
      </Link>
    </Tooltip>
  );
};

/** The org navigation's items, as UnderlineNav takes them: a router link, a menu target, a count. */
const useOrgNavItems = (counts: FrameCounts): NavItem[] => {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return NAV.map((entry) => {
    const Glyph = entry.icon;
    const count = entry.count === undefined ? undefined : counts[entry.count];
    return {
      id: entry.to,
      label: entry.label,
      icon: <Glyph size={16} />,
      ...(count === undefined || count === 0 ? {} : { counter: count }),
      current: isCurrentSection(entry.to, pathname),
      ...(entry.collapseBelow === undefined ? {} : { collapseBelow: entry.collapseBelow }),
      // `exact` for Home: the router would otherwise call `/` active everywhere and stamp its own
      // `aria-current` on it. Every other entry is current on its section, as the router judges too.
      render: (props: NavLinkProps) => (
        <Link to={entry.to} activeOptions={{ exact: entry.to === '/' }} {...props} />
      ),
      onSelect: () => {
        void navigate({ to: entry.to });
      },
    };
  });
};

/** The overflow of the org navigation on a narrow screen (GitHub's `···`). */
const NavMore = ({ items }: { readonly items: readonly NavItem[] }): ReactElement => (
  <ActionMenu label="More navigation" align="start">
    {items.map((item) => (
      <ActionMenuItem
        key={item.id}
        leadingIcon={item.icon}
        {...(item.onSelect === undefined ? {} : { onSelect: item.onSelect })}
      >
        {item.label}
        {/* The page you are on, when it has collapsed in here: said in words, so a screen reader
            hears it too (the row's underline is not in the menu). */}
        {item.current === true ? (
          <span data-nav-current="" className="text-xs text-fg-muted">
            (current)
          </span>
        ) : null}
        {item.counter === undefined ? null : <Counter count={item.counter} className="ml-auto" />}
      </ActionMenuItem>
    ))}
  </ActionMenu>
);

/** Whether the matched routes ask for the full width (the board, a run's log). */
const useFullWidth = (): boolean =>
  useMatches({
    select: (matches) => matches.some((match) => match.staticData?.fullWidth === true),
  });

export const AppShell = (): ReactElement => {
  const session = useSession();
  const { auth } = useServices();
  const { status } = useRealtime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = session.data?.user ?? null;
  // The counts move with the organisation, whichever screen is open (the Home screen also asks).
  useTopics(['org']);
  const counts = useFrameCounts();
  const projects = useProjects();
  // Inside a project the route has a `$key`; the switcher names the project it resolves to. A
  // run's page has none in its URL and sits in its run's project's frame (S-25.4).
  const routeKey = useParams({ strict: false, select: (params) => params.key });
  const runFrame = useRunFrame();
  const key = routeKey ?? (runFrame.kind === 'framed' ? runFrame.project.key : undefined);
  // A run's page draws its own width and, once its project is known, its project's bands; while
  // that is being asked it draws no navigation row at all, rather than the organisation's row it
  // would take back a moment later (review of PR #80).
  const orgRow = key === undefined && runFrame.kind !== 'pending';
  const routeOwnsWidth = key !== undefined || runFrame.kind !== 'none';
  const project =
    key === undefined
      ? null
      : (projects.data?.items.find((item) => item.key === key || item.id === key) ?? null);
  const orgItems = useOrgNavItems(counts);
  const fullWidth = useFullWidth();
  // S-23.23: the server's answer (`project.create` over the caller's role), never a role compared here.
  const canCreateProject = projects.data?.can_create === true;

  return (
    <div className="flex min-h-full flex-col">
      {/* Sticky (S-23.18): above the page and the flow canvas / office (`z-20`), below a
          full-screen canvas (`z-30`), a dialog's backdrop (`z-40`) and every portalled menu,
          tooltip and the palette (`z-50`). The heights are `styles.css`'s `--app-*-height`. */}
      <header className="sticky top-0 z-20 border-b border-line bg-header text-fg">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-6">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className={cx('shrink-0 rounded-sm py-1', FOCUS_RING)}
          >
            <Logo label="Agentic" className="w-20" />
          </Link>
          {project === null ? null : (
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
              <span aria-hidden="true" className="pl-1 text-fg-subtle">
                /
              </span>
              <ProjectSwitcher
                current={project}
                projects={projects.data?.items ?? []}
                canCreateProject={canCreateProject}
              />
            </nav>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <CommandLayer project={project} canCreateProject={canCreateProject} />
            <RunningIndicator running={counts.running} status={status} />
            <CreateMenu
              project={project}
              canCreateProject={canCreateProject}
              canAddWorker={user !== null}
            />
            <InboxButton count={counts.inbox} />
            <SettingsButton />
            <AccountMenu
              user={user}
              onSignOut={() => {
                void auth.signOut().then(async () => {
                  // The whole cache, not just the session: what is in it belongs to the account
                  // that is signing out, and the next person at this browser is not that account.
                  queryClient.clear();
                  await navigate({ to: '/sign-in', search: {} });
                });
              }}
            />
          </div>
        </div>
      </header>
      {orgRow ? (
        <UnderlineNav
          label="Primary"
          items={orgItems}
          className="bg-canvas px-4 sm:sticky sm:z-20 sm:top-(--app-bar-height) sm:px-6"
          more={(collapsed) => <NavMore items={collapsed} />}
        />
      ) : null}
      <PlatformUpdatedBanner />
      {/* A screen that throws is contained here rather than taking the header with it: every
          route match carries `defaultErrorComponent` (`routes/tree.tsx`), which is the boundary
          the router puts *inside* this outlet. A second boundary wrapped around the outlet would
          sit behind that one and could never fire (standing rule 22), so the backstop is one ring
          further out instead — `ErrorBoundary` in `app/app.tsx`, which catches what the router
          cannot see. `ui/error-boundary.tsx` records the measurement behind that split.

          Inside a project the project's layout (`app/project-frame.tsx`) draws its own header band
          and widths, as a run's page does (`routes/run-route.tsx`); everywhere else the shell
          centres the screen. The `<Outlet/>` is always inside the same `<div>` — only its class
          changes — so a page whose frame arrives late is never remounted (review of PR #80). */}
      <main className="min-h-0 flex-1">
        <div className={routeOwnsWidth ? undefined : cx(pageWidth(fullWidth), 'py-6')}>
          <Outlet />
        </div>
      </main>
    </div>
  );
};
