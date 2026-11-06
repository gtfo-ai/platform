/**
 * The project's layout route (`/projects/$key`, research/19 § 5.1): the project header and its
 * tabs, with the screen below as the `<Outlet/>`.
 *
 * Inside a project the shell drops the organisation's navigation and this band takes the second
 * row, as a GitHub repository's header and tabs replace the dashboard's: the PageHeader (the
 * project's name, its key muted, the readiness label, and **Start a ticket** — the page's one
 * primary — for a caller the tasks read says may start one) and the UnderlineNav of the project's
 * sections. **No URL changed**: the board is the index child and every sub-page, the task route
 * included, is a child of this one (`routes/tree.tsx`).
 *
 * Which tab is current is the matched route's own `staticData.tab`, never a parse of the path, and a
 * task's page is the Board's. A task page has its own `<h1>` (the ticket key), so above it the
 * project's name is not a heading (`staticData.ownsHeading`): one `<h1>` per page.
 *
 * The project is resolved here once, for every child: while it loads the band is a skeleton; a
 * failed read or an unknown key is said here and **no child is rendered**, so a screen below never
 * has to answer for a project that is not there.
 */
import { BookIcon } from '@primer/octicons-react/BookIcon';
import { CreditCardIcon } from '@primer/octicons-react/CreditCardIcon';
import { EyeIcon } from '@primer/octicons-react/EyeIcon';
import { GearIcon } from '@primer/octicons-react/GearIcon';
import { ProjectIcon } from '@primer/octicons-react/ProjectIcon';
import { WorkflowIcon } from '@primer/octicons-react/WorkflowIcon';
import { Link, Outlet, useMatches } from '@tanstack/react-router';
import { type ReactElement, useSyncExternalStore } from 'react';
import { ReadinessLabel } from '../features/readiness-label.js';
import { useTopics } from '../realtime/provider.js';
import { buttonClassName } from '../ui/button.js';
import { Badge, cx, EmptyState, ErrorNotice } from '../ui/kit.js';
import type { NavItem, NavLinkProps } from '../ui/nav-item.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { UnderlineNav } from '../ui/underline-nav.js';
import { UntrustedText } from '../ui/untrusted.js';
import { useProjectByKey, useProjectTasks } from './queries.js';

/** The board's start form's id: the header's *Start a ticket* and the `+` menu's both go there. */
export const START_TICKET_ANCHOR = 'start-ticket';

/**
 * One count per *Start a ticket* press, so the board's form takes the focus on **every** press — a
 * second press on the board itself is the same location, which the router does not navigate to
 * again, so the hash alone changes only the first time.
 */
let startTicketRequests = 0;
const startTicketListeners = new Set<() => void>();

export const requestStartTicket = (): void => {
  startTicketRequests += 1;
  for (const listener of startTicketListeners) {
    listener();
  }
};

const subscribeStartTicket = (listener: () => void): (() => void) => {
  startTicketListeners.add(listener);
  return () => {
    startTicketListeners.delete(listener);
  };
};

const readStartTicket = (): number => startTicketRequests;

/** The number of *Start a ticket* presses so far: a dependency that changes on each one. */
export const useStartTicketRequests = (): number =>
  useSyncExternalStore(subscribeStartTicket, readStartTicket, readStartTicket);

/** The project's sections, in order — the `staticData.tab` each child route declares. */
export const PROJECT_TABS = [
  { tab: 'board', label: 'Board', icon: ProjectIcon },
  { tab: 'knowledge', label: 'Knowledge', icon: BookIcon },
  { tab: 'pipeline', label: 'Pipeline', icon: WorkflowIcon },
  { tab: 'budgets', label: 'Budgets', icon: CreditCardIcon },
  { tab: 'shadow', label: 'Shadow', icon: EyeIcon },
  { tab: 'settings', label: 'Settings', icon: GearIcon },
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number]['tab'];

/** The link each tab is: the route paths are literals, so every one is type-checked. */
const tabLink = (tab: ProjectTab, key: string, props: NavLinkProps): ReactElement => {
  switch (tab) {
    case 'board':
      // `exact`: the router would call the board's link active on every page of the project and
      // stamp its own `aria-current`; the tab is current from `staticData.tab` alone.
      return (
        <Link to="/projects/$key" params={{ key }} activeOptions={{ exact: true }} {...props} />
      );
    case 'knowledge':
      return <Link to="/projects/$key/knowledge" params={{ key }} {...props} />;
    case 'pipeline':
      return <Link to="/projects/$key/pipeline" params={{ key }} {...props} />;
    case 'budgets':
      return <Link to="/projects/$key/budgets" params={{ key }} {...props} />;
    case 'shadow':
      return <Link to="/projects/$key/shadow" params={{ key }} {...props} />;
    case 'settings':
      return <Link to="/projects/$key/settings" params={{ key }} {...props} />;
  }
};

