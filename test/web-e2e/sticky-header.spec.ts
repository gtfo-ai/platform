/**
 * The sticky frame (S-23.18, owner feedback 2026-11-05: "the menu … could be sticky"): the top bar
 * and the row under it — the organisation's UnderlineNav, or inside a project its tab row — stay at
 * the top while the page scrolls; a phone keeps only the top bar. Measured on the drawn boxes, never
 * on a class name: each case first proves the page really scrolled (a frame that never left the
 * top proves nothing), then asks `elementFromPoint` who is on top, which is what a reader sees.
 *
 * The heights the frame declares (`--app-*-height` in `apps/web/src/styles.css`) are held to the
 * rows the browser drew, because a full-height pane and `scroll-padding-top` both subtract them.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';
import { IDS, PROJECT_KEY } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

/** Short, so every screen of the fixture scrolls. */
const LAPTOP = { width: 1024, height: 420 };
const PHONE = { width: 390, height: 844 };

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

interface Box {
  readonly top: number;
  readonly bottom: number;
}

const boxOf = async (locator: Locator): Promise<Box> =>
  await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });

/** Scrolls the document to its end and returns how far it went. */
const scrollToEnd = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return window.scrollY;
  });

/** Whether the element on top at the locator's centre is the locator's element or inside it. */
const onTop = async (locator: Locator): Promise<boolean> =>
  await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
  });

/** The frame's declared height in px (`--app-sticky-height`), as the page resolves it. */
const declaredStickyHeight = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.setProperty('height', 'var(--app-sticky-height)');
    document.body.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  });

/** Asserts the two rows sit stacked at the very top, and returns the frame's bottom edge. */
const expectStuck = async (page: Page, secondRow: Locator): Promise<number> => {
  const header = await boxOf(page.getByRole('banner'));
  const row = await boxOf(secondRow);
  expect(header.top).toBe(0);
  expect(Math.abs(row.top - header.bottom)).toBeLessThanOrEqual(0.5);
  expect(await onTop(page.getByRole('banner'))).toBe(true);
  expect(await onTop(secondRow)).toBe(true);
  // The declared height is the drawn one: the panes and the scroll padding subtract it.
  expect(Math.abs((await declaredStickyHeight(page)) - row.bottom)).toBeLessThanOrEqual(0.5);
  return row.bottom;
};

