/**
 * The responsive pass (S-23.13a; research/19 § 8 P10): at a 1 024 × 768 laptop and a 390 × 844 phone
 * every screen is usable — the **page** never scrolls sideways (the board's columns and the canvases
 * scroll inside their own boxes, which is what they are for) — and on the phone the frame gives way:
 * the organisation's navigation folds into its *More* menu, the running pill keeps its count, page
 * actions wrap under the title, a NavList is a one-line disclosure, and the Agents map is the list.
 *
 * Measured, not eyeballed: `scrollWidth` against `clientWidth` of the document. The first version of
 * that measurement found the board widening the page by 267 px at 1 024 — not through any visible
 * box, but through the screen-reader-only counts of the columns scrolled out of view, whose
 * `position: absolute` resolved against the page rather than the scroller.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { IDS, PROJECT_KEY } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

test.use({ colorScheme: 'dark' });

const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1024, height: 768 };

/** Every screen of the accessibility pass, each with something drawn once its reads answered. */
const SCREENS: readonly { readonly path: string; readonly ready: (page: Page) => Promise<void> }[] =
  [
    { path: '/', ready: (page) => visible(page.getByRole('list', { name: 'Needs you' })) },
    { path: '/projects', ready: (page) => visible(page.getByRole('list', { name: 'Projects' })) },
    {
      path: `/projects/${PROJECT_KEY}`,
      ready: (page) => visible(page.getByRole('article', { name: 'DEMO-1' })),
    },
    {
      path: `/projects/${PROJECT_KEY}?view=list`,
      ready: (page) => visible(page.getByRole('list', { name: 'Tasks' })),
    },
    {
      path: `/projects/${PROJECT_KEY}/pipeline`,
      ready: (page) => visible(page.getByRole('combobox', { name: 'Template' })),
    },
    ...['overview', 'artifacts', 'runs', 'activity'].map((tab) => ({
      path: `/tasks/${IDS.taskFeature}?tab=${tab}`,
      ready: (page: Page) => visible(page.getByRole('heading', { level: 1 })),
    })),
    {
      path: `/runs/${IDS.run}`,
      ready: (page) => visible(page.getByText('Reading the retry helper.')),
    },
    ...['map', 'office', 'list'].map((view) => ({
      path: `/agents?view=${view}`,
      ready: (page: Page) => visible(page.locator('[data-fleet-counts]')),
    })),
    {
      path: '/inbox',
      ready: (page) => visible(page.getByText(/^Should the retry budget be 3 or 5\?/).first()),
    },
    {
      path: '/integrations',
      ready: (page) => visible(page.getByRole('heading', { level: 1, name: 'Integrations' })),
    },
    { path: '/integrations/new', ready: (page) => visible(page.getByRole('radio').first()) },
    {
      path: '/settings/users',
      ready: (page) => visible(page.getByText('operator@example.invalid').first()),
    },
    {
      path: `/projects/${PROJECT_KEY}/settings/connections`,
      ready: (page) => visible(page.getByRole('heading', { level: 2 }).first()),
    },
    { path: '/onboarding', ready: (page) => visible(page.getByRole('heading', { level: 1 })) },
  ];

async function visible(locator: ReturnType<Page['locator']>): Promise<void> {
  await expect(locator).toBeVisible();
}

/** How far the page itself scrolls sideways: 0 when nothing is wider than the viewport. */
const pageOverflow = async (page: Page): Promise<number> =>
  await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

const axe = async (page: Page): Promise<string[]> => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`),
  );
};

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

for (const size of [LAPTOP, PHONE]) {
  test(`no screen scrolls sideways at ${size.width} × ${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const wide: string[] = [];
    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await screen.ready(page);
      const overflow = await pageOverflow(page);
      if (overflow > 0) {
        wide.push(`${screen.path}: ${overflow} px`);
      }
    }
    expect(wide).toEqual([]);
  });
}

