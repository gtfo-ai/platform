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
 * **Every screen is a lazy chunk** (S-23.4) except the frame — the shell, the project layout — the
 * sign-in page and Home, which are what a first paint needs. TD-013 puts the bundle budget on the
 * initial graph (`scripts/bundle-budget.mjs` measures exactly it), and a user on Home has opened none
 * of the others. A screen is `lazyRouteComponent` over its own module, so the router **preloads**
 * the chunk while it resolves the match (the previous screen stays up meanwhile) and shows
 * `defaultPendingComponent` — a skeleton — only if that takes longer than the router's pending
 * delay. A screen that needs a route parameter is a small wrapper here that reads it and renders the
 * lazy screen; `withPreload` hands the router the inner chunk's `preload`, so the wrapper is
 * preloaded exactly as a bare lazy screen is. The chunks are served from `'self'` like the entry,
 * so the CSP is unchanged (`test/web-e2e/csp.spec.ts` loads them under it).
 *
 * **`/projects/$key` is a layout** (`app/project-frame.tsx`): the project header and tabs, with the
 * board as its index child and every project page — the task route included — as a child. No URL
 * changed. A child says which tab it is, whether it takes the full width and whether it has its own
 * `<h1>` through `staticData`, which the frame reads off the matches. */

import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouteComponent,
  redirect,
} from '@tanstack/react-router';
import type { ReactElement } from 'react';
import * as z from 'zod';
import { queryKeys } from '../api/keys.js';
import { ProjectFrame, type ProjectTab } from '../app/project-frame.js';
import type { Services } from '../app/services.js';
import { AppShell } from '../app/shell.js';
import { DashboardScreen } from '../features/dashboard.js';
import { WIZARD_STEP_IDS } from '../features/onboarding-steps.js';
import { SignInScreen } from '../features/sign-in.js';
import { ErrorFallback } from '../ui/error-boundary.js';
import { Skeleton } from '../ui/skeleton.js';

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

/** A wrapper that renders a lazy screen with a parameter, preloaded as the screen itself is. */
const withPreload = <TComponent extends () => ReactElement>(
  component: TComponent,
  screen: { readonly preload?: (() => Promise<void> | undefined) | undefined },
): TComponent & { preload: () => Promise<void> } =>
  Object.assign(component, {
    preload: async (): Promise<void> => {
      await screen.preload?.();
    },
  });

const route = <TPath extends string>(path: TPath, component: RouteComponent) =>
  createRoute({ getParentRoute: () => authenticatedRoute, path, component });

const dashboardRoute = route('/', DashboardScreen);
const projectsRoute = route(
  '/projects',
  lazyRouteComponent(() => import('../features/projects.js'), 'ProjectsScreen'),
);
const agentsRoute = route(
  '/agents',
  lazyRouteComponent(() => import('../features/agents.js'), 'AgentsScreen'),
);
const inboxRoute = route(
  '/inbox',
  lazyRouteComponent(() => import('../features/inbox.js'), 'InboxScreen'),
);
const integrationsRoute = route(
  '/integrations',
  lazyRouteComponent(() => import('../features/integrations.js'), 'IntegrationsScreen'),
);
// S-23.11a: one integration's page (its tabs a search parameter) and the add-integration wizard
// (its step one). `new` is a static segment, which the router ranks above the `$integrationId` one.
const IntegrationDetailScreen = lazyRouteComponent(
  () => import('../features/integration-detail.js'),
  'IntegrationDetailScreen',
);
const IntegrationWizardScreen = lazyRouteComponent(
  () => import('../features/integration-wizard.js'),
  'IntegrationWizardScreen',
);
/** `.catch`: an unknown tab or step is the first one, never a router error. */
const integrationSearchSchema = z.object({
  tab: z.enum(['setup-guide', 'refused-deliveries']).optional().catch(undefined),
});
const integrationWizardSearchSchema = z.object({
  step: z.enum(['configuration', 'credentials', 'test']).optional().catch(undefined),
});
const integrationWizardRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/integrations/new',
  validateSearch: integrationWizardSearchSchema,
  component: withPreload(function IntegrationWizard() {
    const { step } = integrationWizardRoute.useSearch();
    return <IntegrationWizardScreen step={step} />;
  }, IntegrationWizardScreen),
});
const integrationRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/integrations/$integrationId',
  validateSearch: integrationSearchSchema,
  component: withPreload(function Integration() {
    const { integrationId } = integrationRoute.useParams();
    const { tab } = integrationRoute.useSearch();
    return <IntegrationDetailScreen integrationId={integrationId} tab={tab ?? 'overview'} />;
  }, IntegrationDetailScreen),
});
const statsRoute = route(
  '/stats',
  lazyRouteComponent(() => import('../features/statistics.js'), 'StatisticsScreen'),
);
const auditRoute = route(
  '/audit',
  lazyRouteComponent(() => import('../features/audit.js'), 'AuditScreen'),
);
const settingsRoute = route(
  '/settings',
  lazyRouteComponent(() => import('../features/settings.js'), 'SettingsScreen'),
);
// WP-280: the registered machines, and the device flow's `verification_uri`.
const workersRoute = route(
  '/workers',
  lazyRouteComponent(() => import('../features/workers.js'), 'WorkersScreen'),
);
const workerApproveRoute = route(
  '/workers/approve',
  lazyRouteComponent(() => import('../features/workers.js'), 'WorkerApproveScreen'),
);

