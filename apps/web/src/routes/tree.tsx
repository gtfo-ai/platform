/**
 * The route tree (technical/09 § "Structure").
 *
 * **Code-based, not file-based.** technical/09 says "file-based routes"; TanStack Router's
 * file-based mode generates `routeTree.gen.ts` at dev and build time, which is a second piece of
 * generated output in a repository that already treats generated output as something to be checked
 * for staleness (`pnpm schemas:check`). Committing it needs a `routes:check` step; not committing
 * it breaks `pnpm typecheck`, which reads every app's `src` tree from disk. The paths below are exactly
 * the ones technical/09 lists, they are typed end to end, and adopting the plugin later changes
 * this file and nothing else. Recorded as Q44 with the recommendation implemented here.
 *
 * **Everything below `authenticatedRoute` requires a session.** The guard runs in `beforeLoad`, so
 * an unauthenticated deep link redirects before any component mounts and before any query fires.
 * It is a *convenience*, not a security control: every endpoint is authorised server-side on every
 * request (`auth/plugin.ts`), and a client-side guard is one `devtools` away from being bypassed.
 *
 * **`/runs/$runId` is lazy.** TD-013 puts the bundle budget on the initial graph and says the run
 * route is lazy; the transcript renderer is the largest thing in the app, and a user on the board
 * has not opened it.
 */

import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import type { ReactElement } from 'react';
import * as z from 'zod';
import { queryKeys } from '../api/keys.js';
import type { Services } from '../app/services.js';
import { AppShell } from '../app/shell.js';
import { AgentsScreen } from '../features/agents.js';
import { AuditScreen } from '../features/audit.js';
import { BoardScreen } from '../features/board.js';
import { DashboardScreen } from '../features/dashboard.js';
import { InboxScreen } from '../features/inbox.js';
import { IntegrationsScreen } from '../features/integrations.js';
import { BudgetsScreen, KnowledgeScreen, PipelineScreen } from '../features/project-panels.js';
import { SettingsScreen } from '../features/settings.js';
import { SignInScreen } from '../features/sign-in.js';
import { StatisticsScreen } from '../features/statistics.js';
import { TaskDetailScreen } from '../features/task-detail.js';
import { ErrorFallback } from '../ui/error-boundary.js';

export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly services: Services;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

const signInSearchSchema = z.object({ redirect: z.string().optional() });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: signInSearchSchema,
  component: SignInScreen,
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient
      .ensureQueryData({
        queryKey: [...queryKeys.session],
        queryFn: () => context.services.auth.getSession(),
      })
      .catch(() => null);
    if (session === null) {
      throw redirect({ to: '/sign-in', search: { redirect: location.href } });
    }
  },
  component: AppShell,
});

const route = <TPath extends string>(path: TPath, component: () => ReactElement) =>
  createRoute({ getParentRoute: () => authenticatedRoute, path, component });

const dashboardRoute = route('/', DashboardScreen);
const agentsRoute = route('/agents', AgentsScreen);
const inboxRoute = route('/inbox', InboxScreen);
const integrationsRoute = route('/integrations', IntegrationsScreen);
const statsRoute = route('/stats', StatisticsScreen);
const auditRoute = route('/audit', AuditScreen);
const settingsRoute = route('/settings', SettingsScreen);

const boardRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$key',
  component: function Board() {
    const { key } = boardRoute.useParams();
    return <BoardScreen projectKey={key} />;
  },
});

const projectTaskRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$key/tasks/$taskId',
  component: function ProjectTask() {
    const { taskId } = projectTaskRoute.useParams();
    return <TaskDetailScreen taskId={taskId} />;
  },
});

/** Entered from the inbox and the agents view, which know a task id and no project key. */
const taskRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/tasks/$taskId',
  component: function Task() {
    const { taskId } = taskRoute.useParams();
    return <TaskDetailScreen taskId={taskId} />;
  },
});

const knowledgeRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$key/knowledge',
  component: function Knowledge() {
    const { key } = knowledgeRoute.useParams();
    return <KnowledgeScreen projectKey={key} />;
  },
});

const pipelineRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$key/pipeline',
  component: function Pipeline() {
    const { key } = pipelineRoute.useParams();
    return <PipelineScreen projectKey={key} />;
  },
});

const budgetsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$key/budgets',
  component: function Budgets() {
    const { key } = budgetsRoute.useParams();
    return <BudgetsScreen projectKey={key} />;
  },
});

const runRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/runs/$runId',
  component: lazyRouteComponent(() => import('./run-route.js'), 'RunRoute'),
});

export const routeTree = rootRoute.addChildren([
  signInRoute,
  authenticatedRoute.addChildren([
    dashboardRoute,
    agentsRoute,
    inboxRoute,
    integrationsRoute,
    statsRoute,
    auditRoute,
    settingsRoute,
    boardRoute,
    projectTaskRoute,
    taskRoute,
    knowledgeRoute,
    pipelineRoute,
    budgetsRoute,
    runRoute,
  ]),
]);

export const runRouteId = runRoute.id;

/**
 * What a route renders when its component throws (`ui/error-boundary.tsx` has the measurement).
 *
 * Supplying this is not cosmetic: the router installs a catch boundary **per match only when that
 * match has an error component**, so without it the nearest boundary is the root's and a screen
 * that throws replaces the header and the navigation as well. With it the failure is contained
 * inside `<main>`. `reset` is the router's own — it re-runs the match rather than only clearing
 * React state.
 */
const RouteErrorFallback = ({
  error,
  reset,
}: {
  readonly error: unknown;
  readonly reset: () => void;
}): ReactElement => <ErrorFallback area="screen" error={error} onRetry={reset} />;

export const createAppRouter = (
  context: RouterContext,
  history?: Parameters<typeof createRouter>[0]['history'],
) =>
  createRouter({
    routeTree,
    context,
    defaultPreload: false,
    defaultErrorComponent: RouteErrorFallback,
    ...(history === undefined ? {} : { history }),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