/** `max-w-[1280px]`, centred, as GitHub's `container-xl`; the board and a run's log take the page. */
export const pageWidth = (fullWidth: boolean): string =>
  cx('w-full px-4 sm:px-6', fullWidth ? null : 'mx-auto max-w-[1280px]');

interface FrameMatch {
  readonly tab: ProjectTab | undefined;
  readonly fullWidth: boolean;
  readonly ownsHeading: boolean;
}

const useFrameMatch = (): FrameMatch =>
  useMatches({
    select: (matches): FrameMatch => ({
      tab: matches.find((match) => match.staticData?.tab !== undefined)?.staticData?.tab,
      fullWidth: matches.some((match) => match.staticData?.fullWidth === true),
      ownsHeading: matches.some((match) => match.staticData?.ownsHeading === true),
    }),
    structuralSharing: true,
  });

export const ProjectFrame = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const { project, isPending, isError, error } = useProjectByKey(projectKey);
  const frame = useFrameMatch();

  if (isPending) {
    return (
      <div className={cx(pageWidth(false), 'py-6')}>
        <Skeleton label="Loading project…" lines={3} />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={cx(pageWidth(false), 'py-6')}>
        <ErrorNotice title="Project could not be loaded." error={error} />
      </div>
    );
  }
  if (project === null) {
    return (
      <div className={cx(pageWidth(false), 'py-6')}>
        <EmptyState
          title="No such project"
          hint={`No project has the key "${projectKey}". Check the link, or pick one from the project list.`}
          action={
            <Link to="/projects" className={buttonClassName('default')}>
              All projects
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <ProjectBands project={project} />
      <div data-project-page="" className={cx(pageWidth(frame.fullWidth), 'py-6')}>
        <Outlet />
      </div>
    </div>
  );
};

/**
 * The project's header band and its tab row — the frame without the page under it. `ProjectFrame`
 * draws it above the `<Outlet/>`; a run's page (`/runs/$runId`, S-25.4) draws it above its own
 * screen once `app/run-frame.ts` names the run's project, and keeps the screen where it was.
 */
export const ProjectBands = ({
  project,
}: {
  readonly project: NonNullable<ReturnType<typeof useProjectByKey>['project']>;
}): ReactElement => {
  const tasks = useProjectTasks(project.id);
  const frame = useFrameMatch();
  useTopics([`project:${project.id}`]);
  const items: NavItem[] = PROJECT_TABS.map(({ tab, label, icon: Glyph }) => ({
    id: tab,
    label,
    icon: <Glyph size={16} />,
    current: (frame.tab ?? 'board') === tab,
    render: (props: NavLinkProps) => tabLink(tab, project.key, props),
  }));
  // The header's primary only on the board itself: a sub-page and a task's page each keep their
  // own one primary action (research/19 § 3.1), and the `+` menu still offers the start there.
  const canStart =
    tasks.data?.can_start_task === true && frame.tab === 'board' && !frame.ownsHeading;

  return (
    <>
      <div data-project-frame="" className="bg-canvas">
        <div className="w-full px-4 pt-4 sm:px-6">
          <PageHeader
            titleAs={frame.ownsHeading ? 'p' : 'h1'}
            divider={false}
            title={
              <span className="inline-flex flex-wrap items-baseline gap-x-2">
                <UntrustedText value={project.name} />
                <span className="font-mono text-sm font-normal text-fg-muted">
                  <UntrustedText value={project.key} />
                </span>
              </span>
            }
            state={
              <>
                <ReadinessLabel level={project.readiness_level} project={project} />
                {project.status === 'active' ? null : (
                  <Badge tone="neutral">{project.status}</Badge>
                )}
              </>
            }
            {...(canStart
              ? {
                  actions: (
                    <Link
                      to="/projects/$key"
                      params={{ key: project.key }}
                      hash={START_TICKET_ANCHOR}
                      // An action, not a place: never marked as the current page.
                      activeOptions={{ exact: true, includeHash: true }}
                      onClick={requestStartTicket}
                      className={buttonClassName('primary')}
                    >
                      Start a ticket
                    </Link>
                  ),
                }
              : {})}
          />
        </div>
      </div>
      {/* The tab row sticks under the top bar from `sm` (S-23.18) and the title above it scrolls
          away: a sibling of the page rather than inside the band, because a sticky box only sticks
          within its parent. */}
      <div
        data-project-tabs=""
        className="border-b border-line bg-canvas px-4 sm:sticky sm:z-20 sm:top-(--app-bar-height) sm:px-6"
      >
        <UnderlineNav label="Project" items={items} bordered={false} />
      </div>
    </>
  );
};