const BoardScreen = lazyRouteComponent(() => import('../features/board.js'), 'BoardScreen');
const TaskDetailScreen = lazyRouteComponent(
  () => import('../features/task-detail.js'),
  'TaskDetailScreen',
);
const KnowledgeScreen = lazyRouteComponent(
  () => import('../features/project-panels.js'),
  'KnowledgeScreen',
);
const PipelineScreen = lazyRouteComponent(
  () => import('../features/project-panels.js'),
  'PipelineScreen',
);
const BudgetsScreen = lazyRouteComponent(
  () => import('../features/project-panels.js'),
  'BudgetsScreen',
);
const ShadowScreen = lazyRouteComponent(() => import('../features/shadow.js'), 'ShadowScreen');
const ProjectSettingsScreen = lazyRouteComponent(
  () => import('../features/project-settings.js'),
  'ProjectSettingsScreen',
);

const OnboardingScreen = lazyRouteComponent(
  () => import('../features/onboarding.js'),
  'OnboardingScreen',
);

/**
 * `?project=<key>&step=<id>` — the New project wizard's project and step (S-23.8, TD-033 decision 9).
 *
 * Search parameters, not component state, for `?artifact=`'s reason: they make a step
 * **addressable**, which is what lets *Save and exit* and Home's setup checklist resume exactly where
 * somebody left off. A `step` that is not one of the wizard's is dropped rather than refused (the
 * wizard then resumes at the first step not done), so a stale link is a no-op, not a router error;
 * `project` is compared with the keys the projects list returned and an unknown one says so.
 */
const onboardingSearchSchema = z.object({
  project: z.string().optional(),
  step: z.enum(WIZARD_STEP_IDS).optional().catch(undefined),
});

const onboardingRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/onboarding',
  validateSearch: onboardingSearchSchema,
  component: withPreload(function Onboarding() {
    const search = onboardingRoute.useSearch();
    return <OnboardingScreen projectKey={search.project ?? null} step={search.step ?? null} />;
  }, OnboardingScreen),
});

/** The project's layout: its header and tabs around every page below (`app/project-frame.tsx`). */
const projectRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$key',
  component: function Project() {
    const { key } = projectRoute.useParams();
    return <ProjectFrame projectKey={key} />;
  },
});

/** A page of the project: its tab, and whether it takes the full width or has its own `<h1>`. */
const projectPage = <TPath extends string>(
  path: TPath,
  tab: ProjectTab,
  component: RouteComponent,
) => createRoute({ getParentRoute: () => projectRoute, path, staticData: { tab }, component });

/**
 * `?view=list` — the board's Issues-style list (S-23.9a); anything else, or nothing, is the board.
 * A value outside the two is caught to `undefined` rather than a router error: it reaches no
 * attribute, and the screen reads it as the board.
 */
const boardSearchSchema = z.object({ view: z.enum(['board', 'list']).optional().catch(undefined) });

/** The board is the project's index: `/projects/$key` itself. Full width, as GitHub's project board. */
const boardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  validateSearch: boardSearchSchema,
  staticData: { tab: 'board', fullWidth: true },
  component: withPreload(function Board() {
    const { key } = boardRoute.useParams();
    return <BoardScreen projectKey={key} />;
  }, BoardScreen),
});

