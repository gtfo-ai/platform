/**
 * The built bundle runs under the Content-Security-Policy the server ships (WP-15j round 3).
 *
 * Round 2 shipped `frame-ancestors 'none'` alone and justified it with an inline theme script that
 * `apps/web/index.html` does not have. Round 3 measured the bundle and shipped the policy the
 * measurement allows (`apps/server/src/web/csp.ts`), which raises the question no unit test can
 * answer: **does the application still work under it?** A policy that blocks the product's only
 * screen is worse than no policy, and the only instrument that can tell is a browser.
 *
 * ## How this suite obtains that proof
 *
 * The Playwright harness serves the built bundle itself (`support/fake-backend.ts`), not through
 * `apps/server`'s fallback, so the header had to be added there — **imported** from the server's
 * own module rather than copied, because a fake that is kinder than the adapter proves nothing
 * (standing rule 1). Every spec in this directory therefore now drives the application under the
 * real policy; this file is the one that asserts it.
 *
 * Two halves, because either alone would be worthless:
 *
 *  1. **No violation while the application is used.** A listener registered before any page script
 *     collects `securitypolicyviolation` events through sign-in, a screen change and the
 *     lazily-imported route chunk; the suite fails on the first one, naming the directive.
 *  2. **The policy is actually being enforced** (standing rule 21: calibrate the instrument). An
 *     inline `<script>` and a `<style>` element are injected into the same page and must both be
 *     refused — without which "zero violations" would also be the reading for a browser that
 *     received no header at all.
 *
 * And two proofs TD-033 asked for before any screen depends on them: **Base UI opens under the
 * policy** — its menus and tooltips are positioned by Floating UI through CSSOM writes, which
 * `script-src 'self'` governs and `style-src 'self'` does not, so the top bar's account menu and a
 * `Metric` tooltip are opened in the built bundle and must appear, positioned, with no violation —
 * and **Inter is served by `'self'`**, so `font-src 'self'` stayed unchanged and the sign-in
 * headline is Inter Black.
 */
import { expect, type Page, test } from '@playwright/test';
import { IDS } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

interface CollectedViolation {
  readonly directive: string;
  readonly blocked: string;
  readonly sample: string;
  readonly source: string;
}

declare global {
  interface Window {
    __cspViolations?: CollectedViolation[];
  }
}

