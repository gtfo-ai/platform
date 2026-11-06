/**
 * Whole-row click targets (S-23.26), in a real browser — the half happy-dom cannot hold, because it
 * lays nothing out (`apps/web/src/ui/row-link.test.tsx` holds the rest).
 *
 * The owner's report: on Home a row had to be hit on its title. The fix is GitHub's stretched link
 * (`ui/row-link.ts`, `styles.css`), so the assertions here are about **hit-testing**: a press with a
 * real mouse at the centre of a row's meta text — not the title — lands on the row's link and
 * navigates, and a nested control (a row's `···` menu) is lifted above the link and keeps its own
 * click without navigating. Every press is `page.mouse.click` at measured coordinates, never
 * `locator.click()`: Playwright's actionability check would refuse to click a span the link's
 * `::after` covers, which is the very thing being asserted.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';
import { IDS, PROJECT_KEY } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

/**
 * Brings `target` into the viewport and waits until it has stopped moving: nothing on the page is
 * still loading, and two reads of its box in a row agree. A coordinate press, unlike
 * `locator.click()`, neither scrolls nor re-aims — measured on PR #64's CI: Home's Projects box sits
 * below the fold at 1280 × 720, so the press at its measured centre reached nothing
 * (`elementFromPoint` answered `null`).
 */
const settle = async (page: Page, target: Locator): Promise<void> => {
  await expect(page.locator('[data-skeleton-bar]')).toHaveCount(0);
  await target.scrollIntoViewIfNeeded();
  let previous = '';
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await target.boundingBox());
        const still = box === previous && box !== 'null';
        previous = box;
        return still;
      },
      { message: 'the target never stopped moving' },
    )
    .toBe(true);
};

/** Presses the mouse at the centre of `target`, wherever the browser's hit-testing sends it. */
const pressAtCentre = async (page: Page, target: Locator): Promise<void> => {
  await settle(page, target);
  const box = await target.boundingBox();
  if (box === null) {
    throw new Error('the target has no box: it is not rendered');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** What the browser says is under the centre of `target` — the element a press there reaches. */
const hitAtCentre = async (page: Page, target: Locator): Promise<string> => {
  await settle(page, target);
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === null
      ? 'nothing'
      : `${hit.tagName.toLowerCase()} ${hit.getAttribute('href') ?? ''}`;
  });
};

test('Home: a press on a Running now row’s meta line opens the run', async ({ page }) => {
  const row = page
    .getByRole('list', { name: 'Running now' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: 'Implementation · Developer' }) });
  const meta = row.locator('[data-row-meta]');
  // Calibration: the meta line is under the run's link, not a target of its own.
  expect(await hitAtCentre(page, meta)).toBe(`a /runs/${IDS.run}`);
  await pressAtCentre(page, meta);
  await expect(page).toHaveURL(`/runs/${IDS.run}`);
});

test('Home: a press on a Needs you row’s meta line opens the task, and so does its action', async ({
  page,
}) => {
  const needs = page.getByRole('list', { name: 'Needs you' });
  const question = needs
    .getByRole('listitem')
    .filter({ hasText: 'Should the retry budget be 3 or 5?' });
  // The title is text and the row's one link is its action, which opens the task — never a
  // command: a row press performs nothing.
  await expect(question.getByRole('link', { name: /^Answer/ })).toHaveAttribute(
    'href',
    `/tasks/${IDS.taskFeature}`,
  );
  await pressAtCentre(page, question.locator('[data-row-meta]'));
  await expect(page).toHaveURL(`/tasks/${IDS.taskFeature}`);

  await page.goBack();
  const approval = page
    .getByRole('list', { name: 'Needs you' })
    .getByRole('listitem')
    .filter({ hasText: 'Plan approval is waiting for you' });
  // The title text, which is not a link of its own, is covered by the row's.
  await pressAtCentre(page, approval.getByText('Plan approval is waiting for you'));
  await expect(page).toHaveURL(`/tasks/${IDS.taskFeature}`);

  await page.goBack();
  await pressAtCentre(
    page,
    page
      .getByRole('list', { name: 'Needs you' })
      .getByRole('listitem')
      .filter({ hasText: 'Plan approval is waiting for you' })
      .getByRole('link', { name: /^Approve/ }),
  );
  await expect(page).toHaveURL(`/tasks/${IDS.taskFeature}`);
});

test('Home: a press on a project’s counts opens the project', async ({ page }) => {
  const row = page
    .getByRole('list', { name: 'Projects' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: /Demo service/ }) });
  const counts = row.locator('[data-row-trailing]');
  // Calibration: the counts are under the project's link, not a target of their own.
  expect(await hitAtCentre(page, counts)).toBe(`a /projects/${PROJECT_KEY}`);
  await pressAtCentre(page, counts);
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}`);
});

test('a row’s menu keeps its own click above the row link, and the row still opens', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}?view=list`);
  const row = page.locator(`[data-board-row="${IDS.taskFeature}"]`);
  const menu = row.getByRole('button', { name: 'Actions for DEMO-1' });
  // The menu is lifted: the browser sends a press there to the button, not to the row's link.
  expect(await hitAtCentre(page, menu)).toMatch(/^(button|svg|path) /);
  await pressAtCentre(page, menu);
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}?view=list`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // The ticket key under the title is not a link; a press on it opens the task.
  await pressAtCentre(page, row.getByText('DEMO-1', { exact: true }).first());
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
});

test('the integrations list: the row menu opens in place, a press on the meta opens the detail', async ({
  page,
}) => {
  await page.goto('/integrations');
  const menu = page.getByRole('button', { name: 'Actions for Jira (fake)' });
  await pressAtCentre(page, menu);
  await expect(page.getByRole('menuitem', { name: 'Test connection' })).toBeVisible();
  await expect(page).toHaveURL('/integrations');
  await page.keyboard.press('Escape');

  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: 'Jira (fake)' }) });
  const href = await row.getByRole('link', { name: 'Jira (fake)' }).getAttribute('href');
  expect(href).toMatch(/^\/integrations\//);
  // The meta's first line (provider, type, health) — its problems' buttons, if any, sit below it.
  await pressAtCentre(page, row.locator('[data-row-meta] > span > span').first());
  await expect(page).toHaveURL(href ?? '');
});

test('a row whose title is a button opens what the button opens: the Agents list and the inbox', async ({
  page,
}) => {
  await page.goto('/agents?view=list');
  const run = page
    .getByRole('list', { name: 'Runs' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: /^demo_service · DEMO-1/ }) });
  await pressAtCentre(page, run.locator('[data-row-meta] > span > span').first());
  await expect(page.getByRole('dialog', { name: 'DEMO-1 · Implementation' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/inbox');
  const question = page.locator(`[data-inbox-question="${IDS.question}"]`);
  await expect(question).toHaveAttribute('aria-expanded', 'false');
  const row = page.getByRole('listitem').filter({ has: question });
  await pressAtCentre(page, row.locator('[data-row-meta]'));
  await expect(question).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Your answer')).toBeVisible();
  // Nothing was sent: the row opened the form, it did not answer.
  await expect(page).toHaveURL('/inbox');
});