/**
 * `?artifact=<id>` — which artifact's body the task screen has open (WP-52).
 *
 * It is a **search parameter and not component state** because it is what makes an artifact
 * *addressable*: the ask thread's `artifact` citation is a link that sets it, and a reader can send
 * somebody the URL. Both task routes declare it, so `<Link to="." search={…}>` works from either
 * without the component having to know which one it is on.
 *
 * `z.string()` rather than `z.uuid()`: the value is compared against the ids the task's own
 * projection returned and an unknown one shows nothing, so a bad id is a no-op rather than a router
 * error — and the value never reaches an attribute (`apps/web/src/no-html.test.ts`).
 */
const taskSearchSchema = z.object({ artifact: z.string().optional() });

/** A task in its project: the Board's tab, under the project's header, with its own `<h1>`. */
const projectTaskRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'tasks/$taskId',
  validateSearch: taskSearchSchema,
  staticData: { tab: 'board', ownsHeading: true },
  component: withPreload(function ProjectTask() {
    const { taskId } = projectTaskRoute.useParams();
    return <TaskDetailScreen taskId={taskId} />;
  }, TaskDetailScreen),
});

/** Entered from the inbox and the agents view, which know a task id and no project key. */
const taskRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/tasks/$taskId',
  validateSearch: taskSearchSchema,
  component: withPreload(function Task() {
    const { taskId } = taskRoute.useParams();
    return <TaskDetailScreen taskId={taskId} />;
  }, TaskDetailScreen),
});

const knowledgeRoute = projectPage(
  'knowledge',
  'knowledge',
  withPreload(function Knowledge() {
    const { key } = knowledgeRoute.useParams();
    return <KnowledgeScreen projectKey={key} />;
  }, KnowledgeScreen),
);

const pipelineRoute = projectPage(
  'pipeline',
  'pipeline',
  withPreload(function Pipeline() {
    const { key } = pipelineRoute.useParams();
    return <PipelineScreen projectKey={key} />;
  }, PipelineScreen),
);

/** product/10:20's Shadow screen (WP-34). */
const shadowRoute = projectPage(
  'shadow',
  'shadow',
  withPreload(function Shadow() {
    const { key } = shadowRoute.useParams();
    return <ShadowScreen projectKey={key} />;
  }, ShadowScreen),
);

const budgetsRoute = projectPage(
  'budgets',
  'budgets',
  withPreload(function Budgets() {
    const { key } = budgetsRoute.useParams();
    return <BudgetsScreen projectKey={key} />;
  }, BudgetsScreen),
);

/** product/10:21's project settings page — the mirror of every wizard step (product/18:55). */
const projectSettingsRoute = projectPage(
  'settings',
  'settings',
  withPreload(function ProjectSettings() {
    const { key } = projectSettingsRoute.useParams();
    return <ProjectSettingsScreen projectKey={key} />;
  }, ProjectSettingsScreen),
);

/** The run's log takes the full width, as an Actions job's does. */
const runRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/runs/$runId',
  staticData: { fullWidth: true },
  component: lazyRouteComponent(() => import('./run-route.js'), 'RunRoute'),
});

export const routeTree = rootRoute.addChildren([
  signInRoute,
  authenticatedRoute.addChildren([
    dashboardRoute,
    projectsRoute,
    agentsRoute,
    inboxRoute,
    integrationsRoute,
    integrationWizardRoute,
    integrationRoute,
    statsRoute,
    auditRoute,
    settingsRoute,
    onboardingRoute,
    workersRoute,
    workerApproveRoute,
    projectRoute.addChildren([
      boardRoute,
      projectTaskRoute,
      knowledgeRoute,
      pipelineRoute,
      budgetsRoute,
      shadowRoute,
      projectSettingsRoute,
    ]),
    taskRoute,
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

const RoutePending = (): ReactElement => <Skeleton label="Loading…" lines={4} />;

export const createAppRouter = (
  context: RouterContext,
  history?: Parameters<typeof createRouter>[0]['history'],
) =>
  createRouter({
    routeTree,
    context,
    defaultPreload: false,
    defaultErrorComponent: RouteErrorFallback,
    // What a lazy screen shows while its chunk loads, once the router's pending delay has passed.
    defaultPendingComponent: RoutePending,
    ...(history === undefined ? {} : { history }),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
  /** What a route tells the frame about itself (`app/shell.tsx`, `app/project-frame.tsx`). */
  interface StaticDataRouteOption {
    /** The project tab a page belongs to; a task's page is the Board's. */
    readonly tab?: ProjectTab;
    /** The board and a run's log take the page's width; everything else is centred at 1280 px. */
    readonly fullWidth?: boolean;
    /** The page has its own `<h1>`, so the project's name above it is not one. */
    readonly ownsHeading?: boolean;
  }
}