/** Registers the collector before the first byte of application script runs. */
const collectViolations = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const collected: CollectedViolation[] = [];
    window.__cspViolations = collected;
    document.addEventListener('securitypolicyviolation', (event) => {
      collected.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        sample: event.sample,
        source: `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
      });
    });
  });
};

const violations = async (page: Page): Promise<CollectedViolation[]> =>
  await page.evaluate(() => window.__cspViolations ?? []);

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await collectViolations(page);
});

test('the shell is served under the policy and the application runs without a violation', async ({
  page,
}) => {
  const response = await page.goto('/');
  // The two directives this proof is about. The exact serialisation is asserted where it is
  // produced (`apps/server/src/web/web-serving.test.ts`, `test/e2e/server/web-bundle.e2e.test.ts`);
  // a third copy here would be a third thing to drift.
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("style-src 'self'");
  expect(policy).not.toContain('unsafe-inline');

  // Sign in, land on a screen, then take a route whose chunk is imported dynamically: a policy
  // that allowed the entry module and nothing else would fail here rather than on the first paint.
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByText('Reading the retry helper.')).toBeVisible();

  // Tailwind's stylesheet is what makes the theme visible at all: a `style-src` that blocked it
  // would leave a readable but unstyled page, which no assertion above would notice.
  const styling = await page.evaluate(() => ({
    stylesheets: document.styleSheets.length,
    rules: [...document.styleSheets].reduce((total, sheet) => total + sheet.cssRules.length, 0),
    lazyChunks: performance
      .getEntriesByType('resource')
      .filter((entry) => /\/assets\/run-route-[^/]+\.js$/.test(entry.name)).length,
  }));
  expect(styling.stylesheets).toBeGreaterThan(0);
  expect(styling.rules).toBeGreaterThan(0);
  expect(styling.lazyChunks).toBeGreaterThan(0);

  expect(await violations(page)).toEqual([]);
});

test('the policy is enforced: an inline script and a <style> element are both refused', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Tickets in, merge requests out.' }),
  ).toBeVisible();

  const probe = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__cspProbeRan = true;';
    document.head.append(script);
    const style = document.createElement('style');
    style.textContent = ':root { --csp-probe: applied }';
    document.head.append(style);
    return getComputedStyle(document.documentElement).getPropertyValue('--csp-probe').trim();
  });
  // Neither probe took effect: the custom property the `<style>` would have defined is absent, and
  // the global the inline script would have set is undefined.
  expect(probe).toBe('');
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>)['__cspProbeRan']),
  ).toBeUndefined();

  // The events are queued as tasks, so they are polled rather than waited for on a clock
  // (standing rule 2).
  await expect
    .poll(async () => (await violations(page)).map((violation) => violation.directive).sort(), {
      message: 'the browser recorded no policy violation for either probe',
    })
    .toEqual([expect.stringMatching(/^script-src/), expect.stringMatching(/^style-src/)]);
});

test('Base UI opens a menu and a tooltip under the policy without a violation (TD-033)', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();

  // The account menu: a Base UI Menu, positioned by CSSOM writes.
  const trigger = page.getByRole('button', { name: 'Account menu' });
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Positioned against its trigger rather than left at the top of the document: the CSSOM write
  // took effect, which is what the policy question was.
  const [menuBox, triggerBox] = await Promise.all([menu.boundingBox(), trigger.boundingBox()]);
  expect(menuBox).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  if (menuBox !== null && triggerBox !== null) {
    expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 1);
    expect(Math.abs(menuBox.x + menuBox.width - (triggerBox.x + triggerBox.width))).toBeLessThan(
      40,
    );
  }
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // A Metric's definition: a Base UI Tooltip, opened from the keyboard.
  await page.goto('/stats');
  const label = page.getByText('Tasks delivered', { exact: true });
  await expect(label).toBeVisible();
  await label.focus();
  const tooltip = page.locator('[data-tooltip]');
  await expect(tooltip).toBeVisible();
  // The fixture's definition of `tasks_delivered` (`support/fixtures.ts`).
  await expect(tooltip).toHaveText(
    'Tasks whose merge request merged, counted at merge time (product/19 §10).',
  );
  const [tipBox, labelBox] = await Promise.all([tooltip.boundingBox(), label.boundingBox()]);
  if (tipBox !== null && labelBox !== null) {
    expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(labelBox.y + 1);
  }

  expect(await violations(page)).toEqual([]);
});

test('Inter is served from this origin and the sign-in headline is Inter Black (TD-033)', async ({
  page,
}) => {
  await page.goto('/');
  const headline = page.getByRole('heading', { name: 'Tickets in, merge requests out.' });
  await expect(headline).toBeVisible();
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    const heading = document.querySelector('h1');
    const style = heading === null ? null : getComputedStyle(heading);
    return {
      family: style?.fontFamily ?? '',
      weight: style?.fontWeight ?? '',
      black: document.fonts.check('900 16px "Inter Variable"'),
      loaded: [...document.fonts].filter(
        (face) => face.family.replaceAll('"', '') === 'Inter Variable' && face.status === 'loaded',
      ).length,
      files: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.endsWith('.woff2')),
    };
  });
  expect(font.family).toMatch(/^"?Inter Variable"?,/);
  expect(font.weight).toBe('900');
  expect(font.black).toBe(true);
  expect(font.loaded).toBeGreaterThan(0);
  expect(font.files.length).toBeGreaterThan(0);
  for (const file of font.files) {
    expect(new URL(file).origin).toBe(new URL(page.url()).origin);
  }
  expect(await violations(page)).toEqual([]);
});