test('the board’s columns scroll inside their own box on a phone, not the page', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole('article', { name: 'DEMO-1' })).toBeVisible();
  const columns = page.locator('[data-board-columns]');
  // Calibration: the columns *are* wider than the phone — the page stays put only because they scroll.
  expect(await columns.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await pageOverflow(page)).toBe(0);
});

test.describe('on a 390 px phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test('Home: the org navigation folds into More and the running pill keeps its count', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('list', { name: 'Needs you' })).toBeVisible();
    const primary = page.getByRole('navigation', { name: 'Primary' });
    await expect(primary.getByRole('link', { name: 'Home' })).toBeVisible();
    // Agents and everything after it collapse below `sm`; the More menu holds them.
    await expect(primary.getByRole('link', { name: /^Agents/ })).toBeHidden();
    await primary.getByRole('button', { name: 'More navigation' }).click();
    await expect(page.getByRole('menuitem', { name: /^Agents/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Settings/ })).toBeVisible();
    await page.keyboard.press('Escape');
    // "3 running": the number is shown, the word is for a screen reader only.
    const running = page.getByRole('banner').getByRole('link', { name: /running/ });
    await expect(running).toHaveText(/^\d+ running$/);
    expect(await running.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(
      48,
    );
    expect(await pageOverflow(page)).toBe(0);
    expect(await axe(page)).toEqual([]);
  });

  test('a task: the title keeps its width and the header’s action wraps under it', async ({
    page,
  }) => {
    await page.goto(`/tasks/${IDS.taskFeature}`);
    const title = page.getByRole('heading', { level: 1 });
    await expect(title).toBeVisible();
    const actions = page.locator('[data-page-actions]').first();
    await expect(actions).toBeVisible();
    const [titleBox, actionsBox] = await Promise.all([title.boundingBox(), actions.boundingBox()]);
    expect(titleBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    if (titleBox !== null && actionsBox !== null) {
      // Wrapped: the actions sit below the title rather than squeezing it to a word per line.
      expect(actionsBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
      expect(titleBox.width).toBeGreaterThan(PHONE.width / 2);
    }
    expect(await pageOverflow(page)).toBe(0);
    expect(await axe(page)).toEqual([]);
  });

  test('a run: the job list is a one-line disclosure naming the run, and opens to every run', async ({
    page,
  }) => {
    await page.goto(`/runs/${IDS.run}`);
    await expect(page.getByText('Reading the retry helper.')).toBeVisible();
    const jobs = page.getByRole('navigation', { name: 'Runs of this task' });
    await expect(jobs).toHaveAttribute('data-nav-list', 'disclosure');
    const summary = jobs.locator('summary');
    await expect(summary).toHaveText('Runs of this task: Implementation');
    expect((await summary.boundingBox())?.height ?? 0).toBeLessThan(48);
    await expect(jobs.getByRole('link').first()).toBeHidden();
    await summary.click();
    await expect(jobs.getByRole('link').first()).toBeVisible();
    // The back link's ticket key never breaks across lines.
    const key = page.getByRole('link', { name: /^DEMO-1/ }).first();
    expect((await key.boundingBox())?.height ?? 99).toBeLessThan(28);
    expect(await pageOverflow(page)).toBe(0);
    expect(await axe(page)).toEqual([]);
  });

  test('Agents: the map is the list on a phone', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByText('The map needs a wider screen; here is the list.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Runs' })).toBeVisible();
    await expect(page.getByTestId('fleet-canvas-frame')).toHaveCount(0);
    expect(await pageOverflow(page)).toBe(0);
    expect(await axe(page)).toEqual([]);
  });
});

test('on a laptop the job list is the sidebar again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByText('Reading the retry helper.')).toBeVisible();
  const jobs = page.getByRole('navigation', { name: 'Runs of this task' });
  await expect(jobs.getByRole('link').first()).toBeVisible();
  await expect(jobs.locator('summary')).toHaveCount(0);
});
