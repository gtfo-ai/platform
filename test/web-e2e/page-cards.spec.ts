/**
 * **Every box on the platform sits on the card ground** — the screens outside Settings (S-25.10b,
 * backlog 1292; the owner: "many cards across the platform still use the same background colour as
 * the body").
 *
 * `settings-cards.spec.ts` holds every Settings page; this holds the rest the fixture backend
 * serves — a project's Knowledge, Pipeline, Budgets and Trial tabs, the task page's panels and
 * tabs, the run page, the three Agents views, the inbox, Statistics and the New project and New
 * integration wizards — to the same scan (`support/card-ground.ts`) over `<main>`: every visible
 * text node there must have an ancestor whose computed background is neither transparent nor the
 * canvas, except the chrome that scan lists (headings, prose, links and buttons on their own, the
 * page and project headers, navigation, steppers, toolbars, timelines and the canvases that paint
 * their own ground).
 *
 * Each screen names what it waits for, so the scan reads a drawn page rather than a skeleton. A read
 * the fake does not serve draws its error notice, which is a tinted box and passes: such a screen is
 * held only as far as it draws, which is stated here rather than implied.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';
import { WIZARD_STEP_IDS } from '../../apps/web/src/features/onboarding-steps.js';
import { textOnTheCanvas } from './support/card-ground.js';
import { IDS, PROJECT_KEY } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

interface Screen {
  readonly name: string;
  readonly path: string;
  readonly ready: (page: Page) => Locator;
}

const project = `/projects/${PROJECT_KEY}`;
const task = `/tasks/${IDS.taskFeature}`;

const SCREENS: readonly Screen[] = [
  {
    name: 'Knowledge',
    path: `${project}/knowledge`,
    ready: (page) => page.getByRole('navigation', { name: 'Knowledge files' }),
  },
  {
    name: 'Pipeline',
    path: `${project}/pipeline`,
    ready: (page) => page.locator('[data-flow-canvas="template"]'),
  },
  {
    name: 'Budgets',
    path: `${project}/budgets`,
    ready: (page) => page.getByRole('button', { name: 'Save budgets' }),
  },
  {
    name: 'Trial',
    path: `${project}/shadow`,
    ready: (page) => page.locator('[data-trial-state]').first(),
  },
  {
    name: 'a task (Overview)',
    path: task,
    ready: (page) => page.getByRole('complementary', { name: 'Checks and cost' }),
  },
  {
    name: 'a task (Runs)',
    path: `${task}?tab=runs`,
    ready: (page) => page.locator('main').getByRole('list', { name: 'Runs', exact: true }),
  },
  {
    name: 'a task (Activity)',
    path: `${task}?tab=activity`,
    ready: (page) => page.getByRole('heading', { name: 'Who did what' }).first(),
  },
  {
    name: 'a run',
    path: `/runs/${IDS.run}`,
    ready: (page) => page.locator('[data-run-summary]'),
  },
  {
    name: 'Agents (map)',
    path: '/agents?view=map',
    ready: (page) => page.getByTestId('fleet-canvas-frame'),
  },
  {
    name: 'Agents (office)',
    path: '/agents?view=office',
    ready: (page) => page.locator('[data-office]'),
  },
  {
    name: 'Agents (list)',
    path: '/agents?view=list',
    ready: (page) => page.locator('main').getByRole('list', { name: 'Runs', exact: true }),
  },
  {
    name: 'Inbox',
    path: '/inbox',
    ready: (page) =>
      page
        .locator('main')
        .getByText(/^Should the retry budget be 3 or 5\?/)
        .first(),
  },
  {
    name: 'Statistics',
    path: '/stats',
    ready: (page) => page.getByRole('heading', { level: 2, name: 'Throughput' }),
  },
  {
    name: 'New project (start)',
    path: '/onboarding',
    ready: (page) => page.locator('[data-wizard-step]'),
  },
  // Every step of the wizard, on the fixture's project (a step the wizard redirects is read where
  // it lands).
  ...WIZARD_STEP_IDS.map(
    (step): Screen => ({
      name: `New project (${step})`,
      path: `/onboarding?project=${PROJECT_KEY}&step=${step}`,
      ready: (page) => page.locator('[data-wizard-step]'),
    }),
  ),
  {
    name: 'New integration',
    path: '/integrations/new',
    ready: (page) => page.getByRole('radio').first(),
  },
];

for (const screen of SCREENS) {
  test(`${screen.name} draws its boxes on the card ground (${screen.path})`, async ({ page }) => {
    await page.goto(screen.path);
    await expect(screen.ready(page)).toBeVisible();
    expect(await textOnTheCanvas(page.locator('main')), screen.path).toEqual([]);
  });
}