test.describe('on a laptop the top bar and the row under it stick', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(LAPTOP);
  });

  test('Home: both rows stay in view, and `k` never lands a row under them', async ({ page }) => {
    await page.goto('/');
    const needsYou = page.getByRole('list', { name: 'Needs you' });
    await expect(needsYou).toBeVisible();
    expect(await scrollToEnd(page)).toBeGreaterThan(200);
    const frameBottom = await expectStuck(page, page.getByRole('navigation', { name: 'Primary' }));

    // `j`/`k`: the focus is on the second row; the first is put fully inside the viewport but
    // under the frame — "already visible" to a browser that ignores the frame — and `k` moves to it.
    const rows = page.locator('[data-list-box]').first().locator(':scope > li');
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    const first = rows.nth(0).locator('a, button').first();
    await rows.nth(1).locator('a, button').first().focus();
    const placed = await first.evaluate((element) => {
      window.scrollBy(0, element.getBoundingClientRect().top - 8);
      return element.getBoundingClientRect().top;
    });
    // Calibration: the target really is under the frame before the key is pressed.
    expect(placed).toBeLessThan(frameBottom - 8);
    expect(await onTop(first)).toBe(false);
    await page.keyboard.press('k');
    await expect(first).toBeFocused();
    expect((await boxOf(first)).top).toBeGreaterThanOrEqual(frameBottom);
    expect(await onTop(first)).toBe(true);
  });

  test('a board: the project’s tabs stick under the top bar, its title scrolls away, and the start dialog and a menu overlay the frame', async ({
    page,
  }) => {
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByRole('article', { name: 'DEMO-1' })).toBeVisible();
    expect(await scrollToEnd(page)).toBeGreaterThan(0);
    const tabs = page.locator('[data-project-tabs]');
    const frameBottom = await expectStuck(page, tabs);
    await expect(tabs.getByRole('navigation', { name: 'Project' })).toBeVisible();
    // The project's title is not part of the frame: it has gone up behind it.
    // Scrolled behind the top bar: the title band ends at or above the banner's bottom edge.
    expect((await boxOf(page.locator('[data-project-frame]'))).bottom).toBeLessThanOrEqual(
      (await boxOf(page.getByRole('banner'))).bottom + 0.5,
    );
    expect(frameBottom).toBeGreaterThan(0);

    // A menu opened from the top bar draws over the tab row.
    await page
      .getByRole('banner')
      .getByRole('button', { name: /create/i })
      .click();
    const startItem = page.getByRole('menuitem', { name: /^Start a ticket/ });
    await expect(startItem).toBeVisible();
    expect((await boxOf(startItem)).top).toBeLessThan(frameBottom);
    expect(await onTop(startItem)).toBe(true);

    // `#start-ticket`: the dialog's field takes the focus and nothing of the frame covers it.
    await startItem.click();
    const dialog = page.getByRole('dialog', { name: 'Start a ticket' });
    await expect(dialog).toBeVisible();
    const field = dialog.getByRole('textbox').first();
    await expect(field).toBeFocused();
    expect(await onTop(field)).toBe(true);
    expect(await onTop(page.getByRole('banner'))).toBe(false);
  });

  test('a run: the frame stays, and scrolled to the log the whole pane and the steer box are in view below it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/runs/${IDS.run}`);
    await expect(page.getByText('Reading the retry helper.')).toBeVisible();
    // Scrolled to the log the way an anchor would: `scroll-padding-top` stops it below the frame.
    const scroller = page.getByTestId('transcript-scroller');
    await scroller.evaluate((element) => {
      element.scrollIntoView({ block: 'start' });
    });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const frameBottom = await expectStuck(page, page.getByRole('navigation', { name: 'Primary' }));
    const pane = await boxOf(scroller);
    const steer = await boxOf(page.getByLabel('Steer the agent'));
    expect(pane.top).toBeGreaterThanOrEqual(frameBottom);
    expect(pane.bottom).toBeLessThanOrEqual(720);
    expect(steer.bottom).toBeLessThanOrEqual(720);
  });
});

test('a task’s flow canvas scrolls under the frame, and its full screen covers the frame', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/tasks/${IDS.taskFeature}`);
  const canvas = page.getByTestId('flow-canvas-frame').first();
  await expect(canvas).toBeVisible();
  const header = page.getByRole('banner');
  const primary = page.getByRole('navigation', { name: 'Primary' });
  // The canvas is put under the frame: the frame is what is drawn there.
  await canvas.evaluate((element) => {
    window.scrollBy(0, element.getBoundingClientRect().top - 20);
  });
  expect((await boxOf(canvas)).top).toBeLessThan((await boxOf(primary)).top);
  expect(await onTop(header)).toBe(true);
  expect(await onTop(primary)).toBe(true);
  // Full screen is above the frame (`z-30` over `z-20`), so nothing of it is hidden.
  await page.getByRole('button', { name: 'Full screen' }).first().click();
  const exit = page.getByRole('button', { name: 'Exit full screen' });
  await expect(exit).toBeVisible();
  expect(await onTop(exit)).toBe(true);
  expect(await onTop(header)).toBe(false);
});

test('on a phone only the top bar sticks; the navigation scrolls away with the page', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Needs you' })).toBeVisible();
  const primary = page.getByRole('navigation', { name: 'Primary' });
  const start = await boxOf(primary);
  expect(await scrollToEnd(page)).toBeGreaterThan(start.bottom);
  const header = await boxOf(page.getByRole('banner'));
  expect(header.top).toBe(0);
  expect(await onTop(page.getByRole('banner'))).toBe(true);
  expect((await boxOf(primary)).bottom).toBeLessThanOrEqual(header.bottom);
  expect(Math.abs((await declaredStickyHeight(page)) - header.bottom)).toBeLessThanOrEqual(0.5);
});
