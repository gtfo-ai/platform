/**
 * Accessibility, measured (S-23.13a; research/19 § 8 P10 and decision D4): axe-core runs over every
 * screen of the redesigned SPA in the built bundle, under the production policy, against the fake
 * backend's fixtures — hostile strings included — and the suite fails on a single violation of WCAG
 * 2.0 A and AA and 2.1 AA.
 *
 * **Dark only.** The product has one theme (TD-033 as amended by S-23.17, the owner's decision), so
 * every screen is measured in it; the browser is asked for a dark colour scheme so the reading does
 * not depend on whether the build still honours a light one.
 *
 * **Why a list of screens, not a crawl.** Each entry waits for something the screen draws only once
 * its reads have answered (`ready`), so axe never measures a skeleton and reports a clean page that
 * nobody sees. A screen added to the product is added here by name.
 *
 * **What axe cannot see**, stated rather than implied: it reads the DOM as it is at the moment it
 * runs, so a dialog, a menu or a tooltip is measured only where a case opens it (the stage dialog
 * and the account menu below); it judges colour contrast from computed styles, so text over an
 * image or a gradient is reported as "needs review", which this suite does not fail on; and it has no
 * opinion on whether the words are right. React Flow's wrapper carries `role="application"` on the
 * two canvases; axe raises nothing about it (measured), so nothing is excluded.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { IDS, PROJECT_KEY } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

test.use({ colorScheme: 'dark' });

/** The rule sets research/19's D4 names. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];

interface Screen {
  readonly name: string;
  readonly path: string;
  /** Something drawn only once the screen's reads have answered. */
  readonly ready: (page: Page) => Promise<void>;
  /** An interaction that opens what the screen hides by default (a dialog, a menu). */
  readonly open?: (page: Page) => Promise<void>;
}

const heading = (name: string | RegExp) => async (page: Page) => {
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
};

const SCREENS: readonly Screen[] = [
  {
    name: 'Home',
    path: '/',
    ready: async (page) => {
      await expect(page.getByRole('list', { name: 'Needs you' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Spend' })).toBeVisible();
    },
  },
  {
    name: 'Home with the account menu open',
    path: '/',
    ready: heading(/^Good (morning|afternoon|evening)/),
    open: async (page) => {
      await page.getByRole('button', { name: /account/i }).click();
      await expect(page.getByRole('menu')).toBeVisible();
    },
  },
  {
    name: 'Projects',
    path: '/projects',
    ready: async (page) => {
      await expect(page.getByRole('list', { name: 'Projects' })).toBeVisible();
    },
  },
  {
    name: 'a project board',
    path: `/projects/${PROJECT_KEY}`,
    ready: async (page) => {
      await expect(page.getByRole('article', { name: 'DEMO-1' })).toBeVisible();
    },
  },
  {
    name: 'a project board as a list',
    path: `/projects/${PROJECT_KEY}?view=list`,
    ready: async (page) => {
      await expect(page.getByRole('list', { name: 'Tasks' })).toBeVisible();
    },
  },
  {
    name: 'a project’s pipeline',
    path: `/projects/${PROJECT_KEY}/pipeline`,
    ready: async (page) => {
      await expect(page.locator('[data-flow-canvas="template"] [data-stage-card]')).toHaveCount(15);
    },
  },
  {
    name: 'a project’s pipeline with a stage dialog open',
    path: `/projects/${PROJECT_KEY}/pipeline`,
    ready: async (page) => {
      await expect(page.locator('[data-flow-canvas="template"] [data-stage-card]')).toHaveCount(15);
    },
    open: async (page) => {
      await page.locator('[data-flow-canvas="template"] [data-stage-card]').first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  ...(['overview', 'artifacts', 'runs', 'activity'] as const).map(
    (tab): Screen => ({
      name: `a task’s ${tab} tab`,
      path: `/tasks/${IDS.taskFeature}?tab=${tab}`,
      ready: async (page) => {
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(
          page.getByRole('navigation', { name: /task/i }).locator('a[aria-current="page"]'),
        ).toHaveAttribute(
          'href',
          new RegExp(tab === 'overview' ? `${IDS.taskFeature}$` : `tab=${tab}$`),
        );
      },
    }),
  ),
  {
    name: 'a run',
    path: `/runs/${IDS.run}`,
    ready: async (page) => {
      await expect(page.getByText('Reading the retry helper.')).toBeVisible();
    },
  },
  ...(['map', 'office', 'list'] as const).map(
    (view): Screen => ({
      name: `Agents (${view})`,
      path: `/agents?view=${view}`,
      ready: async (page) => {
        await heading('Agents')(page);
        await expect(
          view === 'map'
            ? page.getByTestId('fleet-canvas-frame').locator('.react-flow__node').first()
            : view === 'office'
              ? page.getByRole('region', { name: 'Office' })
              : page.getByRole('list', { name: 'Runs' }),
        ).toBeVisible();
      },
    }),
  ),
  {
    name: 'Inbox',
    path: '/inbox',
    ready: async (page) => {
      await expect(page.getByText(/^Should the retry budget be 3 or 5\?/).first()).toBeVisible();
    },
  },
  {
    name: 'Integrations',
    path: '/integrations',
    ready: async (page) => {
      await heading('Integrations')(page);
      await expect(page.getByRole('link', { name: /Jira/ }).first()).toBeVisible();
    },
  },
  {
    name: 'the add-integration wizard, step 1',
    path: '/integrations/new',
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('radio').first()).toBeVisible();
    },
  },
  {
    name: 'org settings (Users)',
    path: '/settings/users',
    ready: async (page) => {
      await expect(page.getByRole('navigation', { name: /settings/i })).toBeVisible();
      await expect(page.getByText('operator@example.invalid').first()).toBeVisible();
    },
  },
  {
    name: 'project settings (Connections)',
    path: `/projects/${PROJECT_KEY}/settings/connections`,
    ready: async (page) => {
      await expect(page.getByRole('navigation', { name: /settings/i })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    },
  },
  {
    name: 'the new-project wizard, step 1',
    path: '/onboarding',
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('list', { name: /steps/i })).toBeVisible();
    },
  },
];

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await heading(/^Good (morning|afternoon|evening)/)(page);
});

for (const screen of SCREENS) {
  test(`axe finds nothing on ${screen.name}`, async ({ page }) => {
    await page.goto(screen.path);
    await screen.ready(page);
    await screen.open?.(page);
    expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('dark');
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    // Named by rule, element and message, so a failure reads as the fix it needs.
    const found = results.violations.flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id}: ${node.target.join(' ')} — ${node.failureSummary ?? ''}`,
      ),
    );
    expect(found).toEqual([]);
    // Calibration (standing rule 21): axe ran the rule sets over this page rather than nothing.
    expect(results.passes.length).toBeGreaterThan(10);
  });
}
