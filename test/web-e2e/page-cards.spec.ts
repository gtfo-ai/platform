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
 * Each screen names what it waits for, so the scan reads a drawn page rather than a skeleton — the
 * wizard's steps past Connect are opened first (`POST /__test__/wizard-open`), and the step's "not
 * open yet" gate is asserted absent, so a step is read and not its gate. A read the fake does not
 * serve still draws its error notice, which is a tinted box and passes: such a panel is held only
 * as far as it draws. `nestedCards` is asserted on every screen too: no card holds another.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';
import { WIZARD_STEP_IDS } from '../../apps/web/src/features/onboarding-steps.js';
import { nestedCards, textOnTheCanvas } from './support/card-ground.js';
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
  /** The New project wizard past Connect: a git binding and a readiness evaluation are served. */
  readonly wizardOpen?: boolean;
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
    ready: (page) => page.locator('[data-trial-state="ready"]'),
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
  // Every step of the wizard, on the fixture's project with Connect and Technical discovery done
  // (`POST /__test__/wizard-open`), so each step draws itself rather than its "not open yet" gate.
  ...WIZARD_STEP_IDS.map(
    (step): Screen => ({
      name: `New project (${step})`,
      path: `/onboarding?project=${PROJECT_KEY}&step=${step}`,
      ready: (page) => page.locator(`[data-wizard-step="${step}"]`),
      wizardOpen: true,
    }),
  ),
  {
    name: 'New integration',
    path: '/integrations/new',
    ready: (page) => page.getByRole('radio').first(),
  },
];

for (const screen of SCREENS) {
  test(`${screen.name} draws its boxes on the card ground (${screen.path})`, async ({
    page,
    request,
  }) => {
    if (screen.wizardOpen === true) {
      expect((await request.post('/__test__/wizard-open')).ok()).toBe(true);
    }
    await page.goto(screen.path);
    await expect(screen.ready(page)).toBeVisible();
    if (screen.wizardOpen === true) {
      // The review of #87: the gate is a Blankslate too, and a scan of it held none of the step.
      await expect(
        page.locator('[data-blankslate]').filter({ hasText: 'is not open yet' }),
      ).toHaveCount(0);
    }
    const main = page.locator('main');
    expect(await textOnTheCanvas(main), screen.path).toEqual([]);
    expect(await nestedCards(main), screen.path).toEqual([]);
  });
}
